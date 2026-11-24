/**
 * Join receipts (#932, ISP-066).
 *
 * A device emits a receipt when history hydration completes. The receipt
 * records what the device holds: the snapshot it started from, its state-vector
 * highwater, how many pages it applied and a digest of its visible state.
 * Verification compares that against the server's current view.
 *
 * Lives under src/lib so the client can emit receipts without importing server
 * code. server/indexer/auditStreamer.js re-exports these for existing callers.
 */

export function createJoinReceipt({ snapshotId, highwater, pageCount, hash, clientVector = {} }) {
  return {
    receiptId: `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    snapshotId,
    highwater,
    pageCount,
    hash,
    clientVector,
    createdAt: new Date().toISOString(),
    verified: false,
  };
}

/**
 * Checks a receipt against what the server expects. Missing `serverExpected`
 * fields are not checked, so a caller can verify highwater and hash without
 * pinning a snapshot id.
 */
export function verifyJoinCompleteness(receipt, serverExpected) {
  if (!receipt || !serverExpected) return { complete: false, reason: 'missing_receipt_or_expected' };
  if (receipt.snapshotId !== serverExpected.snapshotId && serverExpected.snapshotId) {
    return { complete: false, reason: 'snapshot_mismatch' };
  }
  if (receipt.highwater < serverExpected.highwater) {
    return {
      complete: false,
      reason: 'highwater_behind',
      deviceHighwater: receipt.highwater,
      serverHighwater: serverExpected.highwater,
    };
  }
  if (serverExpected.hash && receipt.hash !== serverExpected.hash) {
    return { complete: false, reason: 'hash_mismatch' };
  }
  receipt.verified = true;
  return { complete: true, receiptId: receipt.receiptId };
}
