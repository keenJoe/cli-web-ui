# Provider characterization baseline (task 1.1 / R15)

Golden baselines of the **pre-refactor** observable behavior of the five
providers, recorded before any work in task groups 2–5 of the
`refactor-provider-seams` change.

## Rules

- Tests only. No production file may be edited to make a scenario reachable.
- No network, no real CLI, no real process spawn. Every fixture is fed through a
  dependency-injection seam that already exists in production code.
- Re-record with `UPDATE_GOLDEN=1`. Doing so is only legitimate for one of the
  three deliberate BREAKING changes listed in the proposal, and the diff must be
  called out in the commit message.

```bash
TSX_TSCONFIG_PATH=server/tsconfig.json \
  node --import tsx --test "server/modules/providers/tests/characterization/*.test.ts"
```

## Injection point per provider

| Provider | Seam | Spawns? |
|---|---|---|
| claude | `ClaudeSessionsProvider.normalizeMessage` (= `context.normalizeMessage` at `claude-runtime.provider.js:680`); `ClaudeSessionsProvider.fetchHistory` against a throwaway `DATABASE_PATH` sessions row; `claudeRuntime.run(..., context)` with a rejecting `resolveResumeModel`; `claudeRuntime.abort` | no |
| codex | `CodexSessionsProvider.normalizeMessage` (`codex-runtime.provider.js:348`); `CodexSessionsProvider.fetchHistory` against a throwaway `DATABASE_PATH` sessions row; `codexRuntime.run(..., context)`; `codexRuntime.abort` | no |
| cursor | `CursorSessionsProvider.normalizeMessage` (`cursor-runtime.provider.js:223,250`); `CursorSessionsProvider.normalizeCursorBlobs`; `cursorRuntime.run(..., context)` suspended at `resolveResumeModel`; `cursorRuntime.abort` | no |
| opencode | `OpenCodeSessionsProvider.normalizeMessage` (`opencode-runtime.provider.js:234`); `fetchHistory` against a temp SQLite file via a temp `HOME`; `opencodeRuntime.run(..., context)`; `opencodeRuntime.abort` | no |
| pi | `ProviderRunCoordinator` + typed `createPiRuntime({ createRpcClient })` with a stub RPC client; `PiSessionsProvider.fetchHistory` via `PI_CODING_AGENT_SESSION_DIR` | no |
| all | `createProviderTokenUsageService(deps)` — injected session row, filesystem and database path | no |

`claude` and `codex` resolve their transcript file through
`sessionsDb.getSessionById`. `resolveDatabasePath()`
(`database/connection.ts:37`) reads `DATABASE_PATH` on every reconnect, so
`withIsolatedSessionsDatabase()` repoints it at a `mkdtemp` directory — the same
pattern `database/tests/sessions-provider-mapping.test.ts` already uses. The
real `~/.cloudcli/auth.db` and the repo's `database/auth.db` are never touched.

## Coverage matrix

`✅` recorded as a golden · `⛔` unreachable without editing production code.

| Scenario | claude | codex | cursor | opencode | pi |
|---|---|---|---|---|---|
| live event | ✅ normalizer | ✅ normalizer | ✅ normalizer | ✅ normalizer | ✅ full runtime |
| resume | ✅ pre-query | ✅ pre-thread | ✅ pre-spawn | ✅ id resolution | ✅ full runtime |
| abort | ⚠️ partial | ⚠️ partial | ⚠️ partial | ⚠️ partial | ✅ full runtime |
| history | ✅ `fetchHistory` | ✅ `fetchHistory` | ✅ blob normalizer | ✅ `fetchHistory` | ✅ `fetchHistory` |
| usage | ✅ | ✅ | ✅ | ✅ | ✅ |
| replay | ✅ | ✅ | ✅ | ✅ | ✅ |
| *(extra)* live run timeline | ⛔ | ⛔ | ⛔ | ⛔ | ✅ |
| *(extra)* runtime failure terminal | ✅ | ✅ | ⛔ | ✅ | ✅ `onClose` |

