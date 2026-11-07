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

A deadline must bound a hung agy without killing legitimate long work such as a long test run, so the policy follows what each clock actually measures (`src/driver.ts`, `src/provider.ts`):

| Setting | Value | Meaning |
| --- | --- | --- |
| `turnTimeoutMin` (env `AGY_TURN_TIMEOUT_MIN`) | `0` (no cap) | The package default on an interactive pi: you are the backstop with Esc. Leave the key out to get the headless default of `20`, where nobody can abort. |
| `inactivityTimeoutMin` (env `AGY_INACTIVITY_TIMEOUT_MIN`) | `30` | Silence cap: no stream output for this long fails the turn as a stall. Generous on purpose so a long agy-native command is not cut off while a hung agy is still detected. The package default is `5`; keep it above the longest silent native step. |

What each clock counts:

- **pi tools through the bridge** (for example a pytest or build run by pi's shell tool): both clocks stay paused from the moment the call parks until pi returns its result, including while the model polls `bridge_poll_result`. The bridge waits at most 30 minutes (`ESCALATED_TIMEOUT_MS`) for one such call; after that the call is reported as failed to the model, the pi tool itself keeps running, and its late result is re-delivered.
- **agy-native commands** (`run_command` inside the agy process): neither clock pauses. They count toward the turn cap and, because agy prints nothing while they run, toward the silence cap. That is why the silence cap is not small.

Both live in `~/.pi/agent/antigravity-bridge/config.json`; the environment variables win over the file and a change applies from the next turn. `0` disables a cap, which is the interactive default for the turn cap.