# Agent route extraction inventory

Task 5.1 inventory of `server/modules/agent/agent.routes.ts` before any route
extraction. Line numbers describe the 1,301-line baseline and should be updated
if earlier task edits move the source.

## Dependency inventory

| Current lines | Dependency | Current consumers | Target owner |
| --- | --- | --- | --- |
| 10-14, 34-37 | filesystem, crypto, home directory, process spawn | checkout resolution, Git commands, clone, cleanup | Agent application services |
| 15-18, 38-41 | platform flag, users, API keys, GitHub tokens | authentication and GitHub workflow | Auth stays route middleware; token lookup becomes an application port |
| 19, 42 | project repository | resolved checkout registration | Agent application service |
| 20, 43 | provider model service | Codex/OpenCode/Pi default model lookup | Generic dispatcher input preparation |
| 21-25, 44-48 | five provider-specific run functions | provider `if/else` at 987-1043 | Remove in 5.4; replace with one generic runtime dependency |
| 26, 49 | Octokit constructor | branch/PR workflow | GitHub application adapter |
| 2-8 | path, Express, shared path normalization | transport parsing and project-path normalization | Route plus application service |

The task-required dependency-injection range at baseline lines 21-25 is fully
covered above: `queryClaude`, `queryCursor`, `queryCodex`, `queryOpenCode`, and
`queryPi` are duplicate forms of one provider runtime dependency.

## Orchestration fragments

| Current lines | Fragment and dependencies | Observable behavior to preserve | Extraction target |
| --- | --- | --- | --- |
| 52-95 | External API authentication; platform/users/API-key dependencies | Platform default user, API key from header/query, 401/500 responses | Keep as thin typed route middleware |
| 97-132 | Read Git remote; spawn + cwd | Collect stdout/stderr and reject on nonzero/error | Git application adapter |
| 134-165 | Normalize and parse GitHub URL | HTTPS/SSH equivalence and owner/repo parsing | GitHub workflow service |
| 167-214 | Generate branch name | sanitized <=50-character timestamped fallback | GitHub workflow service |
| 216-252 | Validate branch name | exact Git-invalid-pattern errors | GitHub workflow service |
| 254-291 | Read recent commit subjects; spawn + cwd | ordered non-empty subjects or command failure | Git application adapter |
| 293-330 | Create pull request; Octokit | PR number/URL and fixed base input | GitHub workflow service through a GitHub port |
| 332-434 | Resolve/reuse/clone GitHub checkout; fs + spawn + token | strict `https://github.com`, no credentials in argv/remote, reuse matching checkout, shallow clone | Project checkout service |
| 436-476 | Cleanup cloned project/session; fs + home | canonical containment below external-project root; best-effort session cleanup | Project checkout service |
| 478-513 | SSE writer | SSE framing, writable-ended guard, session-id signal, done event | 5.3 transport adapter |
| 515-633 | Non-streaming collector | event collection, session id, legacy assistant filtering, token summary | HTTP response transport adapter |
| 878-910 | Request parsing and validation | boolean coercion, effort trim, required project/message, provider validation, branch/PR prerequisites | Typed route DTO parser; registry-backed provider validation |
| 911-954 | Select checkout and register project; crypto/path/fs/Git/project repository | generated clone path, existing-path access check, normalized final path, active-conflict tolerance | Agent application service |
| 955-981 | Choose writer and send initial status | correct SSE headers or response collector; initial project status | 5.3 transport factory |
| 983-1043 | Resolve defaults and dispatch provider | provider-specific options/default models and one selected run | 5.4 generic coordinator dispatcher |
| 1045-1224 | Post-run branch/PR workflow; token/Git/Octokit/writer | token requirement, remote discovery, branch create-or-checkout, push, PR title/body, non-fatal GitHub error event/data | Agent application service + Git/GitHub ports |
| 1226-1252 | Complete streaming/non-streaming response | SSE done or JSON session/messages/tokens/project/branch/PR | Thin route transport response |
| 1254-1261 | Deferred cleanup after success | only delete a checkout created by this request; preserve reused/existing paths | Agent application service cleanup policy |
| 1263-1297 | Failure cleanup and transport error | owned-checkout cleanup, SSE error+done, JSON 500 before headers | Application error result + thin route translation |

The task-required dispatch range at baseline lines 987-1035 is covered by the
983-1043 row, including the Pi model lookup that extends through line 1042.

## Proposed 5.2 boundary

The application layer should accept a typed request and transport-neutral event
writer, then return a typed result describing the resolved project, session,
and optional GitHub artifacts. It owns checkout resolution/registration,
post-run GitHub orchestration, and cleanup policy. Its injected ports are:

- filesystem/path environment and process runner for Git operations;
- project registration and GitHub-token readers;
- GitHub client factory;
- provider model/runtime dispatcher (temporarily provider-specific until 5.4).

The route should retain only authentication, request parsing, transport writer
selection, application-service invocation, and HTTP/SSE response translation.
SSE abort lifecycle and terminal ownership are deferred to 5.3. Replacement of
the five provider runners and the `provider === '<id>'` tree is deferred to 5.4.

## Extraction order

1. Introduce typed application request/result contracts and unit-test checkout,
   GitHub workflow, and cleanup behavior outside Express.
2. Move the non-dispatch helpers and post-run orchestration into the application
   service while retaining the existing five runner dependencies temporarily.
3. Move SSE/collector implementations behind transport adapters and connect the
   coordinator-owned abort path in 5.3.
4. Replace provider model/default branches and five runners with the generic
   dispatcher in 5.4.
5. Type the remaining route DTO/middleware and remove `@ts-nocheck` in 5.5.
