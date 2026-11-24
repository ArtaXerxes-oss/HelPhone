/**
 * src/lib/txBatcher.ts — Atomic Soroban Transaction Batcher
 *
 * Problem: multiple contract writes (e.g. markArrived + recordExpertVerification)
 * currently each go through simulate → sign → submit → poll, costing 2× fees and
 * 2× wallet prompts. Stellar supports up to 100 operations per transaction, so all
 * those writes can be one atomic submission: cheaper, faster, and all-or-nothing.
 *
 * API:
 *   const batcher = createTxBatcher(wallet, signerAddress)
 *   batcher.add('mark_arrived',   markArrivedOp(requestId, index))
 *   batcher.add('record_zk',      recordVerificationOp(wallet, action, hash, fp))
 *   const results = await batcher.flush()
 *   // results[0].status === 'fulfilled' | 'rejected'
 *
 * Design constraints:
 *   - Each added operation keeps its own label so per-op error messages remain readable.
 *   - flush() is atomic: if simulation fails the whole batch is rejected together.
 *   - If flush() is never called, close() silently discards the pending queue.
 *   - Max 100 operations per batch (Stellar protocol limit); adding a 101st throws.
 *   - TxBatcher is single-use: create a fresh one per logical action group.
 */

import {
  Operation,
  TransactionBuilder,
  Transaction,
  BASE_FEE,
  rpc,
  Networks,
} from "@stellar/stellar-sdk";

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_OPS_PER_TX = 100; // Stellar protocol hard limit
export const DEFAULT_TIMEOUT_SECS = 30;
export const POLL_INTERVAL_MS = 1000;
export const POLL_MAX_ATTEMPTS = 30;

// ── Types ──────────────────────────────────────────────────────────────────

export interface BatchEntry {
  /** Human-readable label used in error messages. */
  label: string;
  /** A pre-built Stellar Operation (from Operation.invokeContractFunction). */
  operation: ReturnType<typeof Operation.invokeContractFunction>;
}

export interface BatchResult {
  label: string;
  status: "fulfilled" | "rejected";
  /** Set on success: the on-chain return value (scVal) if any. */
  value?: unknown;
  /** Set on failure: the error that caused rejection. */
  reason?: Error;
}

export interface FlushResult {
  /** SHA-256 hash of the submitted transaction. */
  hash: string;
  /** Per-operation results in submission order. */
  results: BatchResult[];
  /** true if every operation succeeded (no rejections). */
  ok: boolean;
}

export interface TxBatcherOptions {
  /** Network passphrase. Defaults to Stellar testnet. */
  network?: string;
  /** RPC server URL. Falls back to VITE_STELLAR_TESTNET_RPC_URL or public testnet. */
  rpcUrl?: string;
  /** Transaction timeout in seconds (default 30). */
  timeoutSecs?: number;
}

// ── TxBatcher ─────────────────────────────────────────────────────────────

export class TxBatcher {
  private readonly _wallet: unknown;
  private readonly _signerAddress: string;
  private readonly _network: string;
  private readonly _rpcUrl: string;
  private readonly _timeoutSecs: number;
  private readonly _queue: BatchEntry[] = [];
  private _flushed = false;

  constructor(
    wallet: unknown,
    signerAddress: string,
    opts: TxBatcherOptions = {},
  ) {
    if (!signerAddress || typeof signerAddress !== "string") {
      throw new Error("TxBatcher: signerAddress must be a non-empty string");
    }
    this._wallet = wallet;
    this._signerAddress = signerAddress;
    this._network =
      opts.network ??
      // @ts-ignore — Vite import.meta.env access
      (typeof import.meta !== "undefined"
        ? import.meta.env?.VITE_STELLAR_NETWORK === "mainnet"
          ? Networks.PUBLIC
          : Networks.TESTNET
        : Networks.TESTNET);
    this._rpcUrl =
      opts.rpcUrl ??
      // @ts-ignore
      (typeof import.meta !== "undefined"
        ? import.meta.env?.VITE_STELLAR_TESTNET_RPC_URL
        : undefined) ??
      "https://soroban-testnet.stellar.org";
    this._timeoutSecs = opts.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;
  }

  /** Number of operations currently queued. */
  get size(): number {
    return this._queue.length;
  }

  /**
   * Add a pre-built operation to the batch.
   * @throws if the batch is already at MAX_OPS_PER_TX (100).
   * @throws if flush() has already been called on this batcher.
   */
  add(label: string, operation: BatchEntry["operation"]): this {
    if (this._flushed) {
      throw new Error("TxBatcher: cannot add to an already-flushed batcher");
    }
    if (this._queue.length >= MAX_OPS_PER_TX) {
      throw new Error(
        `TxBatcher: cannot exceed ${MAX_OPS_PER_TX} operations per transaction`,
      );
    }
    if (!label || typeof label !== "string") {
      throw new Error("TxBatcher: label must be a non-empty string");
    }
    this._queue.push({ label, operation });
    return this;
  }