The `resume` row records what happens **before** the SDK query / CLI argv is
built. The four legacy runtimes call `resolveProviderSessionId` with the app
session id and use its result as the resume handle. Pi receives that resolved
identity as typed `request.providerSessionId` and never resolves or substitutes
the app id inside its runtime. No provider re-announces `session_created` for a
known native identity. For codex and cursor the run is frozen before any
emission, so their `sessionCreatedEvents: 0` records the state **at the freeze
point only**, not a whole-run guarantee; the effective lock there is the
`contextCalls` order and arguments. Claude's and Pi's
`sessionCreatedEvents: 0` is asserted against a non-empty event stream.

## Pi typed-runtime compatibility projection

The Pi golden files predate `ProviderRunCoordinator` and therefore record the
old raw runtime boundary: `settled/sessionId`, native ids in event envelopes,
and a provider-produced terminal. The characterization now executes the real
typed path through the coordinator. Only at comparison time, a Pi-local helper
projects the typed outcome and coordinator-owned identity envelope back to that
historical shape. It does not add, remove, reorder, or deduplicate events, so
the existing fixtures still lock event content/order and exactly one terminal
without being re-recorded. Production output is never passed through this
projection.

## Known gaps

### `abort` only locks the unknown-session branch (claude / codex / cursor / opencode)

`claude.abort.json`, `codex.abort.json`, `cursor.abort.json` and
`opencode.abort.json` contain only `{"abortUnknownSession": false}` — the
`return false` at the bottom of each abort function. The real abort semantics
are **not** under baseline protection:

- `abortedSessionIds.add(sessionId)` terminal-state preemption
  (`claude-runtime.provider.js:768`);
- `process.aborted = true` suppressing the second `complete`
  (`cursor-runtime.provider.js:359`);
- `session.status = 'aborted'` / `completeSent` bookkeeping.

Reason: the active-session maps (`activeSessions`, `activeCursorProcesses`,
`activeOpenCodeProcesses`, `activeCodexSessions`) are module-private with no
write seam, and populating them requires a real spawn.

**Consequence for task 4.4**: removing this bookkeeping will **not** turn any
characterization test red. Do not read a green suite as proof that the removal
was safe — rely on R11/R12 (coordinator terminal-state tests) and the 7.3 smoke
run instead.

### Live run timelines (claude / codex / cursor / opencode)

| Provider | Why |
|---|---|
| claude | `query()` is a module-level import from `@anthropic-ai/claude-agent-sdk`; there is no factory seam, so a run cannot be started without a real SDK query. |
| codex | `new Codex()` is constructed from a module-level import; `thread.runStreamed()` launches the real Codex process. `transformCodexEvent` is not exported, so the native→transformed step is not covered — live fixtures start at the transformed shape. |
| cursor | `cross-spawn` is a module-level import used directly as `spawnFunction`. |
| opencode | `cross-spawn` is a module-level import. The existing `opencode-runtime.provider.test.js` covers this by putting a fake executable on `PATH`, which is a real process spawn and therefore out of bounds for this baseline. |

### Cursor runtime failure terminal

`spawnCursor` wraps an `async` function in a `new Promise` executor
(`cursor-runtime.provider.js:33`) and awaits `context.resolveResumeModel` inside
it (`:48`). A rejection there escapes as an unhandled rejection and the run
promise **never settles**, so exercising the failure path would hang or kill the
test process. `cursor.resume` therefore suspends `resolveResumeModel` on a
never-resolving promise instead of rejecting, and asserts without awaiting the
run. This is a production defect, not a test limitation — it is recorded as a
prerequisite finding on task 4.4 in `tasks.md`.

These gaps are exactly what task group 4 (`ProviderRunCoordinator` +
`LegacyProviderRuntimeAdapter`) is meant to close. Pi now implements the typed
interface directly; the remaining four runtimes retain their constrained
legacy baselines until their tracked JavaScript-to-TypeScript migrations remove
the adapter.
