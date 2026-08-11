# Providers Module Guide

This file documents the current provider contract in `server/modules/providers`.
Keep it current whenever provider wiring, skill discovery, or session sync
behavior changes. The goal is that a human or AI agent can add a new provider
without guessing which files need to move.

## Current Provider Shape

Every registered provider exposes the required `runtime`, `models`, `auth`,
`sessions`, and `sessionSynchronizer` facets plus a static `descriptor`.
Providers attach `mcp`, `skills`, and `usage` only when they actually support
those capabilities. Missing optional facets are reported as
`PROVIDER_CAPABILITY_UNSUPPORTED`; they must not be represented by empty-success
implementations.

The facets correspond to the shared interfaces in
`server/shared/interfaces.ts`:

- `IProviderRuntime`
- `IProviderModels`
- `IProviderAuth`
- `IProviderMcp`
- `IProviderSkills`
- `IProviderUsage`
- `IProviderSessions`
- `IProviderSessionSynchronizer`

The services that consume them are:

- `providerModelsService`
- `providerAuthService`
- `providerMcpService`
- `providerSkillsService`
- `providerTokenUsageService`
- `sessionsService`
- `sessionSynchronizerService`

Live execution is consumed through `providerRuntimeService`, which resolves the
provider-owned runtime through the same `providerRegistry` as every other facet.

Current provider ids in this repo are:

- `claude`
- `codex`
- `cursor`
- `opencode`
- `pi`

Provider behavior is discovered through `providerRegistry`; application
services must not maintain a second provider-id capability matrix.

## Current File Layout

Each provider lives under its own folder in `server/modules/providers/list/`:

```text
server/modules/providers/list/<provider>/
  <provider>.provider.ts
  <provider>-runtime.provider.ts
  <provider>-auth.provider.ts
  <provider>-models.provider.ts
  <provider>-mcp.provider.ts
  <provider>-skills.provider.ts
  <provider>-sessions.provider.ts
  <provider>-session-synchronizer.provider.ts
```

The existing provider folders are `claude`, `codex`, `cursor`, `opencode`, and
`pi`. Claude, Codex, Cursor, and OpenCode still have JavaScript runtimes behind
the temporary `LegacyProviderRuntimeAdapter`; their finite migration and
adapter deletion condition is tracked in
`openspec/changes/refactor-provider-seams/legacy-runtime-adapter-exit.md`. Pi
implements the typed runtime contract directly.

Each provider wrapper owns its SDK/CLI runtime alongside its auth, model, and
session facets. Runtime adapters receive registry-backed model and session
lookups from `providerRuntimeService` at execution time instead of importing
those services themselves. This keeps `providerRegistry` as the only provider
mapping without creating a circular dependency. Application-level consumers
import the service from `server/modules/providers/index.ts`.

## What Each Facet Does

| Facet | Responsibility | Base / Service |
| --- | --- | --- |
| `runtime` | Emit non-terminal live events and return a typed run outcome | `IProviderRuntime` -> `ProviderRunCoordinator` |
| `models` | Resolve supported and active models | `IProviderModels` -> `providerModelsService` |
| `auth` | Report install/auth state for the provider runtime | `IProviderAuth` -> `providerAuthService` |
| `mcp` | Read, list, write, and remove provider-native MCP config | `McpProvider` -> `providerMcpService` |
| `skills` | Discover provider-native skill markdown files | `SkillsProvider` -> `providerSkillsService` |
| `usage` | Calculate provider-native token usage when supported | `IProviderUsage` -> `providerTokenUsageService` |
| `sessions` | Normalize live events and fetch session history | `IProviderSessions` -> `sessionsService` |
| `sessionSynchronizer` | Scan transcript artifacts and upsert session metadata | `IProviderSessionSynchronizer` -> `sessionSynchronizerService` |

`sessions` and `sessionSynchronizer` are separate concerns:

- `sessions` handles runtime event normalization and history fetches.
- `sessionSynchronizer` handles file-backed session indexing into `sessionsDb`.

## Live Runtime Contract

`providerRuntimeService` projects compatibility callers into a
`ProviderRunRequest` and starts the run through `ProviderRunCoordinator`. The
coordinator owns the generated run id, app/native identity binding,
`AbortController`, active-run exclusion, and the single `complete` terminal.
It supplies an `IProviderEventSink` that can express only non-terminal events.

A direct typed runtime must:

- resume only `request.providerSessionId`, never infer a native id from
  `request.appSessionId`;
