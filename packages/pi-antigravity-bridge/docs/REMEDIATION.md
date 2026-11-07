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

## Startup cost

Sources import their siblings with `.ts` specifiers. pi loads this package through jiti, which probes a `./x.js` specifier on disk (a failed `stat` plus a thrown `NodeError`) before it falls back to `./x.ts`; 108 such imports cost several hundred milliseconds on every pi start and reload. `allowImportingTsExtensions` is enabled for the repository's `noEmit` typecheck. Behavior is unchanged: package-wide test results differ from the committed baseline only in the known non-hermetic driver fixtures that can resolve a real `agy.exe`.

## Turn deadline policy

An agy turn must always end. The policy used with this fork:

| Setting | Value | Meaning |
| --- | --- | --- |
| `turnTimeoutMin` (env `AGY_TURN_TIMEOUT_MIN`) | `30` | Cap on one turn's **active** agy time. Parked time (pi-tool round trips, escalated calls, human-gated approvals) does not count against it. |
| `inactivityTimeoutMin` (env `AGY_INACTIVITY_TIMEOUT_MIN`) | `3` | Silence cap: no stream output for this long fails the turn as a stall. |

Both live in `~/.pi/agent/antigravity-bridge/config.json`; the environment variables win over the file. `0` disables a cap and is deliberately not part of this policy.