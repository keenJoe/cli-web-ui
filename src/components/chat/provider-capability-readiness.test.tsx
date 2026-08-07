import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import ComposerPermissionMenu from './view/subcomponents/ComposerPermissionMenu';
import ComposerModelMenu from './view/subcomponents/ComposerModelMenu';
import TokenUsageSummary from './view/subcomponents/TokenUsageSummary';

type UseChatProviderState = typeof import('./hooks/useChatProviderState')['useChatProviderState'];
type UseChatComposerState = typeof import('./hooks/useChatComposerState')['useChatComposerState'];
type UseProviderCapabilities = typeof import('../../hooks/useProviderCapabilities')['useProviderCapabilities'];
type UseChatSessionState = typeof import('./hooks/useChatSessionState')['useChatSessionState'];
type UseChatRealtimeHandlers = typeof import('./hooks/useChatRealtimeHandlers')['useChatRealtimeHandlers'];
type UseQueuedMessageAutoSend = (
  typeof import('../../hooks/useQueuedMessageAutoSend')
)['useQueuedMessageAutoSend'];
type ProviderSelectionEmptyStateComponent = (
  typeof import('./view/subcomponents/ProviderSelectionEmptyState')
)['default'];
type ComposerArgs = Parameters<UseChatComposerState>[0] & { supportsSkills: boolean };

const noop = () => undefined;
const readChatSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
);
const selectedProject = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/workspace/project-one',
};
const selectedSession = { id: 'session-1', __provider: 'pi' as const };

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const emptyComposerFetch: typeof fetch = async (request) => {
  const url = String(request);
  if (url.includes('/api/commands/list')) {
    return jsonResponse({ builtIn: [], custom: [] });
  }
  if (url.includes('/skills')) {
    return jsonResponse({ success: true, data: { skills: [] } });
  }
  return jsonResponse([]);
};

const createComposerArgs = (overrides: Partial<ComposerArgs> = {}): ComposerArgs => ({
  selectedProject,
  selectedSession,
  currentSessionId: 'session-1',
  provider: 'pi',
  providerCapabilityStatus: 'loading',
  supportsSkills: false,
  permissionMode: null,
  cyclePermissionMode: noop,
  resolvePermissionModeForProvider: () => null,
  currentProviderModel: null,
  currentProviderEffort: 'default',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: noop,
  isWebSocketReady: () => true,
  scrollToBottom: noop,
  addMessage: noop,
  setIsUserScrolledUp: noop,
  setPendingPermissionRequests: noop as never,
  ...overrides,
});

const installMountedHookDom = (fetchImpl: typeof fetch) => {
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const hasOwn = (key: PropertyKey) => Object.prototype.hasOwnProperty.call(globalThis, key);
  const hadWindow = hasOwn('window');
  const hadDocument = hasOwn('document');
  const hadWebSocket = hasOwn('WebSocket');
  const hadActEnvironment = hasOwn('IS_REACT_ACT_ENVIRONMENT');
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  class HTMLIFrameElementStub {}
  class WebSocketStub {
    static readonly OPEN = 1;
  }

  const windowStub = {
    event: undefined,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    HTMLIFrameElement: HTMLIFrameElementStub,
    WebSocket: WebSocketStub,
  };
  const documentStub = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    defaultView: windowStub,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  };
  Object.assign(windowStub, { document: documentStub });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: WebSocketStub });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  globalThis.fetch = fetchImpl;

  return {
    container: {
      nodeType: 1,
      nodeName: 'DIV',
      tagName: 'DIV',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      ownerDocument: documentStub,
      addEventListener: noop,
      removeEventListener: noop,
      appendChild: noop,
      removeChild: noop,
      insertBefore: noop,
      textContent: '',
    },
    restore: () => {
      globalThis.fetch = originalFetch;
      if (hadWindow) {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
      if (hadDocument) {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
      if (hadWebSocket) {
        Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
      } else {
        Reflect.deleteProperty(globalThis, 'WebSocket');
      }
      if (hadActEnvironment) {
        Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
          configurable: true,
          value: originalActEnvironment,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    },
  };
};

type HookModulePath =
  | '/src/components/chat/hooks/useChatProviderState.ts'
  | '/src/components/chat/hooks/useChatComposerState.ts'
  | '/src/components/chat/hooks/useChatSessionState.ts'
  | '/src/components/chat/hooks/useChatRealtimeHandlers.ts'
  | '/src/hooks/useProviderCapabilities.ts'
  | '/src/hooks/useQueuedMessageAutoSend.ts';

const renderHookOnServer = async <Args, State>(
  modulePath: HookModulePath,
  exportName: string,
  args: Args,
): Promise<State> => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const hookModule = await vite.ssrLoadModule(modulePath);
    const useHook = hookModule[exportName] as (hookArgs: Args) => State;
    let state: State | undefined;
    function HookProbe() {
      state = useHook(args);
      return null;
    }
    renderToStaticMarkup(<HookProbe />);
    assert.ok(state);
    return state;
  } finally {
    await vite.close();
  }
};

const withMountedHook = async <Args, State>(options: {
  modulePath: HookModulePath;
  exportName: string;
  args: Args;
  fetchImpl: typeof fetch;
  run: (
    getState: () => State,
    rerender: (nextArgs: Args) => Promise<void>,
  ) => Promise<void> | void;
}) => {
  const dom = installMountedHookDom(options.fetchImpl);
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const root = createRoot(dom.container as never);
  try {
    const hookModule = await vite.ssrLoadModule(options.modulePath);
    const useHook = hookModule[options.exportName] as (hookArgs: Args) => State;
    let hookArgs = options.args;
    let hasRendered = false;
    let state: State | undefined;
    function HookProbe() {
      state = useHook(hookArgs);
      hasRendered = true;
      return null;
    }
    await act(async () => root.render(<HookProbe />));
    assert.equal(hasRendered, true);
    await options.run(
      () => state as State,
      async (nextArgs) => {
        hookArgs = nextArgs;
        await act(async () => root.render(<HookProbe />));
      },
    );
  } finally {
    await act(async () => root.unmount());
    await vite.close();
    dom.restore();
  }
};

test('permission picker stays visible and disabled while provider capabilities are unavailable', () => {
  for (const capabilityStatus of ['loading', 'error'] as const) {
    const html = renderToStaticMarkup(
      <ComposerPermissionMenu
        capabilityStatus={capabilityStatus}
        permissionMode={null}
        permissionModes={[]}
        onSelectPermissionMode={noop}
        providerLabel="Pi"
      />,
    );
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /default/i);
  }
});

test('grouped user messages still show the user avatar while keeping bubbles aligned', async () => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const componentModule = await vite.ssrLoadModule(
      '/src/components/chat/view/subcomponents/MessageComponent.tsx',
    );
    const MessageComponent = componentModule.default as React.ComponentType<any>;
    const userMessage = {
      id: 'user-current',
      type: 'user',
      content: '介绍一下自己',
      timestamp: '2026-08-07T00:00:00.000Z',
    };
    const previousUserMessage = {
      id: 'user-previous',
      type: 'user',
      content: '上一条用户消息',
      timestamp: '2026-08-07T00:00:01.000Z',
    };
    const renderUserMessage = (prevMessage: typeof previousUserMessage | null) => renderToStaticMarkup(
      <MessageComponent
        message={userMessage}
        prevMessage={prevMessage}
        createDiff={() => []}
        selectedProject={selectedProject}
        provider="pi"
      />,
    );

    const ungroupedHtml = renderUserMessage(null);
    assert.match(ungroupedHtml, />U<\/div>/);

    const groupedHtml = renderUserMessage(previousUserMessage);
    assert.match(groupedHtml, /chat-message user grouped/);
    assert.match(groupedHtml, />U<\/div>/);
  } finally {
    await vite.close();
  }
});

test('model picker renders a disabled skeleton instead of a guessed default while capabilities are unavailable', () => {
  for (const capabilityStatus of ['loading', 'error'] as const) {
    const html = renderToStaticMarkup(
      <ComposerModelMenu
        capabilityStatus={capabilityStatus}
        effort=""
        effortOptions={[]}
        onSelectEffort={noop}
        model={null}
        modelOptions={[]}
        onSelectModel={noop}
        modelsLoading
      />,
    );
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /default/i);
  }
});

test('model picker remains disabled when capabilities are ready but the model catalog is unavailable', () => {
  const html = renderToStaticMarkup(
    <ComposerModelMenu
      capabilityStatus="ready"
      effort=""
      effortOptions={[]}
      onSelectEffort={noop}
      model={null}
      modelOptions={[]}
      onSelectModel={noop}
      modelsLoading={false}
    />,
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /default/i);
});

test('model picker remains a disabled skeleton when a session model resolves without a catalog', () => {
  const html = renderToStaticMarkup(
    <ComposerModelMenu
      capabilityStatus="ready"
      effort="default"
      effortOptions={[]}
      onSelectEffort={noop}
      model="session-only-model"
      modelOptions={[]}
      onSelectModel={noop}
      modelsLoading={false}
    />,
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /session-only-model/);
});

test('empty-state model picker does not expose a provider fallback before capabilities are ready', async () => {
  const selfGlobal = globalThis as typeof globalThis & { self?: typeof globalThis };
  const hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
  const originalSelf = selfGlobal.self;
  Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const componentModule = await vite.ssrLoadModule(
      '/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx',
    );
    const ProviderSelectionEmptyState = componentModule.default as ProviderSelectionEmptyStateComponent;
    const html = renderToStaticMarkup(
      <ProviderSelectionEmptyState
        selectedSession={null}
        currentSessionId={null}
        provider="pi"
        providerCapabilityStatus="loading"
        setProvider={noop}
        textareaRef={{ current: null }}
        providerModels={{ pi: 'anthropic/claude-sonnet-4-5' }}
        setStoredProviderModel={noop}
        providerModelCatalog={{}}
        providerModelsLoading
        tasksEnabled={false}
        isTaskMasterInstalled={false}
        setInput={noop as never}
      />,
    );
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /anthropic\/claude-sonnet-4-5/);
  } finally {
    await vite.close();
    if (hadSelf) {
      Object.defineProperty(globalThis, 'self', { configurable: true, value: originalSelf });
    } else {
      Reflect.deleteProperty(globalThis, 'self');
    }
  }
});

