# CRDT architecture

HelPhone uses an LWW-element-set for offline help state. Each operation carries
an actor counter (vector-clock component) and a wall-clock timestamp. Timestamp,
counter, then actor ID form a total deterministic order, so out-of-order replay
converges.

Ten thousand simulated mutations are retained until peers acknowledge them.
The element set exposes its encoded storage size rather than claiming an
engine-specific IndexedDB allocation. Once every active replica's state vector
passes an operation, superseded operations may be pruned. Delete tombstones are
removed only at that causal-stability frontier. Devices retired from the roster
must receive a fresh snapshot if they later return.

Periodic sync posts operations to /api/sync. Production persistence should put
operations in an IndexedDB store keyed by actor:counter and compact in a single
transaction after server acknowledgement.
