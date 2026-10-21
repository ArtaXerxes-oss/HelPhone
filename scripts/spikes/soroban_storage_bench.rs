//! Spike #601 benchmark — Soroban storage layout / tier rent & budget comparison.
//!
//! PROTOTYPE: to be discarded once ADR-001 is accepted.
//!
//! Compiled as a test module of `contracts/emergency_vault` (see the `#[path]`
//! mod at the bottom of its lib.rs) so it can drive the contract through the
//! real host with invocation metering. Run:
//!
//!   cd contracts/emergency_vault
//!   cargo build --target wasm32v1-none --release        # meter the real WASM
//!   cargo test --release storage_bench -- --ignored --nocapture
//!
//! Without the WASM build it falls back to the native contract and says so in
//! the report: VM instantiation and WASM-read costs are then missing.
//!
//! Every number reported comes from the host's own metering
//! (`env.cost_estimate().resources()` / `.fee()`, pubnet fee snapshot baked into
//! soroban-sdk 26) — nothing here is modelled by hand except the write-conflict
//! analysis, which is derived from each action's write footprint.

extern crate std;

use crate::{
    EmergencyVault, EmergencyVaultClient, LAYOUT_NORMALIZED, LAYOUT_PACKED, TIER_PERSISTENT,
    TIER_TEMPORARY,
};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    xdr::{LedgerEntryData, LedgerKey, Limits, WriteXdr},
    Address, BytesN, Env, Vec as SVec,
};
use std::{collections::HashMap, format, string::String, vec, vec::Vec};

const INCIDENTS: u32 = 100;
const RESPONDERS: u32 = 250;
const ACTIONS: usize = 1_000;
/// Rent horizons (ledgers @ ~5s). Assumptions, not network settings: re-run
/// against `stellar network settings` output before acting on absolute fees.
const MIN_PERSISTENT_TTL: u32 = 120_960; // 7 days
const MIN_TEMP_TTL: u32 = 17_280; // 1 day
const EXTEND_TO: u32 = 535_680; // 31 days
const CODEC_N: u32 = 200;

const WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32v1-none/release/emergency_vault.wasm"
);

/// Deterministic xorshift so every run replays the same workload.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u32) -> u32 {
        (self.next() % n as u64) as u32
    }
}

#[derive(Default, Clone)]
struct Agg {
    calls: u64,
    cpu: i64,
    cpu_max: i64,
    mem_max: i64,
    entries_max: u32,
    write_bytes: u64,
    write_entries: u64,
    fee: i64,
    rent_fee: i64,
    events_fee: i64,
}

impl Agg {
    fn add(&mut self, env: &Env) {
        let r = env.cost_estimate().resources();
        let f = env.cost_estimate().fee();
        self.calls += 1;
        self.cpu += r.instructions;
        self.cpu_max = self.cpu_max.max(r.instructions);
        self.mem_max = self.mem_max.max(r.mem_bytes);
        self.entries_max = self.entries_max.max(r.memory_read_entries + r.disk_read_entries);
        self.write_bytes += r.write_bytes as u64;
        self.write_entries += r.write_entries as u64;
        self.fee += f.total;
        self.rent_fee += f.persistent_entry_rent + f.temporary_entry_rent;
        self.events_fee += f.contract_events;
    }
}

struct Outcome {
    name: &'static str,
    wasm: bool,
    open: Agg,
    ack: Agg,
    extend: Agg,
    entries: usize,
    footprint_bytes: usize,
    hot_key_writers: usize,
    codec: Option<(i64, i64)>,
}

fn stroops(v: i64) -> String {
    format!("{:.4} XLM", v as f64 / 10_000_000.0)
}

fn workload() -> Vec<(u32, u32, i128, [u8; 32])> {
    let mut rng = Rng(0x601_5eed);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(ACTIONS);
    while out.len() < ACTIONS {
        // Skew towards a few incidents: disasters concentrate responders.
        let incident = if rng.below(10) < 6 { rng.below(10) } else { rng.below(INCIDENTS) };
        let responder = rng.below(RESPONDERS);
        if !seen.insert((incident, responder)) {
            continue;
        }
        let mut sig = [0u8; 32];
        for chunk in sig.chunks_mut(8) {
            chunk.copy_from_slice(&rng.next().to_be_bytes());
        }
        out.push((incident, responder, (1 + rng.below(1000)) as i128 * 10_000_000, sig));
    }
    out
}