- call `sink.bindProviderSession(...)` before its first live event when a new
  native identity is discovered;
- call `sink.emit(...)` only for non-terminal events;
- observe the supplied `AbortSignal` and keep lifecycle state local to that run;
- return one shared `ProviderRunOutcome` without sending `complete` or
  `session_created`.

The four legacy JavaScript runtimes are translated by
`LegacyProviderRuntimeAdapter`. That adapter intercepts their legacy terminal
messages and bridges cancellation during the staged TypeScript migration. New
runtimes must implement `IProviderRuntime` directly and must not use the legacy
adapter.

## How To Add A Provider

1. Add the provider at the three central integration points.

- Add the id to `server/shared/types.ts` `LLMProvider`.
- Import and register the provider definition in
  `server/modules/providers/provider.registry.ts`.
- Add its display metadata, logo, and setup copy to
  `src/components/llm-logo-provider/providerBranding.tsx`; the frontend
  `LLMProvider` type is derived from this map.

These are the only central files for a normal provider addition. Provider
routes, capability/usage/MCP services, watcher/synchronizer orchestration,
Agent dispatch, `AbstractProvider`, and `server/index.ts` resolve providers and
facets generically and must not gain provider-id branches.

2. Create the wrapper class.

- Add `server/modules/providers/list/<provider>/<provider>.provider.ts`.
- Add a TypeScript runtime under
  `server/modules/providers/list/<provider>/<provider>-runtime.provider.ts`.
- Extend `AbstractProvider`.
- Expose required `descriptor`, `runtime`, `models`, `auth`, `sessions`, and
  `sessionSynchronizer` facets.
- Expose `mcp`, `skills`, and `usage` only when the provider supports them; do
  not add empty adapters that return successful empty results.
- Implement `IProviderRuntime` directly. `LegacyProviderRuntimeAdapter` exists
  only for the four pre-existing JavaScript runtimes and is not an extension
  point for new providers.
- Call `super('<provider>')`.

3. Implement auth.

- Return a full `ProviderAuthStatus`.
- Treat normal `not installed` / `not authenticated` states as data, not exceptions.
- Keep provider-specific credential discovery inside the auth provider.
- If the provider has no auth step, return a stable unauthenticated or not-installed status instead of omitting the facet.

4. Implement MCP when supported.

- Extend `McpProvider`.
- Pass the supported scopes and transports to `super(...)`.
- Implement the four required methods:
  - `readScopedServers(...)`
  - `writeScopedServers(...)`
  - `buildServerConfig(...)`
  - `normalizeServerConfig(...)`
- Use the shared validation and normalization behavior from `McpProvider`.
- Keep the provider-specific config format local to the provider implementation.
- If MCP is unsupported, omit the facet; `ProviderRegistry.requireFacet`
  returns `PROVIDER_CAPABILITY_UNSUPPORTED` for provider-specific requests and
  aggregate reads skip that provider.

Current MCP formats in this repo are:

| Provider | User / Project Storage | Supported Scopes | Supported Transports |
| --- | --- | --- | --- |
| Claude | `.mcp.json` in user / local / project locations | `user`, `local`, `project` | `stdio`, `http`, `sse` |
| Codex | `.codex/config.toml` | `user`, `project` | `stdio`, `http` |
| Cursor | `.cursor/mcp.json` | `user`, `project` | `stdio`, `http` |
| OpenCode | `~/.config/opencode/opencode.json` or `<workspace>/opencode.json` (`.jsonc` is read when present) | `user`, `project` | `stdio`, `http` |

5. Implement skills when supported.

- Extend `SkillsProvider`.
- Implement `getSkillSources(workspacePath)`.
- Return the actual discovery roots for the provider.
- Skills are discovered from `SKILL.md` files.
- `readProviderSkillMarkdownDefinition(...)` reads front matter `name` and `description`.
- If `name` is missing, the parent directory name is used as a fallback.
- Use `recursive: true` only when the provider stores skills in nested trees.
- Keep the emitted `command` string aligned with the provider's real skill syntax.
- If skills are unsupported, omit the facet instead of adding an empty implementation.

Current skill discovery roots are:

