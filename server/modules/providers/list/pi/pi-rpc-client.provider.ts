/**
 * PiRpcClient - thin wrapper around the official Pi rpc-client.
 *
 * Spawns Pi in RPC mode with extensions disabled (via the official RpcClient) and adds
 * a small layer the runtime relies on:
 * - fixed additional args injection (--no-extensions), merged with caller args,
 * - event dispatch fan-out (onEvent),
 * - stderr pass-through (getStderr),
 * - graceful close with a bounded window before giving up.
 *
 * Request/response correlation, timeouts and rejection of pending requests on
 * unexpected process exit are handled by the official client; this wrapper only
 * forwards to it and does not re-implement that machinery.
 */
import type { ChildProcess } from 'node:child_process';

import {
  RpcClient,
  type RpcClientOptions,
  type JsonAgentSessionEvent,
  type ModelInfo,
  type RpcSessionState,
} from '@earendil-works/pi-coding-agent';

import { PiPaths } from './pi-paths.provider.js';

/**
 * Local equivalent of the official `RpcSlashCommand` (returned by
 * `getCommands()`). The package does not export this type from its top-level
 * entry, so we mirror its shape here to keep type-checking working.
 */
type RpcSlashCommand = {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  sourceInfo?: unknown;
};

type EventListener = (event: JsonAgentSessionEvent) => void;

/**
 * Minimal surface the wrapper depends on. The default adapter is backed by the
 * official {@link RpcClient}; tests inject a stub implementing this shape.
 */
export interface UnderlyingRpcClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: EventListener): () => void;
  /**
   * Subscribes to real process exit. The runtime relies on this to detect a
   * close before `agent_settled` (ERR-PI-RUN-FAILED) instead of hanging.
   * Optional so lightweight test stubs need not implement it.
   */
  onClose?(listener: () => void): () => void;
  getStderr(): string;
  prompt(message: string, images?: unknown[]): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<RpcSessionState>;
  getAvailableModels(): Promise<ModelInfo[]>;
  getCommands(): Promise<RpcSlashCommand[]>;
  /**
   * Write one raw JSON object to the child's stdin as a strict JSONL line.
   *
   * The official client's `send()` is request/response correlated and would
   * spuriously wait for a `response` frame; extension UI responses are
   * fire-and-forget from the protocol's perspective, so the runtime uses this
   * bypass to write `extension_ui_response` directly.
   */
  sendRaw(command: unknown): void;
}

export interface PiRpcClientDeps {
  createClient(options: RpcClientOptions): UnderlyingRpcClient;
}

// RpcClient itself always adds `--mode rpc`; only wrapper-owned flags belong here.
const FIXED_ADDITIONAL_ARGS = ['--no-extensions'];

/**
 * Whether pi extensions are enabled for this deployment.
 *
 * Extensions run arbitrary code with full system access and their `ctx.ui`
 * dialog methods block the RPC turn until the client responds. They are opt-in
 * behind `PI_ENABLE_EXTENSIONS=1`; the default keeps `--no-extensions` so an
 * unattended interactive extension can never hang a run.
 */
const extensionsEnabled = () => process.env.PI_ENABLE_EXTENSIONS === '1';

const buildFixedAdditionalArgs = (): string[] =>
  extensionsEnabled() ? [] : [...FIXED_ADDITIONAL_ARGS];

/**
 * Anthropic credentials Pi picks up from the environment.
 *
 * Pi treats either of these as "the Anthropic provider is configured" and adds
 * its whole built-in Claude catalog to `getAvailableModels()`. The app exports
 * them for its own Claude provider, and the Pi child inherits them, so the Pi
 * model list ends up advertising Claude models the user never configured for
 * Pi. Blanking them for the child keeps the Pi catalog equal to what
 * `~/.pi/agent/models.json` actually declares.
 */
const SUPPRESSED_INHERITED_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/** Caller-supplied env wins, so an explicit credential still reaches Pi. */
const buildChildEnv = (callerEnv?: Record<string, string>): Record<string, string> => ({
  ...Object.fromEntries(SUPPRESSED_INHERITED_ENV.map((name) => [name, ''])),
  ...callerEnv,
});


