import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  GitStatusEvent,
  LLMProvider,
  McpScope,
  McpTransport,
  NormalizedMessage,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderAuthStatus,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderMcpServer,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRunEvent,
  ProviderRunOutcome,
  ProviderRunRequest,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------

/**
 * Non-terminal output port supplied to one typed provider runtime.
 *
 * `ProviderRunCoordinator` implements this port for every run. Native identity
 * must be bound before the first live event; the coordinator converts that
 * binding into the application-owned `session_created` event. The `emit` type
 * deliberately cannot express `complete` or `session_created`.
 */
export interface IProviderEventSink {
  bindProviderSession(binding: {
    providerSessionId: string;
    artifactPath?: string | null;
  }): void;
  emit(event: ProviderRunEvent): void;
}

/**
 * Typed live execution contract owned by each registered provider.
 *
 * `providerRuntimeService` dispatches this facet through
 * `ProviderRunCoordinator`. The coordinator owns cancellation and terminal
 * emission; concrete runtimes observe its signal, emit only non-terminal
 * events, and return one typed outcome.
 */
export interface IProviderRuntime {
  run(
    request: ProviderRunRequest,
    sink: IProviderEventSink,
    context: ProviderRuntimeContext,
    signal: AbortSignal,
  ): Promise<ProviderRunOutcome>;
  permissions?: ProviderRuntimePermissionGateway;
}

/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its required runtime, model, auth, session, and
 * synchronization facets. Providers may additionally expose MCP, skills, and
 * usage facets when those capabilities exist; native events/history remain
 * normalized behind the provider-owned contracts.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly runtime: IProviderRuntime;
  readonly models: IProviderModels;
  readonly mcp?: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills?: IProviderSkills;
  readonly usage?: IProviderUsage;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
}

/**
 * Provider-owned static capabilities that cannot be inferred from facets.
 *
 * Every registered provider supplies this descriptor next to its concrete
 * adapters. Capability responses expose these values directly, so services and
 * clients must not maintain provider-id fallback matrices.
 */
export type ProviderDescriptor = {
  /** Supported permission modes in the order presented by cycling controls. */
  readonly permissionModes: readonly string[];
  /** Initial permission mode; registration requires it to occur in `permissionModes`. */
  readonly defaultPermissionMode: string;
  /** Whether chat requests may carry image attachments. */
  readonly supportsImages: boolean;
  /** Whether chat requests may carry non-image file attachments. */
  readonly supportsFiles: boolean;
  /** Whether the runtime can abort an in-flight run. */
  readonly supportsAbort: boolean;
  /** Whether runtime permission prompts can be relayed to the application. */
  readonly supportsPermissionRequests: boolean;
  /** Whether the runtime accepts model-specific reasoning effort. */
  readonly supportsEffort: boolean;
};

/**
 * Complete registry entry implemented by each provider aggregate.
 *
 * `descriptor` owns static capabilities while optional facet presence owns
 * MCP, skills, and token-usage capability flags.
 */
export interface ProviderDefinition extends IProvider {
  readonly descriptor: ProviderDescriptor;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Provider model catalog with its cache identity.
 *
 * `fingerprint` keys the central models service cache: `hash(base_url +
 * credential_hash + model_provider + model)`, empty when no configuration
 * drives the result. `cacheable` is false only for fallbacks produced by a
 * failed configured API fetch, which must never enter the long-lived disk
 * cache. The facet owns how the fingerprint is computed (E17); the service
 * only keys on it.
 */
export type ProviderModelsCatalog = {
  models: ProviderModelsDefinition;
  /** hash(base_url + credential_hash + model_provider + model); '' = no configuration. */
  fingerprint: string;
  /** false = fallback from a failed configured API fetch, short-lived only. */
  cacheable: boolean;
};

/**
 * Model catalog contract for one provider.
 *
 * Implementations are responsible for resolving the provider's currently
 * supported models and converting them into the shared
 * `ProviderModelsDefinition` shape used by backend routes and frontend model
 * pickers. The `DEFAULT` field should be the most appropriate default selection
 * for that provider at the time the catalog is read.
 */
export interface IProviderModels {
  /**
   * Requests catalog-default injection when a run omits its model.
   *
   * Absence preserves the provider runtime or CLI's native default selection.
   * Agent dispatch reads this through `providerModelsService`; callers must not
   * infer the policy from provider ids or expose it as a UI capability.
   */
  readonly usesCatalogDefaultWhenModelOmitted?: true;

  /**
   * Returns the provider's currently supported model catalog together with the
   * cache identity the central models service keys its cache on.
   */
  getSupportedModels(): Promise<ProviderModelsCatalog>;