test('provider state exposes no guessed modes or defaults before capabilities are ready', async () => {
  storage.clear();
  const state = await renderHookOnServer<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>(
    '/src/components/chat/hooks/useChatProviderState.ts',
    'useChatProviderState',
    { selectedProject: null, selectedSession: null },
  );
  assert.equal(state.providerCapabilityStatus, 'loading');
  assert.deepEqual(state.availablePermissionModes, []);
  assert.equal(state.permissionMode, null);
  assert.equal(state.currentProviderModel, null);
  assert.deepEqual(state.currentProviderEffortOptions, []);
});

test('cycling permission mode is a no-op while capabilities are unavailable', async () => {
  storage.clear();
  const state = await renderHookOnServer<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>(
    '/src/components/chat/hooks/useChatProviderState.ts',
    'useChatProviderState',
    { selectedProject: null, selectedSession: null },
  );
  state.cyclePermissionMode();
  assert.equal(storage.has('permissionMode-last-claude'), false);
});

test('direct composer submission cannot send before provider capabilities are ready', async () => {
  const sentMessages: unknown[] = [];
  const state = await renderHookOnServer<ComposerArgs, ReturnType<UseChatComposerState>>(
    '/src/components/chat/hooks/useChatComposerState.ts',
    'useChatComposerState',
    createComposerArgs({ sendMessage: (message) => sentMessages.push(message) }),
  );
  await state.handleSubmit(
    { preventDefault: noop } as never,
    { content: 'Do not send this', attachments: [] },
  );
  assert.deepEqual(sentMessages, []);
});

test('skill slash commands require a ready supportsSkills capability while built-ins remain available', async () => {
  storage.clear();
  let commandRequests = 0;
  let skillRequests = 0;
  const args = createComposerArgs({
    providerCapabilityStatus: 'loading',
    supportsSkills: true,
  });

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/commands/list')) {
        commandRequests += 1;
        return jsonResponse({
          builtIn: [{ name: '/help', description: 'Show help' }],
          custom: [{ name: '/custom', description: 'Run custom command' }],
        });
      }
      if (url.includes('/skills')) {
        skillRequests += 1;
        return jsonResponse({
          success: true,
          data: {
            skills: [{
              name: 'inspect',
              command: '/pi:inspect',
              scope: 'provider',
              description: 'Inspect with Pi',
            }],
          },
        });
      }
      return jsonResponse([]);
    },
    run: async (getState, rerender) => {
      const waitForCommands = async () => {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      };
      const commandNames = () => getState().filteredCommands.map((command) => command.name);

      await waitForCommands();
      assert.equal(skillRequests, 0);
      assert.deepEqual(commandNames(), ['/help', '/custom']);

      await rerender({ ...args, providerCapabilityStatus: 'error' });
      await waitForCommands();
      assert.equal(skillRequests, 0);
      assert.deepEqual(commandNames(), ['/help', '/custom']);

      await rerender({
        ...args,
        providerCapabilityStatus: 'ready',
        supportsSkills: false,
      });
      await waitForCommands();
      assert.equal(skillRequests, 0);
      assert.deepEqual(commandNames(), ['/help', '/custom']);

      await rerender({
        ...args,
        providerCapabilityStatus: 'ready',
        supportsSkills: true,
      });
      await waitForCommands();
      assert.equal(skillRequests, 1);
      assert.deepEqual(commandNames(), ['/help', '/pi:inspect', '/custom']);
      assert.equal(commandRequests >= 1, true);
    },
  });
  storage.clear();
});

test('provider skill request failures preserve built-in and custom slash commands', async () => {
  storage.clear();
  let skillRequests = 0;

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args: createComposerArgs({
      providerCapabilityStatus: 'ready',
      supportsSkills: true,
    }),
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/commands/list')) {
        return jsonResponse({
          builtIn: [{ name: '/help', description: 'Show help' }],
          custom: [{ name: '/custom', description: 'Run custom command' }],
        });
      }
      if (url.includes('/skills')) {
        skillRequests += 1;
        throw new TypeError('skills network unavailable');
      }
      return jsonResponse([]);
    },
    run: async (getState) => {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));

      assert.equal(skillRequests, 1);
      assert.deepEqual(
        getState().filteredCommands.map((command) => command.name),
        ['/help', '/custom'],
      );
    },
  });
  storage.clear();
});

test('switching providers hides stale skills while the next provider catalog is pending', async () => {
  storage.clear();
  let commandRequests = 0;
  let resolveClaudeCommands: ((response: Response) => void) | null = null;
  const args = createComposerArgs({
    provider: 'pi',
    providerCapabilityStatus: 'ready',
    supportsSkills: true,
  });

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/commands/list')) {
        commandRequests += 1;
        if (commandRequests > 1) {
          return new Promise<Response>((resolve) => {
            resolveClaudeCommands = resolve;
          });
        }
        return jsonResponse({
          builtIn: [{ name: '/help', description: 'Show help' }],
          custom: [{ name: '/custom', description: 'Run custom command' }],
        });
      }
      if (url.includes('/api/providers/pi/skills')) {
        return jsonResponse({
          success: true,
          data: {
            skills: [{
              name: 'inspect',
              command: '/pi:inspect',
              scope: 'provider',
              description: 'Inspect with Pi',
            }],
          },
        });
      }
      if (url.includes('/skills')) {
        return jsonResponse({ success: true, data: { skills: [] } });
      }
      return jsonResponse([]);
    },
    run: async (getState, rerender) => {
      const commandNames = () => getState().filteredCommands.map((command) => command.name);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      assert.deepEqual(commandNames(), ['/help', '/pi:inspect', '/custom']);
      const stalePiSkill = getState().filteredCommands.find((command) => command.name === '/pi:inspect');
      assert.ok(stalePiSkill);

      await rerender({ ...args, provider: 'claude' });

      assert.equal(commandRequests, 2);
      assert.deepEqual(commandNames(), ['/help', '/custom']);
      await act(async () => getState().handleCommandSelect(stalePiSkill, 1, false));
      assert.equal(getState().input, '');

      const resolveCommands = resolveClaudeCommands;
      assert.ok(resolveCommands);
      await act(async () => {
        resolveCommands(jsonResponse({
          builtIn: [{ name: '/help', description: 'Show help' }],
          custom: [{ name: '/custom', description: 'Run custom command' }],
        }));
        await Promise.resolve();
      });
    },
  });
  storage.clear();
});

test('loaded skill commands fail closed immediately when skill capability becomes unavailable', async () => {
  const unavailableCapabilities = [
    { providerCapabilityStatus: 'loading', supportsSkills: true },
    { providerCapabilityStatus: 'error', supportsSkills: true },
    { providerCapabilityStatus: 'ready', supportsSkills: false },
  ] as const;

  for (const unavailableCapability of unavailableCapabilities) {
    storage.clear();
    let commandRequests = 0;
    let resolvePendingCommands: ((response: Response) => void) | null = null;
    const args = createComposerArgs({
      providerCapabilityStatus: 'ready',
      supportsSkills: true,
    });

    await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
      modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
      exportName: 'useChatComposerState',
      args,
      fetchImpl: async (request) => {
        const url = String(request);
        if (url.includes('/api/commands/list')) {
          commandRequests += 1;
          if (commandRequests > 1) {
            return new Promise<Response>((resolve) => {
              resolvePendingCommands = resolve;
            });
          }
          return jsonResponse({
            builtIn: [{ name: '/help', description: 'Show help' }],
            custom: [{ name: '/custom', description: 'Run custom command' }],
          });
        }
        if (url.includes('/skills')) {
          return jsonResponse({
            success: true,
            data: {
              skills: [{
                name: 'inspect',
                command: '/pi:inspect',
                scope: 'provider',
                description: 'Inspect with Pi',
              }],
            },
          });
        }
        return jsonResponse([]);
      },
      run: async (getState, rerender) => {
        const commandNames = () => getState().filteredCommands.map((command) => command.name);
        await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
        assert.deepEqual(commandNames(), ['/help', '/pi:inspect', '/custom']);

        await rerender({ ...args, ...unavailableCapability });

        assert.equal(commandRequests, 2);
        assert.deepEqual(
          commandNames(),
          ['/help', '/custom'],
          `${unavailableCapability.providerCapabilityStatus}/${unavailableCapability.supportsSkills} must hide stale skills`,
        );

        const resolveCommands = resolvePendingCommands;
        assert.ok(resolveCommands);
        await act(async () => {
          resolveCommands(jsonResponse({
            builtIn: [{ name: '/help', description: 'Show help' }],
            custom: [{ name: '/custom', description: 'Run custom command' }],
          }));
          await Promise.resolve();
        });
        assert.deepEqual(commandNames(), ['/help', '/custom']);
      },
    });
  }
  storage.clear();
});

test('keyboard, voice, and direct submit paths all fail closed while capabilities load', async () => {
  const sentMessages: unknown[] = [];
  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args: createComposerArgs({ sendMessage: (message) => sentMessages.push(message) }),
    fetchImpl: emptyComposerFetch,
    run: async (getState) => {
      await act(async () => getState().handleInputChange({
        target: { value: 'Keyboard message', selectionStart: 16, style: {} },
      } as never));
      await act(async () => getState().handleKeyDown({
        key: 'Enter',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: noop,
      } as never));
      assert.deepEqual(sentMessages, [], 'Enter key must not send');

      await act(async () => getState().handleVoiceTranscript('Voice message', true));
      assert.deepEqual(sentMessages, [], 'voice auto-send must not send');

      await act(async () => getState().handleSubmit(
        { preventDefault: noop } as never,
        { content: 'Direct message', attachments: [] },
      ));
      assert.deepEqual(sentMessages, [], 'direct handleSubmit must not send');
    },
  });
});

test('a queued draft is retained until provider capabilities become ready', async () => {
  storage.clear();
  storage.set('queued_message_session-1', JSON.stringify({
    content: 'Keep this queued message',
    options: { model: 'previous-model', permissionMode: 'previous-mode' },
  }));
  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args: createComposerArgs(),
    fetchImpl: emptyComposerFetch,
    run: async () => {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
      assert.equal(storage.has('queued_message_session-1'), true);
    },
  });
  storage.clear();
});

