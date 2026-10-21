const DEFAULT_LEDGER_SECONDS = 5;
const DEFAULT_FEE_CONFIG = {
  writeEntryFee: 1_000,
  writeByteFee: 10,
  readEntryFee: 100,
  readByteFee: 1,
  rentFeePerKbPerLedger: 1,
  transactionBaseFee: 100,
};

function assertNonNegativeInt(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

export function normalizeStorageEntries(entries = []) {
  return entries.map((entry, index) => {
    const normalized = {
      key: entry.key || `entry_${index}`,
      bytes: Number(entry.bytes || 0),
      reads: Number(entry.reads || 0),
      writes: Number(entry.writes || 0),
      ttlLedgers: Number(entry.ttlLedgers || 0),
      persistent: entry.persistent !== false,
    };
    assertNonNegativeInt(`${normalized.key}.bytes`, normalized.bytes);
    assertNonNegativeInt(`${normalized.key}.reads`, normalized.reads);
    assertNonNegativeInt(`${normalized.key}.writes`, normalized.writes);
    assertNonNegativeInt(`${normalized.key}.ttlLedgers`, normalized.ttlLedgers);
    return normalized;
  });
}

export function estimateSorobanStorageBudget(entries = [], options = {}) {
  const fee = { ...DEFAULT_FEE_CONFIG, ...(options.feeConfig || {}) };
  const normalized = normalizeStorageEntries(entries);
  const totals = normalized.reduce((acc, entry) => {
    acc.bytes += entry.bytes;
    acc.reads += entry.reads;
    acc.writes += entry.writes;
    acc.readBytes += entry.reads * entry.bytes;
    acc.writeBytes += entry.writes * entry.bytes;
    if (entry.persistent) acc.persistentBytes += entry.bytes;
    else acc.temporaryBytes += entry.bytes;
    const kb = Math.ceil(entry.bytes / 1024);
    acc.rent += kb * entry.ttlLedgers * fee.rentFeePerKbPerLedger;
    return acc;
  }, {
    entries: normalized.length,
    bytes: 0,
    reads: 0,
    writes: 0,
    readBytes: 0,
    writeBytes: 0,
    persistentBytes: 0,
    temporaryBytes: 0,
    rent: 0,
  });

  const readFee = totals.reads * fee.readEntryFee + totals.readBytes * fee.readByteFee;
  const writeFee = totals.writes * fee.writeEntryFee + totals.writeBytes * fee.writeByteFee;
  const transactionFee = fee.transactionBaseFee + readFee + writeFee + totals.rent;
  const ledgerSeconds = Number(options.ledgerSeconds || DEFAULT_LEDGER_SECONDS);

  return {
    ...totals,
    readFee,
    writeFee,
    rentFee: totals.rent,
    transactionFee,
    estimatedTtlSeconds: normalized.reduce((max, entry) => Math.max(max, entry.ttlLedgers * ledgerSeconds), 0),
    byEntry: normalized.map((entry) => ({
      key: entry.key,
      bytes: entry.bytes,
      readFee: entry.reads * fee.readEntryFee + entry.reads * entry.bytes * fee.readByteFee,
      writeFee: entry.writes * fee.writeEntryFee + entry.writes * entry.bytes * fee.writeByteFee,
      rentFee: Math.ceil(entry.bytes / 1024) * entry.ttlLedgers * fee.rentFeePerKbPerLedger,
    })),
  };
}

export function compareStorageLayouts(layouts, options) {
  return Object.fromEntries(
    Object.entries(layouts).map(([name, entries]) => [name, estimateSorobanStorageBudget(entries, options)]),
  );
}
