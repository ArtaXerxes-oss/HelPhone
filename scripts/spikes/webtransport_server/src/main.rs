//! Spike #603: alert-push test server and measuring client.
//!
//! PROTOTYPE: to be discarded once ADR-003 is accepted.
//!
//! WebTransport over HTTP/3 (quinn, via the `wtransport` crate), plus a plain
//! TCP push path with the same framing to stand in for WebSocket-over-TCP when
//! the link is impaired with `tc netem`. Driven by scripts/spikes/quic_stress_test.js.
//!
//!   wt-spike server --wt-port 4433 --tcp-port 4434
//!   wt-spike client --url 'https://127.0.0.1:4433/alerts?n=500&interval_ms=50&size=1024&mode=multi'
//!   wt-spike client --tcp 127.0.0.1:4434 --n 500 --interval-ms 50 --size 1024
//!
//! Alert frame: u32 BE total_len | u32 BE seq | u64 BE sent_at_unix_us | padding.
//! mode=multi sends each alert on its own unidirectional stream (no cross-alert
//! head-of-line blocking); mode=single sends all alerts on one ordered stream,
//! which reproduces TCP/WebSocket head-of-line behaviour on the same QUIC stack.
//! The client prints one JSON line with per-alert delivery latency.

use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use wtransport::endpoint::IncomingSession;
use wtransport::{ClientConfig, Connection, Endpoint, Identity, ServerConfig};

const HEADER: usize = 16;

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64
}

fn frame(seq: u32, size: usize) -> Vec<u8> {
    let len = size.max(HEADER);
    let mut f = vec![0u8; len];
    f[0..4].copy_from_slice(&(len as u32).to_be_bytes());
    f[4..8].copy_from_slice(&seq.to_be_bytes());
    f[8..16].copy_from_slice(&now_us().to_be_bytes());
    f
}

/// Incremental frame parser: feeds bytes, yields (seq, latency_ms) per complete frame.
#[derive(Default)]
struct Parser {
    buf: Vec<u8>,
}

impl Parser {
    fn feed(&mut self, bytes: &[u8], out: &mut Vec<(u32, f64)>) {
        self.buf.extend_from_slice(bytes);
        loop {
            if self.buf.len() < 4 {
                return;
            }
            let len = u32::from_be_bytes(self.buf[0..4].try_into().unwrap()) as usize;
            if len < HEADER || self.buf.len() < len {
                return;
            }
            let seq = u32::from_be_bytes(self.buf[4..8].try_into().unwrap());
            let sent = u64::from_be_bytes(self.buf[8..16].try_into().unwrap());
            out.push((seq, now_us().saturating_sub(sent) as f64 / 1000.0));
            self.buf.drain(..len);
        }
    }
}

struct Params {
    n: u32,
    interval_ms: u64,
    size: usize,
    multi: bool,
}

fn parse_query(path: &str) -> Params {
    let q: HashMap<&str, &str> = path
        .split_once('?')
        .map(|(_, q)| q.split('&').filter_map(|kv| kv.split_once('=')).collect())
        .unwrap_or_default();
    Params {
        n: q.get("n").and_then(|v| v.parse().ok()).unwrap_or(500),
        interval_ms: q.get("interval_ms").and_then(|v| v.parse().ok()).unwrap_or(50),
        size: q.get("size").and_then(|v| v.parse().ok()).unwrap_or(1024),
        multi: q.get("mode").map_or(true, |m| *m != "single"),
    }
}

// ── server ────────────────────────────────────────────────────────────────────

async fn serve_wt_session(incoming: IncomingSession) -> Result<()> {
    let request = incoming.await?;
    let p = parse_query(request.path());
    let conn = request.accept().await?;
    let mut tick = tokio::time::interval(Duration::from_millis(p.interval_ms));
    if p.multi {
        let mut tasks = Vec::new();
        for seq in 0..p.n {
            tick.tick().await;
            let conn = conn.clone();
            let f = frame(seq, p.size);
            // Own task per alert: a stream waiting on loss recovery must not
            // delay opening the next one.
            tasks.push(tokio::spawn(async move {
                let mut s = conn.open_uni().await?.await?;
                s.write_all(&f).await?;
                s.finish().await?;
                anyhow::Ok(())
            }));
        }
        for t in tasks {
            t.await??;
        }
    } else {
        let mut s = conn.open_uni().await?.await?;
        for seq in 0..p.n {
            tick.tick().await;
            s.write_all(&frame(seq, p.size)).await?;
        }
        s.finish().await?;
    }
    conn.closed().await;
    Ok(())
}

async fn serve_tcp(mut sock: TcpStream) -> Result<()> {
    sock.set_nodelay(true)?;
    let mut line = String::new();
    BufReader::new(&mut sock).read_line(&mut line).await?;
    let p = parse_query(&format!("?{}", line.trim()));
    let mut tick = tokio::time::interval(Duration::from_millis(p.interval_ms));
    for seq in 0..p.n {
        tick.tick().await;
        sock.write_all(&frame(seq, p.size)).await?;
    }
    let mut sink = [0u8; 1];
    let _ = sock.read(&mut sink).await; // wait for client close
    Ok(())
}