fn run(name: &'static str, layout: u32, tier: u32) -> Outcome {
    let env = Env::new_with_config(EnvTestConfig { capture_snapshot_at_drop: false });
    env.ledger().with_mut(|l| {
        l.min_persistent_entry_ttl = MIN_PERSISTENT_TTL;
        l.min_temp_entry_ttl = MIN_TEMP_TTL;
        l.max_entry_ttl = 3_110_400;
    });
    let wasm = std::fs::read(WASM_PATH).ok();
    let id = match &wasm {
        Some(bytes) => env.register(bytes.as_slice(), (layout, tier)),
        None => env.register(EmergencyVault, (layout, tier)),
    };
    let c = EmergencyVaultClient::new(&env, &id);
    let responders: Vec<Address> = (0..RESPONDERS).map(|_| Address::generate(&env)).collect();

    let mut open = Agg::default();
    for i in 0..INCIDENTS {
        c.open_incident(&i, &(i % 5), &(i as i32 * 10_000), &(-(i as i32) * 10_000));
        open.add(&env);
    }

    let work = workload();
    let mut ack = Agg::default();
    let mut by_incident: HashMap<u32, Vec<Address>> = HashMap::new();
    let mut key_writers: HashMap<String, usize> = HashMap::new();
    let mut registered = std::collections::HashSet::new();
    for (incident, r, stake, sig) in &work {
        let who = &responders[*r as usize];
        c.ack(who, incident, stake, &BytesN::from_array(&env, sig));
        ack.add(&env);
        by_incident.entry(*incident).or_default().push(who.clone());
        // Write footprint of this action, for the parallel-execution
        // conflict analysis (actions sharing a written key serialize).
        let keys: Vec<String> = if layout == LAYOUT_NORMALIZED {
            vec![format!("ack:{incident}:{r}")]
        } else if registered.insert(*r) {
            vec![format!("agg:{incident}"), "instance".into(), format!("resp:{r}")]
        } else {
            vec![format!("agg:{incident}")]
        };
        for k in keys {
            *key_writers.entry(k).or_default() += 1;
        }
    }

    let mut extend = Agg::default();
    for i in 0..INCIDENTS {
        let rs = by_incident.get(&i).cloned().unwrap_or_default();
        // Normalized must name every ack key; packed ignores the list.
        let list = if layout == LAYOUT_NORMALIZED { SVec::from_slice(&env, &rs) } else { SVec::new(&env) };
        c.extend_incident(&i, &list, &EXTEND_TO);
        extend.add(&env);
    }
    if layout == LAYOUT_PACKED {
        for r in &registered {
            c.extend_responder(&responders[*r as usize], &EXTEND_TO);
            extend.add(&env);
        }
    }

    // Final ledger footprint of the contract's data entries (instance excluded).
    let snap = env.to_ledger_snapshot();
    let mut entries = 0;
    let mut footprint_bytes = 0;
    for (key, (entry, _ttl)) in &snap.ledger_entries {
        if let (LedgerKey::ContractData(k), LedgerEntryData::ContractData(_)) = (key.as_ref(), &entry.data) {
            if k.contract == id.clone().try_into().unwrap()
                && !matches!(k.key, soroban_sdk::xdr::ScVal::LedgerKeyContractInstance)
            {
                entries += 1;
                footprint_bytes += entry.to_xdr(Limits::none()).unwrap().len();
            }
        }
    }

    // Codec micro-benchmark, isolated from storage (only meaningful once, on a
    // single configuration). Subtract the n=0 call to remove VM/invoke overhead.
    let codec = (layout == LAYOUT_PACKED && tier == TIER_PERSISTENT).then(|| {
        let cost = |f: &dyn Fn(u32)| {
            f(0);
            let base = env.cost_estimate().resources().instructions;
            f(CODEC_N);
            (env.cost_estimate().resources().instructions - base) / CODEC_N as i64
        };
        (cost(&|n| { c.bench_native(&n); }), cost(&|n| { c.bench_packed(&n); }))
    });

    Outcome {
        name,
        wasm: wasm.is_some(),
        open,
        ack,
        extend,
        entries,
        footprint_bytes,
        hot_key_writers: key_writers.values().copied().max().unwrap_or(0),
        codec,
    }
}