  /**
   * Computes the catalog cache fingerprint from provider configuration only,
   * without fetching the catalog.
   *
   * The central models service calls this before `getSupportedModels` so it
   * can look up the cache with the same key catalog writes use; absent (or
   * unconfigured providers returning `''`) keeps the key equivalent to the
   * provider-only key.
   */
  getCachedCatalogFingerprint?(): string;

  /**
   * Reads the model the provider itself believes one session is running with.
   *
   * Only consulted for sessions the app has never recorded a model for — a
   * session started directly in the provider CLI, for example. Selecting a
   * model in the app is persisted on the session row instead, so adapters here
   * are read-only and must fall back to the catalog default when the
   * provider-specific lookup finds nothing.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  /** MCP config scopes supported by this provider adapter. */
  readonly supportedScopes: readonly McpScope[];
  /** MCP transports supported by this provider adapter. */
  readonly supportedTransports: readonly McpTransport[];
  /** Whether provider-native stdio config preserves a working directory. */
  readonly supportsWorkingDirectory: boolean;
  /** Whether provider-native config preserves environment-variable references. */
  readonly supportsEnvironmentVariableReferences: boolean;
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER USAGE INTERFACE ------------
/**
 * Token-usage contract optionally implemented by providers that expose usage.
 *
 * The application service resolves the app session once and passes normalized
 * identity/storage fields to this provider-owned calculator. Missing facets are
 * rejected by the registry instead of returning an empty success payload.
 */
export interface IProviderUsage {
  getSessionTokenUsage(session: {
    sessionId: string;
    providerSessionId: string;
    projectPath: string | null;
    jsonlPath: string | null;
  }): Promise<{
    used: number;
    total?: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    cacheTokens?: number;
    breakdown: {
      input: number;
      output: number;
    };
    unsupported?: boolean;
    message?: string;
  }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events. Each implementation also owns the filesystem
 * roots that produce those incremental events, so registering a provider is
 * sufficient to include it in watcher setup.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Resolves every filesystem root containing this provider's session artifacts.
   *
   * Implementations should resolve configuration at call time and return all
   * active roots. The sessions watcher consumes these paths without maintaining
   * a separate provider-id or storage-path mapping.
   */
  getWatchRoots(): string[];

  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}

// ---------------------------
//----------------- SESSION APPLICATION PORT INTERFACES ------------

/**
 * Synchronous persistence port for app-facing and provider-native run identity.
 *
 * `ProviderRunCoordinator` calls `ensureAppSession` before launching a fresh
 * persisted run, then calls `assignProviderSessionId` before exposing the first
 * native identity to HTTP or WebSocket transports. `providerRuntimeService`
 * supplies the production Sessions service; tests use an in-memory store.
 */
export interface IProviderSessionIdentityStore {
  ensureAppSession(
    appSessionId: string,
    provider: LLMProvider,
    projectPath: string,
  ): void;
  assignProviderSessionId(
    appSessionId: string,
    providerSessionId: string,
    provider: LLMProvider,
  ): void;
}

/**
 * Application-owned output port for publishing one canonical session sidebar delta.
 *
 * Provider indexing services call this contract after persistence succeeds. The
 * WebSocket module supplies the production adapter and tests may supply an
 * in-memory implementation, which keeps the providers module independent of any
 * concrete transport or connection registry.
 */
export interface ISessionChangePublisher {
  publishSessionUpserted(event: {
    kind: 'session_upserted';
    sessionId: string;
    provider: LLMProvider;
    session: {
      id: string;
      summary: string;
      messageCount: number;
      lastActivity: string;
    };
    project: {
      projectId: string;
      path: string;
      fullPath: string;
      displayName: string;
      isStarred: boolean;
    } | null;
    timestamp: string;
  }): void;
}

/**
 * Application-owned input port for reading active provider run summaries.
 *
 * The provider sessions route uses this read-only contract to restore sidebar
 * processing state after page reload. Its production adapter reads the current
 * run registry, while tests can provide isolated in-memory state without making
 * the providers module depend on the WebSocket transport module.
 */
export interface ISessionRunStateReader {
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }>;
}

/**
 * Application-owned output port for broadcasting a project's git status delta.
 *
 * The git status watcher (server/modules/git) calls this contract after it
 * recomputes a project's branch and uncommitted summary from a `.git` change.
 * The WebSocket module supplies the production adapter and tests may supply an
 * in-memory implementation, keeping the git module independent of any concrete
 * transport or connection registry — the same seam as `ISessionChangePublisher`.
 */
export interface IGitStatusPublisher {
  publishGitStatusChanged(event: GitStatusEvent): void;
}