async fn server(wt_port: u16, tcp_port: u16) -> Result<()> {
    let config = ServerConfig::builder()
        .with_bind_address(SocketAddr::from(([127, 0, 0, 1], wt_port)))
        .with_identity(Identity::self_signed(["localhost", "127.0.0.1"])?)
        .max_idle_timeout(Some(Duration::from_secs(60)))?
        .build();
    let endpoint = Endpoint::server(config)?;
    let tcp = TcpListener::bind(("127.0.0.1", tcp_port)).await?;
    println!(r#"{{"ready":true,"wt_port":{wt_port},"tcp_port":{tcp_port}}}"#);
    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                tokio::spawn(async move {
                    if let Err(e) = serve_wt_session(incoming).await { eprintln!("[wt] session ended: {e:#}"); }
                });
            }
            accepted = tcp.accept() => {
                let (sock, _) = accepted?;
                tokio::spawn(async move {
                    if let Err(e) = serve_tcp(sock).await { eprintln!("[tcp] session ended: {e:#}"); }
                });
            }
        }
    }
}

// ── client ────────────────────────────────────────────────────────────────────

fn report(transport: &str, mode: &str, n: u32, handshake_ms: f64, got: &[(u32, f64)]) {
    let mut by_seq: Vec<(u32, f64)> = got.to_vec();
    by_seq.sort_by_key(|(s, _)| *s);
    by_seq.dedup_by_key(|(s, _)| *s);
    let lat: Vec<String> = by_seq.iter().map(|(_, l)| format!("{l:.3}")).collect();
    println!(
        r#"{{"transport":"{transport}","mode":"{mode}","n":{n},"handshake_ms":{handshake_ms:.3},"delivered":{},"latencies_ms":[{}]}}"#,
        by_seq.len(),
        lat.join(",")
    );
}

async fn client_wt(url: &str, timeout: Duration) -> Result<()> {
    let p = parse_query(url);
    let config = ClientConfig::builder()
        .with_bind_address(SocketAddr::from(([127, 0, 0, 1], 0)))
        .with_no_cert_validation()
        .max_idle_timeout(Some(Duration::from_secs(60)))?
        .build();
    let t0 = Instant::now();
    let conn: Connection = Endpoint::client(config)?.connect(url).await.context("connect")?;
    let handshake_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let got = Arc::new(Mutex::new(Vec::with_capacity(p.n as usize)));
    let collect = {
        let got = got.clone();
        let conn = conn.clone();
        async move {
            loop {
                let mut stream = match conn.accept_uni().await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let got = got.clone();
                tokio::spawn(async move {
                    let mut parser = Parser::default();
                    let mut buf = vec![0u8; 64 * 1024];
                    let mut local = Vec::new();
                    while let Ok(Some(k)) = stream.read(&mut buf).await {
                        parser.feed(&buf[..k], &mut local);
                        if !local.is_empty() {
                            got.lock().unwrap().append(&mut local);
                        }
                    }
                });
            }
        }
    };
    let n = p.n as usize;
    let done = {
        let got = got.clone();
        async move {
            while got.lock().unwrap().len() < n {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };
    tokio::select! {
        _ = collect => {}
        _ = done => {}
        _ = tokio::time::sleep(timeout) => {}
    }
    conn.close(0u32.into(), b"done");
    let got = got.lock().unwrap().clone();
    report("webtransport", if p.multi { "multi" } else { "single" }, p.n, handshake_ms, &got);
    Ok(())
}

async fn client_tcp(addr: &str, q: &str, timeout: Duration) -> Result<()> {
    let p = parse_query(&format!("?{q}"));
    let t0 = Instant::now();
    let mut sock = TcpStream::connect(addr).await?;
    sock.set_nodelay(true)?;
    let handshake_ms = t0.elapsed().as_secs_f64() * 1000.0;
    sock.write_all(format!("{q}\n").as_bytes()).await?;
    let mut parser = Parser::default();
    let mut got = Vec::with_capacity(p.n as usize);
    let mut buf = vec![0u8; 64 * 1024];
    let deadline = Instant::now() + timeout;
    while got.len() < p.n as usize {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, sock.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(k)) => parser.feed(&buf[..k], &mut got),
        }
    }
    report("tcp", "single", p.n, handshake_ms, &got);
    Ok(())
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let timeout = Duration::from_secs(flag(&args, "--timeout-s").and_then(|v| v.parse().ok()).unwrap_or(120));
    match args.get(1).map(|s| s.as_str()) {
        Some("server") => {
            let wt = flag(&args, "--wt-port").unwrap_or("4433").parse()?;
            let tcp = flag(&args, "--tcp-port").unwrap_or("4434").parse()?;
            server(wt, tcp).await
        }
        Some("client") => {
            if let Some(url) = flag(&args, "--url") {
                client_wt(url, timeout).await
            } else if let Some(addr) = flag(&args, "--tcp") {
                let q = format!(
                    "n={}&interval_ms={}&size={}",
                    flag(&args, "--n").unwrap_or("500"),
                    flag(&args, "--interval-ms").unwrap_or("50"),
                    flag(&args, "--size").unwrap_or("1024"),
                );
                client_tcp(addr, &q, timeout).await
            } else {
                bail!("client needs --url or --tcp")
            }
        }
        _ => Err(anyhow!("usage: wt-spike server|client ... (see file header)")),
    }
}