test('a restored queued draft is replayed with current backend-validated options', async () => {
  storage.clear();
  storage.set('queued_message_session-1', JSON.stringify({
    content: 'Replay with current options',
    options: { model: 'legacy-fallback-model', permissionMode: 'default' },
  }));
  const sentMessages: Array<{
    options?: { model?: unknown; permissionMode?: unknown };
  }> = [];

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args: createComposerArgs({
      providerCapabilityStatus: 'ready',
      permissionMode: 'bypassPermissions',
      resolvePermissionModeForProvider: (_provider, requestedMode) => (
        requestedMode === 'bypassPermissions' ? requestedMode : 'bypassPermissions'
      ),
      currentProviderModel: 'current-pi-model',
      sendMessage: (message) => sentMessages.push(message as never),
    }),
    fetchImpl: emptyComposerFetch,
    run: async () => {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0]?.options?.model, 'current-pi-model');
      assert.equal(sentMessages[0]?.options?.permissionMode, 'bypassPermissions');
    },
  });
  storage.clear();
});

test('inactive queued replay retains a draft whose persisted options fail current validation', async () => {
  storage.clear();
  storage.set('queued_message_inactive-session', JSON.stringify({
    content: 'Retain this draft',
    provider: 'pi',
    options: { model: 'stale-fallback-model', permissionMode: 'stale-mode' },
  }));
  const sentMessages: unknown[] = [];
  const activeProcessing = new Map([[
    'inactive-session',
    { statusText: null, canInterrupt: true, startedAt: Date.now() },
  ]]);
  const args: Parameters<UseQueuedMessageAutoSend>[0] = {
    processingSessions: activeProcessing,
    activeSessionId: 'another-session',
    ws: { readyState: 1 } as WebSocket,
    sendMessage: (message) => sentMessages.push(message),
    markSessionProcessing: noop,
  };

  await withMountedHook<Parameters<UseQueuedMessageAutoSend>[0], ReturnType<UseQueuedMessageAutoSend>>({
    modulePath: '/src/hooks/useQueuedMessageAutoSend.ts',
    exportName: 'useQueuedMessageAutoSend',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'current-model', label: 'Current Model' }],
              DEFAULT: 'current-model',
            },
          },
        });
      }
      if (url.includes('/sessions/inactive-session/active-model')) {
        return jsonResponse({
          success: true,
          data: { provider: 'pi', sessionId: 'inactive-session', model: 'current-model', source: 'session' },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: async (_getState, rerender) => {
      await rerender({ ...args, processingSessions: new Map() });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      assert.deepEqual(sentMessages, []);
      assert.equal(storage.has('queued_message_inactive-session'), true);
    },
  });
  storage.clear();
});

test('inactive queued replay replaces the stored model with the current active session model', async () => {
  storage.clear();
  storage.set('queued_message_inactive-session', JSON.stringify({
    content: 'Send with current state',
    provider: 'pi',
    options: { model: 'queued-model', permissionMode: 'bypassPermissions' },
  }));
  const sentMessages: Array<{ options?: { model?: unknown; permissionMode?: unknown } }> = [];
  const activeProcessing = new Map([[
    'inactive-session',
    { statusText: null, canInterrupt: true, startedAt: Date.now() },
  ]]);
  const args: Parameters<UseQueuedMessageAutoSend>[0] = {
    processingSessions: activeProcessing,
    activeSessionId: 'another-session',
    ws: { readyState: 1 } as WebSocket,
    sendMessage: (message) => sentMessages.push(message as never),
    markSessionProcessing: noop,
  };

  await withMountedHook<Parameters<UseQueuedMessageAutoSend>[0], ReturnType<UseQueuedMessageAutoSend>>({
    modulePath: '/src/hooks/useQueuedMessageAutoSend.ts',
    exportName: 'useQueuedMessageAutoSend',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [
                { value: 'queued-model', label: 'Queued Model' },
                { value: 'current-session-model', label: 'Current Session Model' },
              ],
              DEFAULT: 'queued-model',
            },
          },
        });
      }
      if (url.includes('/sessions/inactive-session/active-model')) {
        return jsonResponse({
          success: true,
          data: {
            provider: 'pi',
            sessionId: 'inactive-session',
            model: 'current-session-model',
            source: 'session',
          },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: async (_getState, rerender) => {
      await rerender({ ...args, processingSessions: new Map() });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0]?.options?.model, 'current-session-model');
      assert.equal(sentMessages[0]?.options?.permissionMode, 'bypassPermissions');
      assert.equal(storage.has('queued_message_inactive-session'), false);
    },
  });
  storage.clear();
});

test('inactive queued replay normalizes effort that the current active model no longer supports', async () => {
  storage.clear();
  storage.set('queued_message_inactive-session', JSON.stringify({
    content: 'Send with current effort support',
    provider: 'pi',
    options: {
      model: 'queued-model',
      effort: 'high',
      permissionMode: 'bypassPermissions',
    },
  }));
  const sentMessages: Array<{
    options?: { model?: unknown; effort?: unknown; permissionMode?: unknown };
  }> = [];
  const activeProcessing = new Map([[
    'inactive-session',
    { statusText: null, canInterrupt: true, startedAt: Date.now() },
  ]]);
  const args: Parameters<UseQueuedMessageAutoSend>[0] = {
    processingSessions: activeProcessing,
    activeSessionId: 'another-session',
    ws: { readyState: 1 } as WebSocket,
    sendMessage: (message) => sentMessages.push(message as never),
    markSessionProcessing: noop,
  };

  await withMountedHook<Parameters<UseQueuedMessageAutoSend>[0], ReturnType<UseQueuedMessageAutoSend>>({
    modulePath: '/src/hooks/useQueuedMessageAutoSend.ts',
    exportName: 'useQueuedMessageAutoSend',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions'],
              defaultPermissionMode: 'bypassPermissions',
              supportsEffort: true,
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [
                {
                  value: 'queued-model',
                  label: 'Queued Model',
                  effort: { values: [{ value: 'high' }] },
                },
                {
                  value: 'current-session-model',
                  label: 'Current Session Model',
                  effort: { values: [{ value: 'low' }] },
                },
              ],
              DEFAULT: 'queued-model',
            },
          },
        });
      }
      if (url.includes('/sessions/inactive-session/active-model')) {
        return jsonResponse({
          success: true,
          data: {
            provider: 'pi',
            sessionId: 'inactive-session',
            model: 'current-session-model',
            source: 'session',
          },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: async (_getState, rerender) => {
      await rerender({ ...args, processingSessions: new Map() });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0]?.options?.model, 'current-session-model');
      assert.equal(sentMessages[0]?.options?.effort, 'default');
      assert.equal(storage.has('queued_message_inactive-session'), false);
    },
  });
  storage.clear();
});

test('queued effort validation handles unsupported, valid, and unverifiable capability states', async () => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const originalFetch = globalThis.fetch;
  try {
    const validationModule = await vite.ssrLoadModule(
      '/src/components/chat/utils/queuedSendValidation.ts',
    );
    const resolveQueuedSendOptions = validationModule.resolveQueuedSendOptions as (args: {
      provider: 'pi';
      sessionId: string;
      options: Record<string, unknown>;
    }) => Promise<Record<string, unknown> | null>;

    const runCase = async (supportsEffort: boolean | undefined, effort: string) => {
      globalThis.fetch = async (request) => {
        const url = String(request);
        if (url.includes('/api/providers/capabilities')) {
          return jsonResponse({
            success: true,
            data: {
              providers: [{
                provider: 'pi',
                permissionModes: ['plan'],
                supportsEffort,
              }],
            },
          });
        }
        if (url.includes('/api/providers/pi/models')) {
          return jsonResponse({
            success: true,
            data: {
              models: {
                OPTIONS: [{
                  value: 'current-model',
                  label: 'Current Model',
                  effort: { values: [{ value: 'high' }] },
                }],
                DEFAULT: 'current-model',
              },
            },
          });
        }
        if (url.includes('/sessions/inactive-session/active-model')) {
          return jsonResponse({
            success: true,
            data: {
              provider: 'pi',
              sessionId: 'inactive-session',
              model: 'current-model',
              source: 'session',
            },
          });
        }
        return jsonResponse({ success: false }, 500);
      };

      return resolveQueuedSendOptions({
        provider: 'pi',
        sessionId: 'inactive-session',
        options: { model: 'current-model', permissionMode: 'plan', effort },
      });
    };

    assert.equal((await runCase(false, 'high'))?.effort, 'default');
    assert.equal((await runCase(true, 'high'))?.effort, 'high');
    assert.equal(await runCase(undefined, 'high'), null);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test('inactive queued replay preserves an explicit active session model missing from the current catalog', async () => {
  storage.clear();
  storage.set('queued_message_inactive-session', JSON.stringify({
    content: 'Send with the persisted session model',
    provider: 'pi',
    options: { model: 'catalog-model', permissionMode: 'plan' },
  }));
  const sentMessages: unknown[] = [];
  const activeProcessing = new Map([[
    'inactive-session',
    { statusText: null, canInterrupt: true, startedAt: Date.now() },
  ]]);
  const args: Parameters<UseQueuedMessageAutoSend>[0] = {
    processingSessions: activeProcessing,
    activeSessionId: 'another-session',
    ws: { readyState: 1 } as WebSocket,
    sendMessage: (message) => sentMessages.push(message),
    markSessionProcessing: noop,
  };

  await withMountedHook<Parameters<UseQueuedMessageAutoSend>[0], ReturnType<UseQueuedMessageAutoSend>>({
    modulePath: '/src/hooks/useQueuedMessageAutoSend.ts',
    exportName: 'useQueuedMessageAutoSend',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['plan'],
              defaultPermissionMode: 'plan',
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'catalog-model', label: 'Catalog Model' }],
              DEFAULT: 'catalog-model',
            },
          },
        });
      }
      if (url.includes('/sessions/inactive-session/active-model')) {
        return jsonResponse({
          success: true,
          data: {
            provider: 'pi',
            sessionId: 'inactive-session',
            model: 'removed-model',
            source: 'session',
          },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: async (_getState, rerender) => {
      await rerender({ ...args, processingSessions: new Map() });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      assert.equal(sentMessages.length, 1);
      const sentMessage = sentMessages[0] as { options?: { model?: unknown } } | undefined;
      assert.equal(sentMessage?.options?.model, 'removed-model');
      assert.equal(storage.has('queued_message_inactive-session'), false);
    },
  });
  storage.clear();
});

