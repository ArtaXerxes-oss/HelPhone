import type {
  TreasuryAssetRow,
  DisbursementUsage,
  OracleErrorKind,
} from "../types/index";

/** Soroban token amounts use 7 decimals ("stroops"). */
export const STROOPS = 10_000_000;

/** Converts an on-chain i128 to a JS number; values beyond 2^53 (e.g. the
 *  i128::MAX "no cap" sentinel) become Infinity instead of losing precision. */
export function toAmount(val: unknown): number {
  if (typeof val === "bigint") {
    return val > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(val);
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

export function formatStroops(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "∞";
  return (value / STROOPS).toFixed(digits);
}

export function disbursementUsage(limit: number, spent: number): DisbursementUsage {
  if (!Number.isFinite(limit)) {
    return { unlimited: true, pct: 0, remaining: Infinity, exhausted: false };
  }
  const remaining = Math.max(0, limit - spent);
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 100;
  return { unlimited: false, pct, remaining, exhausted: remaining === 0 };
}

export function toAssetRow(
  asset: string,
  raw: {
    reserve: unknown;
    limit: unknown;
    spent: unknown;
    remaining: unknown;
    weight: unknown;
  },
): TreasuryAssetRow {
  return {
    asset,
    reserve: toAmount(raw.reserve),
    dailyLimit: toAmount(raw.limit),
    spentToday: toAmount(raw.spent),
    remainingToday: toAmount(raw.remaining),
    targetWeightBps: toAmount(raw.weight),
  };
}

/** Maps a DaoError contract code (see contracts/helphone_dao) to a UI category. */
export function classifyOracleError(err: unknown): OracleErrorKind {
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  const code = /Error\(Contract, #(\d+)\)/.exec(msg)?.[1];
  switch (code) {
    case "13":
      return "not-configured";
    case "14":
      return "stale";
    case "15":
      return "unavailable";
    case "16":
    case "17":
    case "18":
      return "invalid";
    default:
      return "unknown";
  }
}

export const ORACLE_ERROR_MESSAGES: Record<OracleErrorKind, string> = {
  stale: "Price feed is more than 1 hour old. Try again once the oracle updates.",
  unavailable: "The oracle has no price for one of these assets.",
  invalid: "The oracle returned an invalid price, or the amount is invalid.",
  "not-configured": "No price oracle is configured for this DAO.",
  unknown: "Could not fetch a conversion quote.",
};

// ── Federation Settlement & Cross-Instance IOUs (ISP-144) ──────────────────

export interface CrossInstanceIou {
  iouId: string
  debtorInstance: string    // Deployment receiving aid (who owes)
  creditorInstance: string  // Deployment providing responders (who is owed)
  incidentId: string
  stroops: number           // Value in stroops (7 decimals)
  status: 'issued' | 'netted' | 'defaulted'
  issuedAt: number
  nettedAt?: number
  settlementProposalId?: number
  feeStroops?: number
  notes?: string
}

export interface NettingResult {
  debtorInstance: string
  creditorInstance: string
  netStroops: number
  nettedIouIds: string[]
  settlementTimestamp: number
}

export function issueCrossInstanceIou(params: {
  debtorInstance: string
  creditorInstance: string
  incidentId: string
  stroops: number
  feeStroops?: number
  notes?: string
}): CrossInstanceIou {
  const iouId = `iou_${params.debtorInstance}_${params.creditorInstance}_${params.incidentId}`
  return {
    iouId,
    debtorInstance: params.debtorInstance,
    creditorInstance: params.creditorInstance,
    incidentId: params.incidentId,
    stroops: params.stroops,
    status: 'issued',
    issuedAt: Date.now(),
    feeStroops: params.feeStroops ?? 100,
    notes: params.notes,
  }
}

export function netCrossInstanceIous(
  ious: CrossInstanceIou[],
  instanceA: string,
  instanceB: string
): {
  netResult: NettingResult
  updatedIous: CrossInstanceIou[]
} {
  const activeIous = ious.filter(
    (iou) =>
      iou.status === 'issued' &&
      ((iou.debtorInstance === instanceA && iou.creditorInstance === instanceB) ||
       (iou.debtorInstance === instanceB && iou.creditorInstance === instanceA))
  )

  let balanceAtoB = 0
  for (const iou of activeIous) {
    if (iou.debtorInstance === instanceA && iou.creditorInstance === instanceB) {
      balanceAtoB += iou.stroops
    } else if (iou.debtorInstance === instanceB && iou.creditorInstance === instanceA) {
      balanceAtoB -= iou.stroops
    }
  }

  const now = Date.now()
  const debtor = balanceAtoB >= 0 ? instanceA : instanceB
  const creditor = balanceAtoB >= 0 ? instanceB : instanceA
  const netStroops = Math.abs(balanceAtoB)
  const nettedIouIds = activeIous.map((i) => i.iouId)

  const updatedIous = ious.map((iou) => {
    if (nettedIouIds.includes(iou.iouId)) {
      return { ...iou, status: 'netted' as const, nettedAt: now }
    }
    return iou
  })

  return {
    netResult: {
      debtorInstance: debtor,
      creditorInstance: creditor,
      netStroops,
      nettedIouIds,
      settlementTimestamp: now,
    },
    updatedIous,
  }
}

export function escalateUnpaidIouToDao(
  iou: CrossInstanceIou,
  reason = 'Overdue cross-instance aid settlement'
): {
  proposalType: 'FundAllocation'
  title: string
  description: string
  action: 'dao_vote_writeoff'
  iou: CrossInstanceIou
} {
  const updatedIou: CrossInstanceIou = {
    ...iou,
    status: 'defaulted',
    notes: `${iou.notes || ''} [DEFAULT: ${reason}]`.trim(),
  }

  return {
    proposalType: 'FundAllocation',
    title: `[Federation Default] Cross-Instance IOU ${iou.iouId}`,
    description: `Peer instance ${iou.debtorInstance} has defaulted on ${formatStroops(iou.stroops)} XLM aid reimbursement for incident ${iou.incidentId}. Reason: ${reason}. Escalated to DAO vote for emergency treasury recovery or mutual aid write-off.`,
    action: 'dao_vote_writeoff',
    iou: updatedIou,
  }
}