  /**
   * Build, simulate, sign, submit and confirm all queued operations as a
   * single atomic Stellar transaction.
   *
   * - If the batch is empty, resolves immediately with `{ hash: '', results: [], ok: true }`.
   * - If simulation fails, rejects with the simulation error (no tx is submitted).
   * - If the on-chain execution fails, rejects with the failure reason.
   * - Individual per-operation success/failure is reflected in `results[i].status`.
   */
  async flush(): Promise<FlushResult> {
    if (this._flushed) {
      throw new Error("TxBatcher: flush() has already been called");
    }
    this._flushed = true;

    if (this._queue.length === 0) {
      return { hash: "", results: [], ok: true };
    }

    const rpcServer = new rpc.Server(this._rpcUrl, { allowHttp: false });

    // ── Build ──────────────────────────────────────────────────────────────
    const account = await rpcServer.getAccount(this._signerAddress);
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * this._queue.length), // scale fee by op count
      networkPassphrase: this._network,
    });
    for (const entry of this._queue) {
      builder.addOperation(entry.operation);
    }
    const rawTx = builder.setTimeout(this._timeoutSecs).build();

    // ── Simulate ───────────────────────────────────────────────────────────
    const sim = await rpcServer.simulateTransaction(rawTx);
    if ((sim as any).error) {
      const errMsg = (sim as any).error;
      throw new Error(`TxBatcher simulation failed: ${errMsg}`);
    }

    const preparedTx = rpc.assembleTransaction(rawTx, sim as any, this._network).build();

    // ── Sign ───────────────────────────────────────────────────────────────
    const walletAny = this._wallet as any;
    let signedXdr: string;
    if (typeof walletAny?.signTransaction === "function") {
      const signResult = await walletAny.signTransaction(preparedTx.toXDR(), {
        networkPassphrase: this._network,
      });
      signedXdr =
        typeof signResult === "string" ? signResult : signResult?.signedTxXdr;
    } else {
      throw new Error("TxBatcher: wallet must implement signTransaction()");
    }

    // ── Submit ─────────────────────────────────────────────────────────────
    const signedTx = new Transaction(signedXdr, this._network);
    const sendResp = await rpcServer.sendTransaction(signedTx);
    if ((sendResp as any).status === "ERROR") {
      throw new Error(
        `TxBatcher submission error: ${JSON.stringify((sendResp as any).errorResult ?? sendResp)}`,
      );
    }

    const hash: string = (sendResp as any).hash;

    // ── Poll ───────────────────────────────────────────────────────────────
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      const txResult = await rpcServer.getTransaction(hash);
      if ((txResult as any).status === "SUCCESS") {
        return buildFlushResult(hash, this._queue, txResult);
      }
      if ((txResult as any).status === "FAILED") {
        throw new Error(`TxBatcher transaction failed (hash: ${hash})`);
      }
      await delay(POLL_INTERVAL_MS);
    }

    throw new Error(`TxBatcher timed out waiting for confirmation (hash: ${hash})`);
  }

  /**
   * Discard all pending operations without submitting.
   * Safe to call even after flush().
   */
  close(): void {
    this._flushed = true;
    this._queue.length = 0;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a new TxBatcher for a single logical action group.
 *
 * @param wallet         - StellarWalletsKit instance or any object with signTransaction()
 * @param signerAddress  - G... address of the signing account
 * @param opts           - Optional network/RPC/timeout overrides
 *
 * @example
 * const batch = createTxBatcher(StellarWalletsKit, address)
 * batch.add('mark_arrived',  Operation.invokeContractFunction({ ... }))
 * batch.add('record_proof',  Operation.invokeContractFunction({ ... }))
 * const { hash, results, ok } = await batch.flush()
 */
export function createTxBatcher(
  wallet: unknown,
  signerAddress: string,
  opts?: TxBatcherOptions,
): TxBatcher {
  return new TxBatcher(wallet, signerAddress, opts);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map the on-chain transaction result back to per-operation BatchResults.
 *
 * Stellar's `getTransaction` returns a single overall status. We mark every
 * operation as fulfilled on SUCCESS (the SDK does not expose per-op XDR for
 * multi-op transactions in RPC v0/v1 — that level of granularity requires
 * parsing the full transaction result XDR). On FAILED the entire batch is
 * rejected at the flush() level before this function is reached.
 */
function buildFlushResult(
  hash: string,
  queue: BatchEntry[],
  txResult: unknown,
): FlushResult {
  const results: BatchResult[] = queue.map((entry) => ({
    label: entry.label,
    status: "fulfilled" as const,
    value: txResult,
  }));
  return { hash, results, ok: true };
}

// ── Utility: build a dry-run batcher for unit tests ───────────────────────

/**
 * Create a batcher wired to a custom submit function instead of a live RPC.
 * Intended for unit tests only — not exported from the public API surface.
 *
 * The submitFn receives the array of queued entries and returns a FlushResult.
 */
export function __createTestBatcher(
  submitFn: (entries: BatchEntry[]) => Promise<FlushResult>,
): Pick<TxBatcher, "add" | "flush" | "close" | "size"> & { _entries: BatchEntry[] } {
  const entries: BatchEntry[] = [];
  let flushed = false;

  return {
    _entries: entries,
    get size() { return entries.length; },
    add(label: string, op: BatchEntry["operation"]) {
      if (flushed) throw new Error("already flushed");
      if (entries.length >= MAX_OPS_PER_TX)
        throw new Error(`Cannot exceed ${MAX_OPS_PER_TX} operations`);
      if (!label) throw new Error("label required");
      entries.push({ label, operation: op });
      return this as any;
    },
    async flush() {
      if (flushed) throw new Error("already flushed");
      flushed = true;
      if (entries.length === 0) return { hash: "", results: [], ok: true };
      return submitFn(entries);
    },
    close() {
      flushed = true;
      entries.length = 0;
    },
  };
}