test('upload completion after a session switch retains options that are no longer valid', async () => {
  storage.clear();
  const sentMessages: unknown[] = [];
  let resolveUpload: ((response: Response) => void) | null = null;
  let markUploadStarted: (() => void) | null = null;
  const uploadStarted = new Promise<void>((resolve) => {
    markUploadStarted = resolve;
  });
  const activeProcessing = new Map([[
    'session-1',
    { statusText: null, canInterrupt: true, startedAt: Date.now() },
  ]]);
  const args = createComposerArgs({
    isLoading: true,
    processingSessions: activeProcessing,
    providerCapabilityStatus: 'ready',
    permissionMode: 'bypassPermissions',
    currentProviderModel: 'queued-model',
    resolvePermissionModeForProvider: (_provider, mode) => (
      mode === 'bypassPermissions' ? mode : null
    ),
    sendMessage: (message) => sentMessages.push(message),
  });

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/assets/files')) {
        markUploadStarted?.();
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['plan'],
              defaultPermissionMode: 'plan',
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'current-model', label: 'Current Model' }],
              DEFAULT: 'current-model',
            },
          },
        });
      }
      if (url.includes('/sessions/session-1/active-model')) {
        return jsonResponse({
          success: true,
          data: { provider: 'pi', sessionId: 'session-1', model: 'current-model', source: 'session' },
        });
      }
      return emptyComposerFetch(request);
    },
    run: async (getState, rerender) => {
      await act(async () => getState().setAttachedFiles([
        new File(['queued file'], 'queued.txt', { type: 'text/plain' }),
      ]));
      await act(async () => getState().handleInputChange({
        target: { value: 'Queue this upload', selectionStart: 17, style: {} },
      } as never));

      let submission: Promise<void> | null = null;
      await act(async () => {
        submission = getState().handleSubmit({ preventDefault: noop } as never);
      });
      await uploadStarted;
      await rerender(createComposerArgs({
        selectedSession: { id: 'session-2', __provider: 'pi' },
        currentSessionId: 'session-2',
        isLoading: false,
        processingSessions: new Map(),
        providerCapabilityStatus: 'ready',
        permissionMode: 'plan',
        currentProviderModel: 'current-model',
        resolvePermissionModeForProvider: (_provider, mode) => mode === 'plan' ? mode : null,
        sendMessage: (message) => sentMessages.push(message),
      }));

      assert.ok(resolveUpload);
      resolveUpload(jsonResponse({
        attachments: [{ name: 'queued.txt', path: '/uploads/queued.txt', mimeType: 'text/plain' }],
      }));
      await act(async () => submission);

      assert.deepEqual(sentMessages, []);
      assert.equal(storage.has('queued_message_session-1'), true);
    },
  });
  storage.clear();
});

test('upload completion after a session switch retains the draft when the socket disconnected', async () => {
  storage.clear();
  const sentMessages: unknown[] = [];
  const processingMarks: Array<string | null | undefined> = [];
  let resolveUpload: ((response: Response) => void) | null = null;
  let markUploadStarted: (() => void) | null = null;
  let socketOpen = true;
  const uploadStarted = new Promise<void>((resolve) => {
    markUploadStarted = resolve;
  });
  const activeProcessing = new Map([[
    'session-1',
    { statusText: null, canInterrupt: true, startedAt: Date.now() },
  ]]);
  const args = createComposerArgs({
    isLoading: true,
    processingSessions: activeProcessing,
    providerCapabilityStatus: 'ready',
    permissionMode: 'plan',
    currentProviderModel: 'current-model',
    resolvePermissionModeForProvider: (_provider, mode) => mode === 'plan' ? mode : null,
    sendMessage: (message) => {
      if (socketOpen) {
        sentMessages.push(message);
      }
    },
    isWebSocketReady: () => socketOpen,
    onSessionProcessing: (sessionId) => processingMarks.push(sessionId),
  });

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/assets/files')) {
        markUploadStarted?.();
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{ provider: 'pi', permissionModes: ['plan'], defaultPermissionMode: 'plan' }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'current-model', label: 'Current Model' }],
              DEFAULT: 'current-model',
            },
          },
        });
      }
      if (url.includes('/sessions/session-1/active-model')) {
        return jsonResponse({
          success: true,
          data: { provider: 'pi', sessionId: 'session-1', model: 'current-model', source: 'session' },
        });
      }
      return emptyComposerFetch(request);
    },
    run: async (getState, rerender) => {
      await act(async () => getState().setAttachedFiles([
        new File(['queued file'], 'queued.txt', { type: 'text/plain' }),
      ]));
      await act(async () => getState().handleInputChange({
        target: { value: 'Queue this upload', selectionStart: 17, style: {} },
      } as never));

      let submission: Promise<void> | null = null;
      await act(async () => {
        submission = getState().handleSubmit({ preventDefault: noop } as never);
      });
      await uploadStarted;
      socketOpen = false;
      await rerender(createComposerArgs({
        selectedSession: { id: 'session-2', __provider: 'pi' },
        currentSessionId: 'session-2',
        isLoading: false,
        processingSessions: new Map(),
        providerCapabilityStatus: 'ready',
        permissionMode: 'plan',
        currentProviderModel: 'current-model',
        resolvePermissionModeForProvider: (_provider, mode) => mode === 'plan' ? mode : null,
        sendMessage: (message) => {
          if (socketOpen) {
            sentMessages.push(message);
          }
        },
        isWebSocketReady: () => socketOpen,
        onSessionProcessing: (sessionId) => processingMarks.push(sessionId),
      }));

      assert.ok(resolveUpload);
      resolveUpload(jsonResponse({
        attachments: [{ name: 'queued.txt', path: '/uploads/queued.txt', mimeType: 'text/plain' }],
      }));
      await act(async () => submission);

      assert.deepEqual(sentMessages, []);
      assert.deepEqual(processingMarks, []);
      assert.equal(storage.has('queued_message_session-1'), true);
    },
  });
  storage.clear();
});

test('immediate attachment send retains recoverable content when the socket disconnects during upload', async () => {
  storage.clear();
  const sentMessages: unknown[] = [];
  const optimisticMessages: unknown[] = [];
  const processingMarks: Array<string | null | undefined> = [];
  let resolveUpload: ((response: Response) => void) | null = null;
  let markUploadStarted: (() => void) | null = null;
  let socketOpen = true;
  const uploadStarted = new Promise<void>((resolve) => {
    markUploadStarted = resolve;
  });
  const args = createComposerArgs({
    providerCapabilityStatus: 'ready',
    permissionMode: 'plan',
    currentProviderModel: 'current-model',
    resolvePermissionModeForProvider: (_provider, mode) => mode === 'plan' ? mode : null,
    sendMessage: (message) => sentMessages.push(message),
    isWebSocketReady: () => socketOpen,
    addMessage: (message) => optimisticMessages.push(message),
    onSessionProcessing: (sessionId) => processingMarks.push(sessionId),
  });

  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args,
    fetchImpl: async (request) => {
      if (String(request).includes('/api/assets/files')) {
        markUploadStarted?.();
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      return emptyComposerFetch(request);
    },
    run: async (getState) => {
      await act(async () => getState().setAttachedFiles([
        new File(['recoverable file'], 'recoverable.txt', { type: 'text/plain' }),
      ]));
      await act(async () => getState().handleInputChange({
        target: { value: 'Keep this message', selectionStart: 17, style: {} },
      } as never));

      let submission: Promise<void> | null = null;
      await act(async () => {
        submission = getState().handleSubmit({ preventDefault: noop } as never);
      });
      await uploadStarted;
      socketOpen = false;

      assert.ok(resolveUpload);
      resolveUpload(jsonResponse({
        attachments: [{
          name: 'recoverable.txt',
          path: '/uploads/recoverable.txt',
          mimeType: 'text/plain',
        }],
      }));
      await act(async () => submission);

      assert.deepEqual(sentMessages, []);
      assert.deepEqual(optimisticMessages, []);
      assert.deepEqual(processingMarks, []);
      assert.equal(getState().input, 'Keep this message');
      assert.equal(getState().attachedFiles.length, 1);
      assert.equal(getState().attachedFiles[0]?.name, 'recoverable.txt');
    },
  });
  storage.clear();
});

test('a failed capability request reaches an explicit error state with no provider data', async () => {
  const originalConsoleError = console.error;
  console.error = noop;
  try {
    await withMountedHook<undefined, ReturnType<UseProviderCapabilities>>({
      modulePath: '/src/hooks/useProviderCapabilities.ts',
      exportName: 'useProviderCapabilities',
      args: undefined,
      fetchImpl: async () => jsonResponse({ success: false }, 500),
      run: (getState) => {
        assert.equal(getState().status, 'error');
        assert.deepEqual(getState().byProvider, {});
      },
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('a successful response missing the selected provider remains fail closed', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => String(request).includes('/api/providers/capabilities')
      ? jsonResponse({ success: true, data: { providers: [] } })
      : jsonResponse({ success: false }),
    run: (getState) => {
      assert.equal(getState().provider, 'pi');
      assert.equal(getState().providerCapabilityStatus, 'error');
      assert.deepEqual(getState().availablePermissionModes, []);
      assert.equal(getState().permissionMode, null);
      assert.equal(getState().currentProviderModel, null);
    },
  });
  storage.clear();
});

test('provider state exposes no fallback model when the backend catalog is unavailable', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => String(request).includes('/api/providers/capabilities')
      ? jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
              supportsImages: true,
              supportsFiles: true,
              supportsAbort: true,
              supportsPermissionRequests: false,
              supportsTokenUsage: true,
              supportsEffort: true,
            }],
          },
        })
      : jsonResponse({ success: false }),
    run: (getState) => {
      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.equal(getState().currentProviderModel, null);
      assert.deepEqual(getState().currentProviderEffortOptions, []);
    },
  });
  storage.clear();
});

test('new-chat persisted models are reconciled against the current provider catalog', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  storage.set('pi-model', 'stale-model');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions'],
              defaultPermissionMode: 'bypassPermissions',
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'current-model', label: 'Current Model' }],
              DEFAULT: 'current-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: (getState) => {
      assert.equal(getState().currentProviderModel, 'current-model');
      assert.equal(storage.get('pi-model'), 'current-model');
    },
  });
  storage.clear();
});

