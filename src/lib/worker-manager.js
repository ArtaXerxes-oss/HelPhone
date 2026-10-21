let workerInstance = null;
let messageIdCounter = 0;
const pendingMessages = new Map();

function getOrCreateWorker() {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker(new URL("../workers/zk-worker.js", import.meta.url), {
    type: "module",
  });

  workerInstance.onmessage = (event) => {
    const { id, action, message, error, ready, success } = event.data;
    const pending = pendingMessages.get(id);

    if (pending) {
      if (action === "log") {
        pending.onLog?.(message);
      } else if (action === "error") {
        pending.reject(new Error(error));
        pendingMessages.delete(id);
      } else if (
        action === "warmProverComplete" ||
        action === "initHumanityComplete" ||
        action === "isProverReadyResult"
      ) {
        pending.resolve({ ready, success });
        pendingMessages.delete(id);
      }
    }
  };

  workerInstance.onerror = (error) => {
    console.error("Worker error:", error);
    workerInstance = null;
  };

  return workerInstance;
}

export function warmProverAsync(onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = getOrCreateWorker();
    const id = ++messageIdCounter;
    pendingMessages.set(id, { resolve, reject, onLog });
    worker.postMessage({ id, action: "warmProver" });
  });
}

export function isProverReadyAsync() {
  return new Promise((resolve, reject) => {
    const worker = getOrCreateWorker();
    const id = ++messageIdCounter;
    pendingMessages.set(id, {
      resolve: (data) => resolve(data.ready),
      reject,
    });
    worker.postMessage({ id, action: "isProverReady" });
  });
}

export function initHumanityAsync(onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = getOrCreateWorker();
    const id = ++messageIdCounter;
    pendingMessages.set(id, { resolve, reject, onLog });
    worker.postMessage({ id, action: "initHumanity" });
  });
}

export function terminateWorker() {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    pendingMessages.clear();
    messageIdCounter = 0;
  }
}
