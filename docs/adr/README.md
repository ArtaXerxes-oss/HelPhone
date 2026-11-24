# Architecture Decision Records

Each ADR records one architecture decision: its context, the options considered, the evidence and the consequences. ADRs produced by time-boxed feasibility spikes link to the spike report and raw benchmark data in [`docs/spikes/`](../spikes/README.md).

| ADR                                              | Title                                                                       | Status   | Spike                  |
| ------------------------------------------------ | --------------------------------------------------------------------------- | -------- | ---------------------- |
| [ADR-004](ADR-004-offgrid-map-sync.md)           | Off-Grid Incident Map Synchronization: State Vector Pruning vs OT Snapshots | Proposed | #604                   |
| [ADR-005](ADR-005-zk-proof-aggregation.md)       | Client-Side ZK Proof Aggregation Feasibility & Resource Allocation Limits   | Proposed | #605                   |
| [ADR-006](ADR-006-offline-routing.md)            | Offline Client-Side Routing Algorithm & Vector Data Format Selection        | Proposed | #606                   |
| [ADR-007](ADR-007-offline-storage.md)            | High-Throughput Offline Client Storage: IndexedDB vs OPFS SQLite WASM       | Proposed | #607                   |
| [ADR-014](ADR-014-telemetry-binary-frames.md)    | Binary Telemetry Frames for the Live Map                                    | Accepted | ADR-014 follow-ups 2–3 |
| [ADR-022](ADR-022-eta-ranges-and-calibration.md) | Bounded ETA Ranges, Degraded Display and Calibration                        | Accepted | ADR-022 follow-up      |

ADR-001 to ADR-003 are not in this directory.

**Status values:** _Proposed_ (evidence gathered, awaiting maintainer sign-off), _Accepted_, _Superseded by ADR-NNN_.