/** Default adapter wiring the official RpcClient to {@link UnderlyingRpcClient}. */
const defaultDeps: PiRpcClientDeps = {
  createClient(options) {
    const client = new RpcClient(options);
    return {
      start: () => client.start(),
      stop: () => client.stop(),
      onEvent: (listener) => client.onEvent(listener),
      onClose: (listener) => {
        // The official client exposes its spawned ChildProcess as a public
        // field once start() has run. Forward its `exit` to the runtime so a
        // process death before agent_settled surfaces as a failure.
        // `process` is a runtime-public field; the shipped .d.ts marks it
        // private, so reach it through a narrow typed view.
        // SAFETY: `process` is assigned by the official client's start() and
        // holds the spawned ChildProcess; the .d.ts hides the handle only.
        const child = (client as unknown as { process: ChildProcess | null }).process;
        if (!child) return () => {};
        const onExit = (): void => listener();
        child.once('exit', onExit);
        return () => {
          child.removeListener('exit', onExit);
        };
      },
      getStderr: () => client.getStderr(),
      prompt: (message, images) => client.prompt(message, images as never),
      abort: () => client.abort(),
      getState: () => client.getState(),
      getAvailableModels: () => client.getAvailableModels(),
      getCommands: () => client.getCommands(),
      sendRaw: (command) => {
        // SAFETY: same invariant as onClose — `process` is the spawned child
        // assigned in start(); the .d.ts hides it, it is not nullable at runtime.
        const child = (client as unknown as { process: ChildProcess | null }).process;
        const stdin = child?.stdin;
        if (!child || !stdin || stdin.destroyed || !stdin.writable) {
          throw new Error('Pi RPC process stdin is not writable');
        }
        // Strict JSONL, LF-only (matches the agent's framing; no readline).
        stdin.write(`${JSON.stringify(command)}\n`);
      },
    };
  },
};

export class PiRpcClient {
  private readonly deps: PiRpcClientDeps;
  private readonly options: RpcClientOptions;
  private client: UnderlyingRpcClient | null = null;

  constructor(options: RpcClientOptions = {}, deps: PiRpcClientDeps = defaultDeps) {
    this.options = options;
    this.deps = deps;
  }

  async start(): Promise<void> {
    const { args, cliPath, env, ...rest } = this.options;
    const client = this.deps.createClient({
      ...rest,
      // The official RpcClient runs `node <cliPath> ...`, so cliPath MUST be a
      // JS entry (dist/cli.js), never the bare `pi` command. Default to the
      // resolved package entry unless a caller explicitly overrides it.
      cliPath: cliPath ?? new PiPaths().getRpcCliEntry(),
      args: [...buildFixedAdditionalArgs(), ...(args ?? [])],
      env: buildChildEnv(env),
    });
    this.client = client;
    await client.start();
  }

  onEvent(listener: EventListener): () => void {
    return this.requireClient().onEvent(listener);
  }

  onClose(listener: () => void): () => void {
    const client = this.requireClient();
    return client.onClose ? client.onClose(listener) : () => {};
  }

  getStderr(): string {
    return this.client ? this.client.getStderr() : '';
  }

  prompt(message: string, images?: unknown[]): Promise<void> {
    return this.requireClient().prompt(message, images);
  }

  abort(): Promise<void> {
    return this.requireClient().abort();
  }

  getState(): Promise<RpcSessionState> {
    return this.requireClient().getState();
  }

  getAvailableModels(): Promise<ModelInfo[]> {
    return this.requireClient().getAvailableModels();
  }

  getCommands(): Promise<RpcSlashCommand[]> {
    return this.requireClient().getCommands();
  }

  /**
   * Writes one raw JSON object to the child's stdin as a strict JSONL line.
   *
   * Backs the runtime's extension-UI responder: the official `send()` is
   * request/response correlated and would spuriously wait for a `response`
   * frame, so `extension_ui_response` frames bypass it.
   */
  sendRaw(command: unknown): void {
    this.requireClient().sendRaw(command);
  }

  /**
   * Gracefully stop the underlying client. If it does not settle within
   * `graceMs`, stop waiting and resolve anyway (the official stop() has already
   * signalled the process; this is only a bounded-wait safety net).
   */
  async close(graceMs: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    const stopped = Promise.resolve()
      .then(() => client.stop())
      .then(
        () => undefined,
        () => undefined,
      );

    await Promise.race([stopped, timeout]);
    if (timer) clearTimeout(timer);
  }

  private requireClient(): UnderlyingRpcClient {
    if (!this.client) throw new Error('PiRpcClient not started');
    return this.client;
  }
}