test('a failed provider model request does not discard another provider catalog', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  const originalConsoleError = console.error;
  console.error = noop;
  try {
    await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
      modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
      exportName: 'useChatProviderState',
      args: { selectedProject: null, selectedSession: null },
      fetchImpl: async (request) => {
        const url = String(request);
        if (url.includes('/api/providers/capabilities')) {
          return jsonResponse({
            success: true,
            data: {
              providers: [
                {
                  provider: 'claude',
                  permissionModes: ['default'],
                  defaultPermissionMode: 'default',
                },
                {
                  provider: 'pi',
                  permissionModes: ['bypassPermissions'],
                  defaultPermissionMode: 'bypassPermissions',
                },
              ],
            },
          });
        }
        if (url.includes('/api/providers/claude/models')) {
          throw new Error('Claude model request failed');
        }
        if (url.includes('/api/providers/pi/models')) {
          return jsonResponse({
            success: true,
            data: {
              models: {
                OPTIONS: [{ value: 'pi-model', label: 'Pi Model' }],
                DEFAULT: 'pi-model',
              },
              cache: {
                updatedAt: '2026-08-05T00:00:00.000Z',
                expiresAt: '2026-08-05T01:00:00.000Z',
                source: 'fresh',
              },
            },
          });
        }
        return jsonResponse({ success: false }, 500);
      },
      run: async (getState) => {
        assert.deepEqual(getState().currentProviderModelOptions, [
          { value: 'pi-model', label: 'Pi Model' },
        ]);
        assert.equal(getState().currentProviderModel, 'pi-model');

        await act(async () => getState().setProvider('claude'));

        assert.equal(getState().providerCapabilityStatus, 'ready');
        assert.equal(getState().providerModelCatalog.claude, undefined);
        assert.deepEqual(getState().currentProviderModelOptions, []);
        assert.equal(getState().currentProviderModel, null);
      },
    });
  } finally {
    console.error = originalConsoleError;
    storage.clear();
  }
});

test('provider state does not infer effort support when the capability response omits it', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions'],
              defaultPermissionMode: 'bypassPermissions',
              supportsImages: true,
              supportsFiles: true,
              supportsAbort: true,
              supportsPermissionRequests: false,
              supportsTokenUsage: true,
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{
                value: 'pi-model',
                label: 'Pi Model',
                effort: { values: [{ value: 'high' }] },
              }],
              DEFAULT: 'pi-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: (getState) => {
      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.equal(getState().currentProviderModel, 'pi-model');
      assert.deepEqual(getState().currentProviderEffortOptions, []);
    },
  });
  storage.clear();
});

test('ready capability without supportsEffort normalizes persisted effort before immediate send', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  storage.set('pi-model', 'pi-model');
  storage.set('pi-effort', 'high');

  let resolveCapabilities: ((response: Response) => void) | null = null;
  let resolveModels: ((response: Response) => void) | null = null;
  const capabilitiesResponse = new Promise<Response>((resolve) => {
    resolveCapabilities = resolve;
  });
  const modelsResponse = new Promise<Response>((resolve) => {
    resolveModels = resolve;
  });
  let providerState: ReturnType<UseChatProviderState> | null = null;

  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return capabilitiesResponse;
      }
      if (url.includes('/api/providers/pi/models')) {
        return modelsResponse;
      }
      return jsonResponse({ success: false }, 500);
    },
    run: async (getState) => {
      assert.equal(getState().providerCapabilityStatus, 'loading');
      assert.equal(storage.get('pi-effort'), 'high');

      assert.ok(resolveModels);
      const completeModels = resolveModels;
      await act(async () => {
        completeModels(jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{
                value: 'pi-model',
                label: 'Pi Model',
                effort: { values: [{ value: 'high' }] },
              }],
              DEFAULT: 'pi-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.equal(getState().providerCapabilityStatus, 'loading');
      assert.equal(storage.get('pi-effort'), 'high');

      assert.ok(resolveCapabilities);
      const completeCapabilities = resolveCapabilities;
      await act(async () => {
        completeCapabilities(jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions'],
              defaultPermissionMode: 'bypassPermissions',
            }],
          },
        }));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.equal(getState().currentProviderModel, 'pi-model');
      assert.equal(getState().currentProviderEffort, 'default');
      assert.equal(storage.get('pi-effort'), 'default');
      providerState = getState();
    },
  });

  assert.ok(providerState);
  const resolvedProviderState: ReturnType<UseChatProviderState> = providerState;
  const sentMessages: Array<{ options?: { effort?: unknown } }> = [];
  const composerState = await renderHookOnServer<ComposerArgs, ReturnType<UseChatComposerState>>(
    '/src/components/chat/hooks/useChatComposerState.ts',
    'useChatComposerState',
    createComposerArgs({
      providerCapabilityStatus: resolvedProviderState.providerCapabilityStatus,
      permissionMode: resolvedProviderState.permissionMode,
      currentProviderModel: resolvedProviderState.currentProviderModel,
      currentProviderEffort: resolvedProviderState.currentProviderEffort,
      resolvePermissionModeForProvider: resolvedProviderState.resolvePermissionModeForProvider,
      sendMessage: (message) => sentMessages.push(message as never),
    }),
  );
  await composerState.handleSubmit(
    { preventDefault: noop } as never,
    { content: 'Send with validated effort', attachments: [] },
  );
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.options?.effort, 'default');
  storage.clear();
});

test('delayed provider readiness preserves a valid persisted effort until it can be reconciled', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  storage.set('pi-model', 'pi-model');
  storage.set('pi-effort', 'high');

  let resolveCapabilities: ((response: Response) => void) | null = null;
  let resolveModels: ((response: Response) => void) | null = null;
  const capabilitiesResponse = new Promise<Response>((resolve) => {
    resolveCapabilities = resolve;
  });
  const modelsResponse = new Promise<Response>((resolve) => {
    resolveModels = resolve;
  });

  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return capabilitiesResponse;
      }
      if (url.includes('/api/providers/pi/models')) {
        return modelsResponse;
      }
      return jsonResponse({ success: false }, 500);
    },
    run: async (getState) => {
      assert.equal(storage.get('pi-effort'), 'high');

      assert.ok(resolveCapabilities);
      const completeCapabilities = resolveCapabilities;
      await act(async () => {
        completeCapabilities(jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions'],
              defaultPermissionMode: 'bypassPermissions',
              supportsEffort: true,
              supportsTokenUsage: true,
            }],
          },
        }));
        await Promise.resolve();
      });
      assert.equal(storage.get('pi-effort'), 'high');

      assert.ok(resolveModels);
      const completeModels = resolveModels;
      await act(async () => {
        completeModels(jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{
                value: 'pi-model',
                label: 'Pi Model',
                effort: { values: [{ value: 'high' }] },
              }],
              DEFAULT: 'pi-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        }));
        await Promise.resolve();
      });

      assert.equal(storage.get('pi-effort'), 'high');
      assert.equal(getState().currentProviderEffort, 'high');
    },
  });
  storage.clear();
});

test('provider model selection has no provider-id default matrix and uses one shared resolver', () => {
  const providerStateSource = readChatSource('./hooks/useChatProviderState.ts');
  const emptyStateSource = readChatSource('./view/subcomponents/ProviderSelectionEmptyState.tsx');

  assert.doesNotMatch(providerStateSource, /FALLBACK_DEFAULT_MODEL/);
  assert.match(providerStateSource, /resolveProviderModelSelection/);
  assert.match(emptyStateSource, /resolveProviderModelSelection/);
});

test('token usage stays fail closed when the selected provider does not support it', async () => {
  let tokenUsageRequests = 0;
  const sessionStore = {
    setActiveSession: noop,
    getMessages: () => [],
    appendRealtime: noop,
    clearRealtime: noop,
    has: () => false,
    isStale: () => true,
    fetchFromServer: async () => ({
      hasMore: false,
      total: 0,
      tokenUsage: { used: 999 },
    }),
    fetchMore: async () => null,
    refreshFromServer: async () => null,
  };
  const sessionArgs = {
    selectedProject,
    selectedSession,
    ws: null,
    sendMessage: noop,
    resetStreamingState: noop,
    statusCheckSentAtRef: { current: new Map<string, number>() },
    lastSeqRef: { current: new Map<string, number>() },
    sessionStore,
    supportsTokenUsage: false,
  } as unknown as Parameters<UseChatSessionState>[0];

  await withMountedHook<Parameters<UseChatSessionState>[0], ReturnType<UseChatSessionState>>({
    modulePath: '/src/components/chat/hooks/useChatSessionState.ts',
    exportName: 'useChatSessionState',
    args: sessionArgs,
    fetchImpl: async (request) => {
      if (String(request).includes('/token-usage')) {
        tokenUsageRequests += 1;
      }
      return jsonResponse({ success: true, data: { used: 123 } });
    },
    run: (getState) => {
      assert.equal(tokenUsageRequests, 0);
      assert.equal(getState().tokenBudget, null);
    },
  });

  let realtimeListener: ((event: { kind?: string; [key: string]: unknown }) => void) | null = null;
  const realtimeBudgets: Array<Record<string, unknown> | null> = [];
  const realtimeProcessingMarks: Array<{
    sessionId: string | null | undefined;
    options: { statusText?: string | null; canInterrupt?: boolean } | undefined;
  }> = [];
  const realtimeArgs = {
    subscribe(listener: typeof realtimeListener) {
      realtimeListener = listener;
      return noop;
    },
    provider: 'pi',
    selectedSession,
    currentSessionId: selectedSession.id,
    supportsTokenUsage: false,
    setTokenBudget: (budget: Record<string, unknown> | null) => realtimeBudgets.push(budget),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: noop,
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map<string, number>() },
    statusCheckSentAtRef: { current: new Map<string, number>() },
    onSessionProcessing: (
      sessionId: string | null | undefined,
      options: { statusText?: string | null; canInterrupt?: boolean } | undefined,
    ) => realtimeProcessingMarks.push({ sessionId, options }),
    sessionStore,
  } as unknown as Parameters<UseChatRealtimeHandlers>[0];

  await withMountedHook<Parameters<UseChatRealtimeHandlers>[0], ReturnType<UseChatRealtimeHandlers>>({
    modulePath: '/src/components/chat/hooks/useChatRealtimeHandlers.ts',
    exportName: 'useChatRealtimeHandlers',
    args: realtimeArgs,
    fetchImpl: emptyComposerFetch,
    run: () => {
      assert.ok(realtimeListener);
      realtimeListener({
        kind: 'status',
        sessionId: selectedSession.id,
        text: 'token_budget',
        tokenBudget: { used: 456 },
      });
      assert.deepEqual(realtimeBudgets, []);
      assert.deepEqual(realtimeProcessingMarks, []);
    },
  });

  const hiddenUsage = renderToStaticMarkup(
    <TokenUsageSummary
      supported={false}
      usage={{ used: 789 }}
      onClick={noop}
    />,
  );
  const visibleUsage = renderToStaticMarkup(
    <TokenUsageSummary
      supported
      usage={{ used: 789 }}
      onClick={noop}
    />,
  );
  assert.equal(hiddenUsage, '');
  assert.match(visibleUsage, /Show token usage/);
});