| Provider | User Roots | Project / Repo Roots | Prefix | Notes |
| --- | --- | --- | --- | --- |
| Claude | `~/.claude/skills` | `<workspace>/.claude/skills` | `/` | Also discovers Claude plugin skills from enabled plugin installs. Command skills live under `commands/`; markdown skills live under `skills/` and are scanned recursively. |
| Codex | `~/.agents/skills`, `~/.codex/skills/.system`, `/etc/codex/skills` | `<workspace>/.agents/skills`, `path.dirname(workspacePath)/.agents/skills`, topmost git root `.agents/skills` | `$` | Overlapping roots are deduplicated before scanning. |
| Cursor | `~/.cursor/skills` | `<workspace>/.cursor/skills`, `<workspace>/.agents/skills` | `/` | Uses slash-style commands. |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | Cwd-to-topmost-git-root `.opencode/skills`, `.claude/skills`, and `.agents/skills` | `/` | Reuses OpenCode, Claude, and Agents skill locations. Overlapping roots are deduplicated before scanning. |

Command forms currently used by the providers are:

- Claude user/project skills: `/skill-name`
- Claude plugin skills: `/plugin-name:skill-name`
- Codex skills: `$skill-name`
- Cursor skills: `/skill-name`
- OpenCode skills: `/skill-name`

6. Implement sessions.

- Implement `normalizeMessage(raw, sessionId)` and `fetchHistory(sessionId, options)`.
- Use `createNormalizedMessage(...)` and `generateMessageId(...)` for emitted messages.
- Keep normalized message ids unique. If one raw event produces multiple text
  parts, append a discriminator so ids do not collide.
- Keep pagination consistent:
  - `limit: null` means unbounded/full history.
  - `limit: 0` means an empty page.
  - always return `total`, `hasMore`, `offset`, and `limit` when paginating.
- Sanitize any filesystem-derived ids before using them in file or database paths.
- Do not assume a provider's history format matches another provider's format.

7. Implement session synchronization.

- Implement `synchronize(since?: Date)` to scan provider artifacts and upsert
  sessions into `sessionsDb`.
- Implement `synchronizeFile(filePath)` for single-file watcher updates.
- Use the existing helpers when they fit:
  - `buildLookupMap(...)`
  - `extractFirstValidJsonlData(...)`
  - `findFilesRecursivelyCreatedAfter(...)`
  - `normalizeSessionName(...)`
  - `readFileTimestamps(...)`
- Make the sync resilient to partial, malformed, or missing provider files.
- Implement `getWatchRoots()` so the watcher discovers storage paths through
  the provider facet rather than a central path table.
- The orchestration service maintains an independent `provider_scan_state`
  cursor and advances it only when that provider succeeds; one provider's
  failure does not block the others.

Current session sync roots are:

| Provider | Scan Roots | Metadata Helpers / Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Uses `~/.claude/history.jsonl` for name lookup and the trailing `ai-title`, `last-prompt`, or `custom-title` entries for title recovery. |
| Codex | `~/.codex/sessions/**/*.jsonl` | Uses `~/.codex/session_index.jsonl` for title lookup and the last `task_complete` message for a fallback title. |
| Cursor | `~/.cursor/projects/**/*.jsonl` | Uses sibling `worker.log` to recover `workspacePath`, then derives the session title from the first user prompt. |
| OpenCode | `~/.local/share/opencode/opencode.db` | Reads active sessions/messages/parts from OpenCode's shared SQLite database and stores `jsonl_path` as `null` so deleting one app session cannot remove the shared DB. |

8. Register the provider.

- Add the new provider class to `server/modules/providers/provider.registry.ts`.
- Supply a valid descriptor whose `defaultPermissionMode` occurs in
  `permissionModes`; invalid definitions fail during registry construction.
- Do not update provider routes, Agent routes, capability services, watcher
  services, or the server assembly root. They resolve the registered definition
  and its facets generically.

9. Verify generic runtime and UI discovery.

- The provider's local model facet owns its catalog and omitted-model policy;
  do not add frontend or Agent model fallback matrices.
- The descriptor and optional facet presence drive capabilities, permission,
  effort, MCP, skills, and usage surfaces without provider-specific UI branches.
- The branding map from step 1 supplies the remaining static UI assets and copy.
- A need to edit another central dispatcher or service means the provider is
  introducing a new public contract and should be reviewed as an architecture
  change, not treated as normal provider onboarding.

## Minimal Wrapper Template

