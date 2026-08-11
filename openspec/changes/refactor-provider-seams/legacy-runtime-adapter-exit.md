# Legacy runtime adapter exit tracking

OpenSpec task 4.6 treats `LegacyProviderRuntimeAdapter` as a temporary bridge,
not part of the target provider architecture. The repository's backend module
standard requires TypeScript under `server/modules/`, while these four staged
runtimes still expose the pre-refactor JavaScript contract.

## Migration checklist

- [ ] Claude JavaScript runtime -> TypeScript runtime implementing `IProviderRuntime` directly.
- [ ] Codex JavaScript runtime -> TypeScript runtime implementing `IProviderRuntime` directly.
- [ ] Cursor JavaScript runtime -> TypeScript runtime implementing `IProviderRuntime` directly.
- [ ] OpenCode JavaScript runtime -> TypeScript runtime implementing `IProviderRuntime` directly.

Each migration must preserve its characterization baseline, move cancellation
to the supplied `AbortSignal`, emit only typed non-terminal events through
`IProviderEventSink`, and return a shared `ProviderRunOutcome`. A migrated
runtime must not retain a public `abort(sessionId)` entry point or produce
`complete` / `session_created` itself.

## Unified exit condition

When all four runtimes are TypeScript and implement `IProviderRuntime` directly,
delete `LegacyProviderRuntimeAdapter`, remove its registration wrappers and
adapter-specific tests, and keep the coordinator contract tests as the common
 lifecycle gate. Do not remove the adapter while any checklist item remains.