test('a token usage request started before capability shutdown cannot restore stale usage', async () => {
  let resolveSessionFetch: ((slot: unknown) => void) | null = null;
  let sessionFetchCount = 0;
  const firstSessionFetch = new Promise<unknown>((resolve) => {
    resolveSessionFetch = resolve;
  });
  const sessionStore = {
    setActiveSession: noop,
    getMessages: () => [],
    appendRealtime: noop,
    clearRealtime: noop,
    has: () => false,
    isStale: () => true,
    fetchFromServer: async () => {
      sessionFetchCount += 1;
      return sessionFetchCount === 1
        ? firstSessionFetch
        : { hasMore: false, total: 0, tokenUsage: null };
    },
    fetchMore: async () => null,
    refreshFromServer: async () => null,
  };
  const baseArgs = {
    selectedProject,
    selectedSession,
    ws: null,
    sendMessage: noop,
    resetStreamingState: noop,
    statusCheckSentAtRef: { current: new Map<string, number>() },
    lastSeqRef: { current: new Map<string, number>() },
    sessionStore,
    supportsTokenUsage: true,
  } as unknown as Parameters<UseChatSessionState>[0];

  await withMountedHook<Parameters<UseChatSessionState>[0], ReturnType<UseChatSessionState>>({
    modulePath: '/src/components/chat/hooks/useChatSessionState.ts',
    exportName: 'useChatSessionState',
    args: baseArgs,
    fetchImpl: async () => jsonResponse({ success: true, data: null }),
    run: async (getState, rerender) => {
      assert.equal(sessionFetchCount, 1);
      await rerender({ ...baseArgs, supportsTokenUsage: false });
      assert.equal(getState().tokenBudget, null);

      assert.ok(resolveSessionFetch);
      const completeSessionFetch = resolveSessionFetch;
      await act(async () => {
        completeSessionFetch({ hasMore: false, total: 0, tokenUsage: { used: 999 } });
        await Promise.resolve();
      });

      assert.equal(getState().tokenBudget, null);
    },
  });
});

test('clearing the selected session cancels loading before an old session fetch completes', async () => {
  let resolveSessionFetch: ((slot: unknown) => void) | null = null;
  const sessionFetch = new Promise<unknown>((resolve) => {
    resolveSessionFetch = resolve;
  });
  const sessionStore = {
    setActiveSession: noop,
    getMessages: () => [],
    appendRealtime: noop,
    clearRealtime: noop,
    has: () => false,
    isStale: () => true,
    fetchFromServer: async () => sessionFetch,
    fetchMore: async () => null,
    refreshFromServer: async () => null,
  };
  const baseArgs = {
    selectedProject,
    selectedSession,
    ws: null,
    sendMessage: noop,
    resetStreamingState: noop,
    statusCheckSentAtRef: { current: new Map<string, number>() },
    lastSeqRef: { current: new Map<string, number>() },
    sessionStore,
    supportsTokenUsage: true,
    processingSessions: new Map([[
      selectedSession.id,
      { statusText: null, canInterrupt: true, startedAt: Date.now() },
    ]]),
  } as unknown as Parameters<UseChatSessionState>[0];

  await withMountedHook<Parameters<UseChatSessionState>[0], ReturnType<UseChatSessionState>>({
    modulePath: '/src/components/chat/hooks/useChatSessionState.ts',
    exportName: 'useChatSessionState',
    args: baseArgs,
    fetchImpl: async () => jsonResponse({ success: true, data: null }),
    run: async (getState, rerender) => {
      assert.equal(getState().isLoadingSessionMessages, true);
      await rerender({ ...baseArgs, selectedSession: null, supportsTokenUsage: false });
      assert.equal(getState().isLoadingSessionMessages, false);

      assert.ok(resolveSessionFetch);
      const completeSessionFetch = resolveSessionFetch;
      await act(async () => {
        completeSessionFetch({ hasMore: false, total: 0, tokenUsage: { used: 999 } });
        await Promise.resolve();
      });
      assert.equal(getState().tokenBudget, null);
    },
  });
});

test('agent permission settings are capability driven and have a generic provider path', async () => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const settingsModule = await vite.ssrLoadModule(
      '/src/components/settings/view/tabs/agents-settings/agentCategoryVisibility.ts',
    );
    const getVisibleAgentCategories = settingsModule.getVisibleAgentCategories as (
      capabilities: {
        permissionModes: string[];
        supportsMcp: boolean;
        supportsSkills: boolean;
      } | null,
    ) => string[];

    assert.equal(typeof getVisibleAgentCategories, 'function');
    assert.deepEqual(getVisibleAgentCategories(null), ['account']);
    assert.deepEqual(
      getVisibleAgentCategories({ permissionModes: [], supportsMcp: false, supportsSkills: true }),
      ['account', 'skills'],
    );
    assert.deepEqual(
      getVisibleAgentCategories({
        permissionModes: ['plan'],
        supportsMcp: false,
        supportsSkills: true,
      }),
      ['account', 'permissions', 'skills'],
    );
    assert.deepEqual(
      getVisibleAgentCategories({
        permissionModes: ['plan'],
        supportsMcp: true,
        supportsSkills: true,
      }),
      ['account', 'permissions', 'mcp', 'skills'],
    );

    const tabSource = readFileSync(
      new URL('../settings/view/tabs/agents-settings/AgentsSettingsTab.tsx', import.meta.url),
      'utf8',
    );
    const contentSource = readFileSync(
      new URL(
        '../settings/view/tabs/agents-settings/sections/AgentCategoryContentSection.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    assert.doesNotMatch(
      tabSource,
      /selectedAgent\s*[!=]==?\s*['"](?:claude|cursor|codex|opencode|pi)['"]/,
    );
    assert.doesNotMatch(
      contentSource,
      /selectedAgent\s*[!=]==?\s*['"](?:claude|cursor|codex|opencode|pi)['"]/,
    );
    assert.equal((contentSource.match(/<ProviderPermissionsContent/g) ?? []).length, 1);

    const permissionContentModule = await vite.ssrLoadModule(
      '/src/components/settings/view/tabs/agents-settings/sections/content/ProviderPermissionsContent.tsx',
    );
    const ProviderPermissionsContent = permissionContentModule.default as React.ComponentType<{
      agent: 'pi';
      permissionModes: string[];
      defaultPermissionMode: string | null;
      claudePermissions: { skipPermissions: boolean; allowedTools: string[]; disallowedTools: string[] };
      onClaudePermissionsChange: (value: unknown) => void;
      cursorPermissions: { skipPermissions: boolean; allowedCommands: string[]; disallowedCommands: string[] };
      onCursorPermissionsChange: (value: unknown) => void;
      codexPermissionMode: 'default';
      onCodexPermissionModeChange: (value: unknown) => void;
    }>;
    const genericPermissionsHtml = renderToStaticMarkup(
      <ProviderPermissionsContent
        agent="pi"
        permissionModes={['plan', 'bypassPermissions']}
        defaultPermissionMode="plan"
        claudePermissions={{ skipPermissions: false, allowedTools: [], disallowedTools: [] }}
        onClaudePermissionsChange={noop}
        cursorPermissions={{ skipPermissions: false, allowedCommands: [], disallowedCommands: [] }}
        onCursorPermissionsChange={noop}
        codexPermissionMode="default"
        onCodexPermissionModeChange={noop}
      />,
    );
    assert.match(genericPermissionsHtml, />plan</);
    assert.match(genericPermissionsHtml, />bypassPermissions</);
    assert.doesNotMatch(genericPermissionsHtml, /type="radio"/);
  } finally {
    await vite.close();
  }
});

test('MCP provider typing does not encode provider capability exclusions', () => {
  const mcpTypesSource = readFileSync(
    new URL('../mcp/types.ts', import.meta.url),
    'utf8',
  );

  assert.match(mcpTypesSource, /export type McpProvider\s*=\s*LLMProvider\s*;/);
  assert.doesNotMatch(mcpTypesSource, /Exclude<LLMProvider/);
});

test('MCP form behavior is driven by nested provider metadata and fails closed without it', async () => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const formattingModule = await vite.ssrLoadModule(
      '/src/components/mcp/utils/mcpFormatting.ts',
    );
    const createMcpPayloadFromForm = formattingModule.createMcpPayloadFromForm as (
      provider: 'pi' | 'codex',
      formData: Record<string, unknown>,
      capabilities?: {
        supportedScopes: Array<'user' | 'local' | 'project'>;
        supportedTransports: Array<'stdio' | 'http' | 'sse'>;
        supportsWorkingDirectory: boolean;
        supportsEnvironmentVariableReferences: boolean;
      },
    ) => Record<string, unknown>;
    const formData = {
      name: 'future-server',
      scope: 'local',
      workspacePath: '/workspace/project-one',
      transport: 'stdio',
      command: 'future-mcp',
      args: ['--serve'],
      env: { API_KEY: 'secret' },
      cwd: '/workspace/project-one/tools',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer static' },
      envVars: ['GITHUB_TOKEN'],
      bearerTokenEnvVar: 'MCP_TOKEN',
      envHttpHeaders: { Authorization: 'MCP_AUTH_HEADER' },
      importMode: 'form',
      jsonInput: '',
    };
    const futureCapabilities = {
      supportedScopes: ['local'] as const,
      supportedTransports: ['stdio', 'http'] as const,
      supportsWorkingDirectory: true,
      supportsEnvironmentVariableReferences: true,
    };

    const stdioPayload = createMcpPayloadFromForm(
      'pi',
      formData,
      futureCapabilities as never,
    );
    assert.equal(stdioPayload.scope, 'local');
    assert.equal(stdioPayload.cwd, '/workspace/project-one/tools');
    assert.deepEqual(stdioPayload.envVars, ['GITHUB_TOKEN']);

    const httpPayload = createMcpPayloadFromForm(
      'pi',
      { ...formData, transport: 'http' },
      futureCapabilities as never,
    );
    assert.equal(httpPayload.bearerTokenEnvVar, 'MCP_TOKEN');
    assert.deepEqual(httpPayload.envHttpHeaders, { Authorization: 'MCP_AUTH_HEADER' });

    const disabledMetadataPayload = createMcpPayloadFromForm(
      'codex',
      formData,
      {
        supportedScopes: ['local'],
        supportedTransports: ['stdio'],
        supportsWorkingDirectory: false,
        supportsEnvironmentVariableReferences: false,
      },
    );
    assert.equal(disabledMetadataPayload.cwd, undefined);
    assert.equal(disabledMetadataPayload.envVars, undefined);
    assert.equal(disabledMetadataPayload.bearerTokenEnvVar, undefined);
    assert.equal(disabledMetadataPayload.envHttpHeaders, undefined);

    assert.throws(
      () => createMcpPayloadFromForm(
        'pi',
        { ...formData, scope: 'user' },
        futureCapabilities as never,
      ),
      /does not support user MCP scope/i,
    );
    assert.throws(
      () => createMcpPayloadFromForm(
        'pi',
        { ...formData, transport: 'sse' },
        futureCapabilities as never,
      ),
      /does not support sse MCP servers/i,
    );
    assert.throws(
      () => createMcpPayloadFromForm('pi', formData),
      /MCP capabilities are unavailable/i,
    );
  } finally {
    await vite.close();
  }
});

