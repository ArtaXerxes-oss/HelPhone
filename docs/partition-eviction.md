# Partition eviction policy

Set `DB_PARTITION_EVICTION_ENABLED=true` to run eviction from the existing
off-peak database maintenance scheduler. The default retention is 90 days;
`DB_PARTITION_RETENTION_DAYS` changes it. Set
`DB_PARTITION_EVICTION_DRY_RUN=true` to report exact candidates without changes.

Active rows in `legal_holds` always exclude the matching partition. Eviction
detaches a partition instead of dropping it and records its parent and bounds
in `retention_manifest`. It can be reattached during
`DB_PARTITION_REVERSAL_DAYS` (default 7 days); after that window operators may
archive or remove the detached table under the applicable legal policy.