#[test]
#[ignore = "spike benchmark; run explicitly with --ignored --nocapture"]
fn storage_bench() {
    let results = [
        run("normalized / persistent", LAYOUT_NORMALIZED, TIER_PERSISTENT),
        run("normalized / temporary", LAYOUT_NORMALIZED, TIER_TEMPORARY),
        run("packed / persistent", LAYOUT_PACKED, TIER_PERSISTENT),
        run("packed / temporary", LAYOUT_PACKED, TIER_TEMPORARY),
    ];

    let mut out = String::new();
    out += &format!(
        "## Soroban storage benchmark (#601)\n\nWorkload: {INCIDENTS} incidents, {RESPONDERS} responders, {ACTIONS} responder acks \
         (60% concentrated on 10 hot incidents). Rent horizons: min persistent TTL {MIN_PERSISTENT_TTL}, \
         min temporary TTL {MIN_TEMP_TTL}, extend-to {EXTEND_TO} ledgers. Metered target: {}.\n\n",
        if results[0].wasm { "compiled WASM (VM costs included)" } else { "NATIVE contract - WASM not built, VM costs missing" }
    );
    out += "| Layout / tier | Ack CPU mean (insns) | Ack CPU max | Ack mem max (B) | Ack write B mean | Ack fee mean | Ack rent fee total | Events fee total | 1000-ack fee total | Extend-31d fee total | Entries | Footprint (B) | Hot-key writers |\n";
    out += "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n";
    for r in &results {
        out += &format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
            r.name,
            r.ack.cpu / r.ack.calls as i64,
            r.ack.cpu_max,
            r.ack.mem_max,
            r.ack.write_bytes / r.ack.calls,
            stroops(r.ack.fee / r.ack.calls as i64),
            stroops(r.ack.rent_fee),
            stroops(r.ack.events_fee),
            stroops(r.ack.fee),
            stroops(r.extend.fee),
            r.entries,
            r.footprint_bytes,
            r.hot_key_writers,
        );
    }
    out += "\n| Layout / tier | open_incident CPU mean | open_incident fee total | Extend calls | Extend CPU max |\n| --- | ---: | ---: | ---: | ---: |\n";
    for r in &results {
        out += &format!(
            "| {} | {} | {} | {} | {} |\n",
            r.name,
            r.open.cpu / r.open.calls as i64,
            stroops(r.open.fee),
            r.extend.calls,
            r.extend.cpu_max
        );
    }
    let mut per_incident: HashMap<u32, usize> = HashMap::new();
    for (i, ..) in workload() {
        *per_incident.entry(i).or_default() += 1;
    }
    let busiest = per_incident.values().copied().max().unwrap_or(0);
    // soroban-sdk 26 InvocationResourceLimits::mainnet(): 600M instructions,
    // 100 ledger entries per transaction footprint.
    let norm = &results[0].extend;
    let per_ack_cpu = norm.cpu_max / busiest as i64;
    let fixed_entries = norm.entries_max as usize - busiest;
    out += &format!(
        "\nBusiest incident: {busiest} acks. Normalized extend_incident on it touched {} ledger entries and {} insns \
         (~{per_ack_cpu} insns/ack). Mainnet per-tx ceilings are reached at ~{} acks on one incident (100-entry footprint) \
         and ~{} acks (600M instructions). Packed extend touches at most {} entries regardless of responder count.\n",
        norm.entries_max,
        norm.cpu_max,
        100 - fixed_entries,
        600_000_000 / per_ack_cpu,
        results[2].extend.entries_max,
    );
    if let Some((native, packed)) = results.iter().find_map(|r| r.codec) {
        out += &format!(
            "\nCodec round trip, per record (n={CODEC_N}, invoke overhead subtracted): native XDR {native} insns, packed 20-byte {packed} insns.\n"
        );
    }
    std::println!("{out}");
    let _ = std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/target/spike-601-report.md"), &out);
}