test('MCP consumers do not maintain provider capability matrices or Codex-only runtime branches', () => {
  const capabilityMatrixPattern = /MCP_(?:SCOPE|TRANSPORT|WORKING_DIRECTORY)_OVERRIDES|MCP_SUPPORTED_SCOPES|MCP_SUPPORTED_TRANSPORTS|MCP_SUPPORTS_WORKING_DIRECTORY/;
  const mcpSources = [
    '../mcp/constants.ts',
    '../mcp/hooks/useMcpServerForm.ts',
    '../mcp/hooks/useMcpServers.ts',
    '../mcp/view/modals/McpServerFormModal.tsx',
    '../mcp/utils/mcpFormatting.ts',
  ];

  for (const relativePath of mcpSources) {
    const source = readChatSource(relativePath);
    assert.doesNotMatch(source, capabilityMatrixPattern);
  }

  const formattingSource = readChatSource('../mcp/utils/mcpFormatting.ts');
  const modalSource = readChatSource('../mcp/view/modals/McpServerFormModal.tsx');
  assert.doesNotMatch(formattingSource, /provider\s*===\s*['"]codex['"]/);
  assert.doesNotMatch(modalSource, /provider\s*===\s*['"]codex['"]|showCodexOnlyFields/);

  const settingsSource = readChatSource(
    '../settings/view/tabs/agents-settings/AgentsSettingsTab.tsx',
  );
  const contentSource = readChatSource(
    '../settings/view/tabs/agents-settings/sections/AgentCategoryContentSection.tsx',
  );
  const serversSource = readChatSource('../mcp/view/McpServers.tsx');
  assert.match(settingsSource, /mcpCapabilities/);
  assert.match(contentSource, /mcpCapabilities/);
  assert.match(serversSource, /mcpCapabilities/);
  assert.doesNotMatch(serversSource, /Claude, Cursor, Codex, and OpenCode|every provider: Claude/);
});

test('provider branding stays static while generic behavior and display consumers remain extension safe', async () => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const brandingModule = await vite.ssrLoadModule(
      '/src/components/llm-logo-provider/providerBranding.tsx',
    );
    const providerIds = brandingModule.PROVIDER_IDS as string[];
    assert.deepEqual(providerIds, Object.keys(brandingModule.PROVIDER_BRANDS));
    assert.equal(new Set(providerIds).size, providerIds.length);
    assert.equal(brandingModule.PROVIDER_BRANDS.claude.displayName, 'Claude');
    assert.equal(brandingModule.PROVIDER_BRANDS.codex.companyName, 'OpenAI');
    assert.equal(brandingModule.PROVIDER_BRANDS.claude.skillPath, '~/.claude/skills/<skill-name>/SKILL.md');
    assert.equal(brandingModule.PROVIDER_BRANDS.pi.skillPath, undefined);
    assert.equal(brandingModule.getProviderDisplayName('pi'), 'Pi');
    assert.equal(brandingModule.getProviderDisplayName('future-provider'), 'future-provider');
    for (const providerId of providerIds) {
      const brand = brandingModule.PROVIDER_BRANDS[providerId] as Record<string, unknown>;
      assert.equal(
        typeof (brand.readyPrompt as { key?: unknown }).key,
        'string',
      );
      assert.equal(
        typeof brand.skillsLabel,
        'string',
      );
      assert.equal(typeof (brand.messageLabel as { key?: unknown }).key, 'string');
      assert.equal(typeof (brand.login as { title?: unknown }).title, 'string');
      assert.equal(typeof (brand.login as { command?: unknown }).command, 'string');
      assert.equal(typeof (brand.onboarding as { title?: unknown }).title, 'string');
      assert.equal('toolsSettingsStorageKey' in brand, false);
      assert.equal('grantToolPermission' in brand, false);
    }

    const brandingSource = readChatSource('../llm-logo-provider/providerBranding.tsx');
    assert.doesNotMatch(brandingSource, /chatPermissions|toolsSettingsStorageKey|grantToolPermission/);
    assert.match(brandingSource, /export type LLMProvider\s*=\s*keyof typeof PROVIDER_BRANDS/);

    const appTypesSource = readChatSource('../../types/app.ts');
    assert.match(
      appTypesSource,
      /import type \{ LLMProvider \} from ['"]\.\.\/components\/llm-logo-provider\/providerBranding['"]/,
    );
    assert.match(appTypesSource, /export type \{ LLMProvider \}/);
    assert.doesNotMatch(
      appTypesSource,
      /type LLMProvider\s*=\s*['"]claude['"]/,
    );

    const behaviorModule = await vite.ssrLoadModule(
      '/src/components/chat/utils/providerBehavior.ts',
    );
    assert.equal(behaviorModule.getProviderToolsSettingsStorageKey('future-provider'), 'future-provider-settings');
    assert.equal(behaviorModule.getProviderToolsSettingsStorageKey('cursor'), 'cursor-tools-settings');
    assert.deepEqual(
      behaviorModule.grantProviderToolPermission('future-provider', 'Read'),
      { success: false },
    );

    const consumers = [
      './hooks/useChatProviderState.ts',
      './view/subcomponents/ProviderSelectionEmptyState.tsx',
      '../settings/constants/constants.ts',
      '../settings/view/tabs/agents-settings/AgentsSettingsTab.tsx',
      '../settings/view/tabs/agents-settings/sections/AgentCategoryTabsSection.tsx',
      '../provider-auth/types.ts',
      '../mcp/constants.ts',
      '../skills/view/ProviderSkills.tsx',
      '../provider-auth/view/ProviderLoginModal.tsx',
      './view/ChatInterface.tsx',
      './view/subcomponents/MessageComponent.tsx',
      './view/subcomponents/CommandResultModal.tsx',
      '../onboarding/view/subcomponents/AgentConnectionsStep.tsx',
    ];
    for (const consumer of consumers) {
      const source = readFileSync(new URL(consumer, import.meta.url), 'utf8');
      assert.match(source, /providerBranding/);
      assert.doesNotMatch(
        source,
        /\[['"]claude['"],\s*['"]cursor['"],\s*['"]codex['"],\s*['"]opencode['"],\s*['"]pi['"]\]/,
      );
    }

    const emptyStateSource = readFileSync(
      new URL('./view/subcomponents/ProviderSelectionEmptyState.tsx', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(emptyStateSource, /readyPrompt\.claude/);

    const composerSource = readChatSource('./hooks/useChatComposerState.ts');
    assert.match(composerSource, /providerBehavior/);
    assert.doesNotMatch(composerSource, /toolsSettingsStorageKey|grantToolPermission/);

    const commandResultSource = readChatSource('./view/subcomponents/CommandResultModal.tsx');
    assert.doesNotMatch(commandResultSource, /PROVIDER_LABELS/);
    assert.match(commandResultSource, /getProviderDisplayName/);

    const providerSkillsSource = readChatSource('../skills/view/ProviderSkills.tsx');
    assert.doesNotMatch(providerSkillsSource, /PROVIDER_SKILL_PATHS/);
    assert.match(providerSkillsSource, /skillPath/);

    const categoryTabsSource = readFileSync(
      new URL(
        '../settings/view/tabs/agents-settings/sections/AgentCategoryTabsSection.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    assert.doesNotMatch(categoryTabsSource, /selectedAgent\s*===\s*['"]opencode['"]/);

    const providerBehaviorConsumers = [
      '../provider-auth/view/ProviderLoginModal.tsx',
      './view/ChatInterface.tsx',
      './view/subcomponents/MessageComponent.tsx',
      '../onboarding/view/subcomponents/AgentConnectionsStep.tsx',
    ];
    for (const consumer of providerBehaviorConsumers) {
      const source = readFileSync(new URL(consumer, import.meta.url), 'utf8');
      assert.doesNotMatch(
        source,
        /provider\s*[!=]==?\s*['"](?:claude|cursor|codex|opencode|pi)['"]/,
      );
      assert.doesNotMatch(
        source,
        /provider:\s*['"](?:claude|cursor|codex|opencode|pi)['"]/,
      );
    }
  } finally {
    await vite.close();
  }
});

test('model chooser remains reachable through another provider catalog while sending stays fail closed', async () => {
  const selfGlobal = globalThis as typeof globalThis & { self?: typeof globalThis };
  const hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
  const originalSelf = selfGlobal.self;
  Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const componentModule = await vite.ssrLoadModule(
      '/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx',
    );
    const ProviderSelectionEmptyState = componentModule.default as ProviderSelectionEmptyStateComponent;
    const html = renderToStaticMarkup(
      <ProviderSelectionEmptyState
        selectedSession={null}
        currentSessionId={null}
        provider="pi"
        providerCapabilityStatus="ready"
        setProvider={noop}
        textareaRef={{ current: null }}
        providerModels={{ claude: 'claude-model' }}
        setStoredProviderModel={noop}
        providerModelCatalog={{
          claude: {
            OPTIONS: [{ value: 'claude-model', label: 'Claude Model' }],
            DEFAULT: 'claude-model',
          },
        }}
        providerModelsLoading={false}
        tasksEnabled={false}
        isTaskMasterInstalled={false}
        setInput={noop as never}
      />,
    );
    assert.doesNotMatch(html, /aria-disabled="true"/);
    assert.match(html, /Choose a model/i);
  } finally {
    await vite.close();
    if (hadSelf) {
      Object.defineProperty(globalThis, 'self', { configurable: true, value: originalSelf });
    } else {
      Reflect.deleteProperty(globalThis, 'self');
    }
  }

  const sentMessages: unknown[] = [];
  const composerState = await renderHookOnServer<ComposerArgs, ReturnType<UseChatComposerState>>(
    '/src/components/chat/hooks/useChatComposerState.ts',
    'useChatComposerState',
    createComposerArgs({
      providerCapabilityStatus: 'ready',
      permissionMode: 'plan',
      currentProviderModel: null,
      resolvePermissionModeForProvider: (_provider, mode) => mode === 'plan' ? mode : null,
      sendMessage: (message) => sentMessages.push(message),
    }),
  );
  await composerState.handleSubmit(
    { preventDefault: noop } as never,
    { content: 'Must remain blocked', attachments: [] },
  );
  assert.deepEqual(sentMessages, []);
});

test('provider state preserves an explicit active session model missing from the current catalog', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
            }],
          },
        });
      }
      if (url.includes('/sessions/session-1/active-model')) {
        return jsonResponse({
          success: true,
          data: {
            provider: 'pi',
            sessionId: 'session-1',
            model: 'removed-model',
            source: 'session',
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'catalog-model', label: 'Catalog Model' }],
              DEFAULT: 'catalog-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        });
      }
      return jsonResponse({ success: false }, 500);
    },
    run: (getState) => {
      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.deepEqual(getState().currentProviderModelOptions, [
        { value: 'catalog-model', label: 'Catalog Model' },
        { value: 'removed-model', label: 'removed-model' },
      ]);
      assert.equal(getState().currentProviderModel, 'removed-model');
    },
  });
  storage.clear();
});

