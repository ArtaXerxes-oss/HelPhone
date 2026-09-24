# ADR-001: Soroban Incident State Storage Architecture: Bit-Packed Storage vs Normalized Ledger Records

- **Status:** Proposed
- **Date:** 2026-09-23
- **Spike:** #601 (time box 3 days)
- **Prototype:** `contracts/emergency_vault/` and `scripts/spikes/soroban_storage_bench.rs`. Both are to be discarded after acceptance.

## Context

HelPhone stores two kinds of emergency state on Soroban:

- **Incident metadata:** severity, status, coordinates and opening time.
- **Responder stake acknowledgements:** stake plus a 32-byte signature, one per responder per incident.

Soroban charges rent per byte per ledger of TTL, and it charges per entry written. It also caps each transaction's CPU, memory and footprint. We need to know which layout keeps rent low without hitting those caps when many responders converge on the same incident.

## Options benchmarked

Both layouts are implemented in the same prototype contract. Each can use either storage tier, which gives four configurations, all driven by the same workload.

| Layout | Incident storage | Acknowledgement storage |
| --- | --- | --- |
| **Normalized** | One `Incident(id)` entry per incident (native `#[contracttype]` struct) | One `Ack(id, responder)` entry per acknowledgement (stake, signature, timestamp) |
| **Packed** | 20-byte slots, 32 incidents per `Bucket(id/32)` entry | One 180-byte `AckAgg(id)` per incident: 1024-bit responder bitmap, stake total, rolling sha256 signature commitment, count. Each signature is emitted as an `ack` event. A `Responder(addr) → index` registry backs the bitmap. |

## Method

`cargo test --release storage_bench -- --ignored --nocapture` registers the **compiled WASM**, so VM instantiation and code-read costs are included. It then replays a deterministic workload:

- 100 incidents
- 250 responders
- 1,000 unique acknowledgements, 60% of them concentrated on 10 hot incidents
- a 31-day TTL extension of all state

Every figure below comes from the host's own invocation metering (`env.cost_estimate().resources()` and `.fee()`), priced with soroban-sdk 26's pubnet fee snapshot. Rent horizons are bench parameters: minimum persistent TTL 7 days, minimum temporary TTL 1 day. Absolute fees scale with live network settings, so check `stellar network settings` before budgeting. The comparisons between layouts do not depend on those settings.

## Results

| Layout / tier | Ack CPU mean | Ack fee mean | 1,000-ack fee | Ack rent | Event fees | 31-day extend fee | Entries | Footprint | Hot-key writers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normalized / persistent | 939,483 | 0.0199 XLM | 19.95 XLM | 18.00 XLM | 0 | 64.64 XLM | 1,100 | 274,400 B | 1 |
| normalized / temporary | 939,483 | 0.0042 XLM | 4.18 XLM | 2.23 XLM | 0 | 40.86 XLM | 1,100 | 274,400 B | 1 |
| packed / persistent | 866,513 | 0.0075 XLM | 7.49 XLM | 4.50 XLM | 0.23 XLM | 15.30 XLM | 350 | 64,416 B | 246 |
| packed / temporary | 866,513 | 0.0036 XLM | 3.65 XLM | 0.65 XLM | 0.23 XLM | 9.71 XLM | 350 | 64,416 B | 246 |

Additional measurements:

- **Codec CPU per record** (invoke overhead subtracted): native XDR round trip 90,373 instructions; 20-byte packed round trip 15,840 instructions. Packing is 5.7× cheaper, not more expensive. The feared unpacking overhead does not exist at this scale.
- **Per-transaction ceilings (mainnet, soroban-sdk 26):** 600M instructions, 100 footprint entries, 50 writes. Every acknowledgement in every configuration uses at most 1.23M instructions and 1.47 MB of memory, so single actions are nowhere near the limits.
- **TTL extension is where normalized breaks.** Extending the busiest incident (70 acknowledgements) touched 73 entries and 26.9M instructions. The **100-entry footprint limit is reached at about 97 acknowledgements on one incident**; the CPU limit would not be hit until about 1,558. Past that, extending rent for one incident needs several transactions, and a missed batch lets the stake records be archived. Packed extension touches at most 4 entries whatever the responder count.
- **Hot keys.** Normalized acknowledgement writes are all disjoint, with at most 1 writer per key. Packed has two contended keys:
  - `AckAgg(id)`: written by every acknowledgement on an incident, 70 for the busiest one.
  - The instance entry: 246 writers, because the prototype assigns responder indices from a counter stored in instance storage.

  Under parallel Soroban execution, transactions whose write footprints overlap are serialized into the same cluster. At the peak of a disaster, a packed incident therefore accepts acknowledgements one at a time.

