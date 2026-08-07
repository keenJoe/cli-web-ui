import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  IProviderEventSink,
  IProviderRuntime,
} from '@/shared/interfaces.js';
import type {
  ProviderRunEvent,
  ProviderRunOutcome,
  ProviderRunRequest,
} from '@/shared/types.js';

const request: ProviderRunRequest = {
  runId: 'run-1',
  provider: 'claude',
  appSessionId: 'app-session-1',
  providerSessionId: null,
  command: 'hello',
  permissionMode: 'default',
  userId: null,
};

const errorEvent: ProviderRunEvent = {
  id: 'event-1',
  kind: 'error',
  provider: 'claude',
  sessionId: 'app-session-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  content: 'runtime failed',
};

const completedOutcome: ProviderRunOutcome = {
  status: 'completed',
  providerSessionId: 'native-session-1',
  exitCode: 0,
};

test('4.1 typed runtime accepts non-terminal events and returns a typed outcome', async () => {
  const emitted: ProviderRunEvent[] = [];
  const bindings: string[] = [];
  const sink: IProviderEventSink = {
    emit(event) {
      emitted.push(event);
    },
    bindProviderSession(binding) {
      bindings.push(binding.providerSessionId);
    },
  };
  const runtime: IProviderRuntime = {
    async run(receivedRequest, receivedSink) {
      assert.equal(receivedRequest, request);
      receivedSink.bindProviderSession({ providerSessionId: 'native-session-1' });
      receivedSink.emit(errorEvent);
      return completedOutcome;
    },
  };

  const outcome = await runtime.run(
    request,
    sink,
    {} as never,
    new AbortController().signal,
  );

  assert.deepEqual(bindings, ['native-session-1']);
  assert.deepEqual(emitted, [errorEvent]);
  assert.deepEqual(outcome, completedOutcome);

  if (false) {
    // @ts-expect-error Runtime sinks cannot emit application-owned completion.
    sink.emit({ ...errorEvent, kind: 'complete' });
    // @ts-expect-error Native identity is bound through bindProviderSession only.
    sink.emit({ ...errorEvent, kind: 'session_created' });
    // @ts-expect-error Cancellation is coordinator-owned through AbortSignal.
    await runtime.abort('app-session-1');
  }
});