test('session-only model does not make an unavailable catalog selectable', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions'],
              defaultPermissionMode: 'bypassPermissions',
            }],
          },
        });
      }
      if (url.includes('/sessions/session-1/active-model')) {
        return jsonResponse({
          success: true,
          data: {
            provider: 'pi',
            sessionId: 'session-1',
            model: 'removed-model',
            source: 'session',
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({ success: false }, 500);
      }
      return jsonResponse({ success: false }, 500);
    },
    run: (getState) => {
      assert.equal(getState().currentProviderModel, 'removed-model');
      assert.deepEqual(getState().currentProviderModelOptions, []);
    },
  });
  storage.clear();
});

test('switching sessions invalidates the previous active model until the new session resolves', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  let nextSessionModelRequested = false;

  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
              supportsImages: true,
              supportsFiles: true,
              supportsAbort: true,
              supportsPermissionRequests: false,
              supportsTokenUsage: true,
              supportsEffort: true,
            }],
          },
        });
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'old-model', label: 'Old Model' }],
              DEFAULT: 'old-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        });
      }
      if (url.includes('/sessions/session-1/active-model')) {
        return jsonResponse({
          success: true,
          data: { provider: 'pi', sessionId: 'session-1', model: 'old-model', source: 'session' },
        });
      }
      if (url.includes('/sessions/session-2/active-model')) {
        nextSessionModelRequested = true;
        return new Promise<Response>(() => undefined);
      }
      return jsonResponse({ success: false });
    },
    run: async (getState, rerender) => {
      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.equal(getState().currentProviderModel, 'old-model');

      await rerender({
        selectedProject: null,
        selectedSession: { id: 'session-2', __provider: 'pi' },
      });

      assert.equal(nextSessionModelRequested, true);
      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.equal(getState().currentProviderModel, null);
    },
  });
  storage.clear();
});

test('malformed or mismatched active-model success responses remain fail closed', async () => {
  const invalidBodies = [
    { success: true },
    {
      success: true,
      data: { provider: 'codex', sessionId: 'session-1', model: 'catalog-model', source: 'session' },
    },
    {
      success: true,
      data: { provider: 'pi', sessionId: 'another-session', model: 'catalog-model', source: 'session' },
    },
  ];
  const originalConsoleError = console.error;
  console.error = noop;
  try {
    for (const activeModelBody of invalidBodies) {
      storage.clear();
      storage.set('selected-provider', 'pi');
      await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
        modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
        exportName: 'useChatProviderState',
        args: { selectedProject: null, selectedSession },
        fetchImpl: async (request) => {
          const url = String(request);
          if (url.includes('/api/providers/capabilities')) {
            return jsonResponse({
              success: true,
              data: {
                providers: [{
                  provider: 'pi',
                  permissionModes: ['bypassPermissions', 'plan'],
                  defaultPermissionMode: 'bypassPermissions',
                }],
              },
            });
          }
          if (url.includes('/sessions/session-1/active-model')) {
            return jsonResponse(activeModelBody);
          }
          if (url.includes('/api/providers/pi/models')) {
            return jsonResponse({
              success: true,
              data: {
                models: {
                  OPTIONS: [{ value: 'catalog-model', label: 'Catalog Model' }],
                  DEFAULT: 'catalog-model',
                },
                cache: {
                  updatedAt: '2026-08-05T00:00:00.000Z',
                  expiresAt: '2026-08-05T01:00:00.000Z',
                  source: 'fresh',
                },
              },
            });
          }
          return jsonResponse({ success: false });
        },
        run: (getState) => {
          assert.equal(getState().providerCapabilityStatus, 'ready');
          assert.equal(getState().currentProviderModel, null);
        },
      });
    }
  } finally {
    console.error = originalConsoleError;
    storage.clear();
  }
});

test('active-model API errors keep every submission path fail closed despite a ready catalog', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  let providerState: ReturnType<UseChatProviderState> | null = null;

  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession },
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.includes('/api/providers/capabilities')) {
        return jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
              supportsImages: true,
              supportsFiles: true,
              supportsAbort: true,
              supportsPermissionRequests: false,
              supportsTokenUsage: true,
              supportsEffort: true,
            }],
          },
        });
      }
      if (url.includes('/sessions/session-1/active-model')) {
        return jsonResponse({ success: false }, 500);
      }
      if (url.includes('/api/providers/pi/models')) {
        return jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{ value: 'catalog-model', label: 'Catalog Model' }],
              DEFAULT: 'catalog-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        });
      }
      return jsonResponse({ success: false });
    },
    run: (getState) => {
      providerState = getState();
    },
  });

  assert.ok(providerState);
  const resolvedProviderState: ReturnType<UseChatProviderState> = providerState;
  assert.equal(resolvedProviderState.providerCapabilityStatus, 'ready');
  assert.equal(resolvedProviderState.permissionMode, 'bypassPermissions');

  storage.set('queued_message_session-1', JSON.stringify({
    content: 'Do not replay after an active-model error',
    options: { model: 'stale-model', permissionMode: 'default' },
  }));
  const sentMessages: unknown[] = [];
  await withMountedHook<ComposerArgs, ReturnType<UseChatComposerState>>({
    modulePath: '/src/components/chat/hooks/useChatComposerState.ts',
    exportName: 'useChatComposerState',
    args: createComposerArgs({
      providerCapabilityStatus: resolvedProviderState.providerCapabilityStatus,
      permissionMode: resolvedProviderState.permissionMode,
      currentProviderModel: resolvedProviderState.currentProviderModel,
      resolvePermissionModeForProvider: resolvedProviderState.resolvePermissionModeForProvider,
      sendMessage: (message) => sentMessages.push(message),
    }),
    fetchImpl: emptyComposerFetch,
    run: async (getState) => {
      await act(async () => getState().handleInputChange({
        target: { value: 'Keyboard message', selectionStart: 16, style: {} },
      } as never));
      await act(async () => getState().handleKeyDown({
        key: 'Enter',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: noop,
      } as never));
      await act(async () => getState().handleVoiceTranscript('Voice message', true));
      await act(async () => getState().handleSubmit(
        { preventDefault: noop } as never,
        { content: 'Direct message', attachments: [] },
      ));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));

      assert.deepEqual(sentMessages, []);
      assert.equal(storage.has('queued_message_session-1'), true);
    },
  });
  assert.equal(resolvedProviderState.currentProviderModel, null);
  storage.clear();
});

test('provider state preserves backend model and permission behavior once capabilities are ready', async () => {
  storage.clear();
  storage.set('selected-provider', 'pi');
  await withMountedHook<Parameters<UseChatProviderState>[0], ReturnType<UseChatProviderState>>({
    modulePath: '/src/components/chat/hooks/useChatProviderState.ts',
    exportName: 'useChatProviderState',
    args: { selectedProject: null, selectedSession: null },
    fetchImpl: async (request) => String(request).includes('/api/providers/capabilities')
      ? jsonResponse({
          success: true,
          data: {
            providers: [{
              provider: 'pi',
              permissionModes: ['bypassPermissions', 'plan'],
              defaultPermissionMode: 'bypassPermissions',
              supportsImages: true,
              supportsFiles: true,
              supportsAbort: true,
              supportsPermissionRequests: false,
              supportsTokenUsage: true,
              supportsEffort: true,
            }],
          },
        })
      : jsonResponse({
          success: true,
          data: {
            models: {
              OPTIONS: [{
                value: 'pi-model',
                label: 'Pi Model',
                effort: { values: [{ value: 'high' }] },
              }],
              DEFAULT: 'pi-model',
            },
            cache: {
              updatedAt: '2026-08-05T00:00:00.000Z',
              expiresAt: '2026-08-05T01:00:00.000Z',
              source: 'fresh',
            },
          },
        }),
    run: (getState) => {
      assert.equal(getState().providerCapabilityStatus, 'ready');
      assert.deepEqual(getState().availablePermissionModes, ['bypassPermissions', 'plan']);
      assert.equal(getState().permissionMode, 'bypassPermissions');
      assert.equal(getState().currentProviderModel, 'pi-model');
      assert.deepEqual(getState().currentProviderEffortOptions, [{ value: 'high' }]);
    },
  });
  storage.clear();
});