## Decision

Adopt **packed / persistent** for incident metadata and acknowledgement aggregates, with three changes to the prototype:

1. **Assign responder indices at onboarding, not on first acknowledgement.** Registration is a separate transaction, off the emergency hot path. That removes the instance-storage hot key, the 246 writers in the table above.
2. **Shard `AckAgg` by `(id, shard)`** at the 1,024-responder bitmap limit. Hot incidents then have multiple aggregate keys that can be written in parallel.
3. **Treat `ack` events as the durable record of individual signatures.** Running an indexer is now a hard requirement. On-chain, the rolling sha256 commitment lets anyone check an indexer's signature list against contract state.

Use **temporary** storage only for data that can be recreated, such as live location pings. It must never hold stake or acknowledgement data (see risk matrix).

Packed/persistent costs 62% less than normalized/persistent to accept 1,000 acknowledgements (7.49 vs 19.95 XLM). It costs 76% less to keep alive for a month (15.30 vs 64.64 XLM) and stores 77% fewer bytes. It also has no per-incident responder ceiling for TTL maintenance.

## Risk matrix

Likelihood and impact are each rated Low, Medium or High.

| # | Risk | Configurations | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- | --- |
| R1 | Temporary entries expire and **cannot be restored**, so stake and acknowledgement records are permanently lost | Either layout on temporary | High, since this is the defined behavior on TTL lapse | High: financial and audit loss | Never use temporary storage for stake or acknowledgement state (decision above) |
| R2 | A packed temporary `Responder` registry expires, indices are reassigned, and bitmaps become silently corrupt | packed / temporary | High | High | The registry is persistent and written at onboarding |
| R3 | Normalized TTL extension exceeds the 100-entry footprint for incidents with about 97 or more responders, so some entries miss extension and are archived | normalized / persistent | Medium: plausible in a large disaster | Medium: archived persistent entries can be restored, at a cost | N/A for the chosen option; would need chunked extension otherwise |
| R4 | Persistent entries are archived when a keeper misses extension windows | Both persistent | Medium | Medium: restore fee plus delay while restoring | A keeper job extends at 50% of remaining TTL; with packed, one transaction per 32 incidents is enough |
| R5 | `AckAgg` hot-key contention serializes acknowledgements on the busiest incident | packed | High during peaks | Low to Medium: each acknowledgement is under 1.3M instructions, but a serialized cluster shares one core per ledger | Shard `AckAgg` (decision 2) |
| R6 | The indexer misses `ack` events, so individual signatures are unavailable | packed | Low | Medium | Commitment chain on-chain lets any indexer be re-verified; events are kept by RPC retention plus archive nodes |
| R7 | A bug in the fixed-offset packed codec (unlike self-describing XDR) makes upgrades harder | packed | Medium | Medium | Version byte in reserved slot bytes 2–3; round-trip unit tests cover extreme values (`pack_roundtrip_preserves_extremes`) |
| R8 | Live network rent settings diverge from the benchmark's assumptions | All | Medium | Low: all options scale together | Re-run the benchmark with live settings before mainnet |

## Consequences

- An event indexer becomes a required part of the system, not optional.
- A responder onboarding transaction is added to the product flow before a responder's first acknowledgement.
- Reads of individual signatures go through the indexer; the contract only exposes aggregates (count, stake total, commitment).
- The prototype contract is discarded. The production vault reuses its codec and layout constants.

## Reproduce

```bash
cd contracts/emergency_vault
cargo build --target wasm32v1-none --release
cargo test --release                                    # correctness (6 tests)
cargo test --release storage_bench -- --ignored --nocapture
# report also written to target/spike-601-report.md
```