```ts
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { <Provider>ProviderAuth } from './<provider>-auth.provider.js';
import { <Provider>ProviderModels } from './<provider>-models.provider.js';
import { <Provider>Runtime } from './<provider>-runtime.provider.js';
import { <Provider>SessionsProvider } from './<provider>-sessions.provider.js';
import { <Provider>SessionSynchronizer } from './<provider>-session-synchronizer.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  ProviderDescriptor,
} from '@/shared/interfaces.js';

export class <Provider>Provider extends AbstractProvider {
  readonly descriptor: ProviderDescriptor = {
    permissionModes: ['default'],
    defaultPermissionMode: 'default',
    supportsImages: false,
    supportsFiles: false,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsEffort: false,
  };
  readonly runtime: IProviderRuntime = new <Provider>Runtime();
  readonly models: IProviderModels = new <Provider>ProviderModels();
  readonly auth: IProviderAuth = new <Provider>ProviderAuth();
  readonly sessions: IProviderSessions = new <Provider>SessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer =
    new <Provider>SessionSynchronizer();

  // Add mcp, skills, or usage only when the provider supports that facet.

  constructor() {
    super('<provider>');
  }
}
```

## Minimal Skills Template

```ts
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class <Provider>SkillsProvider extends SkillsProvider {
  constructor() {
    super('<provider>');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.<provider>', 'skills'),
        commandPrefix: '/',
      },
    ];
  }
}
```

## Minimal Session Sync Template

```ts
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

export class <Provider>SessionSynchronizer implements IProviderSessionSynchronizer {
  getWatchRoots(): string[] {
    return [];
  }

  async synchronize(since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    return null;
  }
}
```

## AI Prompt Template

Use this prompt when asking an AI agent to add a provider:

```text
Add a new provider "<provider>" using the current provider module architecture.

Requirements:
1) Create:
   - server/modules/providers/list/<provider>/<provider>.provider.ts
   - server/modules/providers/list/<provider>/<provider>-runtime.provider.ts
   - server/modules/providers/list/<provider>/<provider>-auth.provider.ts
   - server/modules/providers/list/<provider>/<provider>-models.provider.ts
   - server/modules/providers/list/<provider>/<provider>-sessions.provider.ts
   - server/modules/providers/list/<provider>/<provider>-session-synchronizer.provider.ts
   Create MCP, skills, and usage facet files only when supported.
2) Change exactly these central integration files:
   - server/shared/types.ts LLMProvider
   - server/modules/providers/provider.registry.ts
   - src/components/llm-logo-provider/providerBranding.tsx
   Do not add provider-id branches to routes, services, Agent dispatch, watcher,
   synchronizer orchestration, or server/index.ts.
3) Supply a valid ProviderDescriptor and implement IProviderRuntime directly;
   do not use LegacyProviderRuntimeAdapter for new providers.
4) Mirror the nearest existing provider implementation for file naming, style,
   and error handling, while keeping unsupported facets absent.
5) Implement session synchronization with getWatchRoots() and provider-owned
   scan behavior if the provider stores transcript files.
6) Ensure sessions use provider-qualified ids, safe path handling, and correct
   pagination.
7) Keep sessions and sessionSynchronizer separate.
8) Run the provider contract/characterization tests plus:
   - npx eslint <touched files>
   - npx tsc --noEmit -p server/tsconfig.json
```

## Validation

After adding or changing a provider, run the relevant checks:

```bash
npx eslint server/modules/providers/**/*.ts server/shared/types.ts server/shared/interfaces.ts
npx tsc --noEmit -p server/tsconfig.json
```

Useful tests in this repo:

- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/providers/tests/skills.test.ts`
- `server/modules/providers/tests/opencode-sessions.test.ts`

If you touch sessions or session synchronization, add or update focused tests
alongside the implementation.

## Common Mistakes

- Adding provider files but forgetting one of the three central points:
  backend `LLMProvider`, registry registration, or frontend branding.
- Adding a live runtime without exposing its typed facet from the provider wrapper.
- Adding provider-id branches to a route, capability service, watcher,
  synchronizer orchestrator, Agent dispatcher, or server assembly root.
- Omitting required `descriptor`, `runtime`, `models`, `auth`, `sessions`, or
  `sessionSynchronizer` facets from the wrapper.
- Publishing empty `mcp`, `skills`, or `usage` implementations instead of
  leaving unsupported optional facets absent.
- Returning duplicate normalized message ids for split content.
- Treating `limit === 0` as unbounded history.
- Building file paths from raw session ids without validation.
- Hardcoding a skill root without checking the provider's actual discovery rules.
- Forgetting that Claude plugin skills are discovered differently from normal
  user/project skill folders.
- Assuming one provider's MCP config file format works for the others.
