# Async resource remediation

This remediation keeps bounded streaming and exact process ownership as its primary invariants.

- `process-tree.ts` tracks PID, executable image, and spawn time. Windows after-exit tree kills require CIM image and creation-time verification; POSIX process groups are signaled even after the root exits.
- `ndjson-assembler.ts` retains only partial frames and joins each completed frame at most once. Web output uses streaming UTF-8 decoding and stops retaining data after terminal failure.
- ACP disposal is memoized, bounded, and always destroys owned stdio. MCP exit cleanup uses a process-global same-key registry, settled approvals expire after 10 minutes, and pre-aborted calls never register provider round trips.

## Reference patterns and attribution

The following MIT-licensed reference projects informed the patterns reimplemented here. No parser or process-kill code was copied; the respective upstream projects retain their copyrights and MIT licenses.

- [3d24rd0/antigravity-bridge](https://github.com/3d24rd0/antigravity-bridge): process-cleanup registry and settled-park sweep.
- [ackneal/pi-agy-bridge](https://github.com/ackneal/pi-agy-bridge): idempotent bounded disposal and pre-aborted-call guard.

The local implementation deliberately keeps its stronger PID identity checks and incremental NDJSON framing. It does **not** adopt the references' quadratic full-buffer parsing or blind `taskkill` behavior.
