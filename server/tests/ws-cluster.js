import WebSocket from "ws";

const urls = (process.env.WS_CLUSTER_URLS || "").split(",").map((url) => url.trim()).filter(Boolean);
if (urls.length < 3) {
  console.error("Set WS_CLUSTER_URLS to three comma-separated /events/ws URLs.");
  process.exit(2);
}

const clientCount = 1000;
const timeoutMs = Number(process.env.WS_CLUSTER_TIMEOUT_MS || 20_000);
const sockets = [];

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.send(JSON.stringify({ type: "subscribe", topics: ["RqCreated", "LocUpd", "Arrived"] }));
      sockets.push(socket);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

try {
  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: clientCount }, (_, index) =>
    connect(urls[index % urls.length]),
  ));
  const failed = results.filter((result) => result.status === "rejected");
  console.log(JSON.stringify({
    clients: clientCount,
    connected: clientCount - failed.length,
    failed: failed.length,
    endpoints: urls.length,
    durationMs: Date.now() - started,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close(1000, "Load test complete");
  await new Promise((resolve) => setTimeout(resolve, 250));
}
