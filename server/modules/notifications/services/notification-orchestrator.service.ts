import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';
import type { LLMProvider, NotificationEvent } from '@/shared/types.js';

type NotificationPreferences = ReturnType<typeof notificationPreferencesDb.getPreferences>;
type NotificationProvider = NotificationEvent['provider'];
type NotificationMetadata = NotificationEvent['meta'] & {
  error?: string;
  message?: unknown;
  sessionName?: unknown;
  stopReason?: string;
  toolName?: string;
};
type CreateNotificationEventInput = {
  provider: NotificationProvider;
  sessionId?: string | null;
  kind?: string;
  code?: string;
  meta?: NotificationMetadata;
  severity?: string;
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
};
type NotificationPayloadEvent = Omit<Pick<
  NotificationEvent,
  'provider' | 'sessionId' | 'kind' | 'code' | 'meta'
>, 'meta'> & {
  meta: NotificationMetadata;
} & Partial<Pick<
  NotificationEvent,
  'severity' | 'requiresUserAction' | 'dedupeKey' | 'createdAt'
>>;
type NotificationPayload = {
  title: string;
  body: string;
  data: {
    sessionId: string | null;
    code: string;
    provider: NotificationProvider | null;
    sessionName: string | null;
    tag: string;
  };
};
type NotificationChannelInput = {
  userId: number;
  event: NotificationEvent;
  payload: NotificationPayload;
};
type NotificationChannel = {
  id: string;
  isEnabled(preferences: NotificationPreferences): boolean;
  send(input: NotificationChannelInput): unknown | Promise<unknown>;
};
type SessionRow = ReturnType<typeof sessionsDb.getSessionById>;

const KIND_TO_PREF_KEY: Record<string, keyof NotificationPreferences['events']> = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS: Partial<Record<NotificationProvider, string>> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  system: 'System'
};

const recentEventKeys = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(
  preferences: NotificationPreferences,
  event: NotificationEvent,
): boolean {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event: NotificationEvent): boolean {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

/** Provider runtimes and Settings use this factory to create normalized delivery events. */
export function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}: CreateNotificationEventInput): NotificationEvent {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof error.message === 'string'
  ) {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName: unknown): string | null {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(
  row: SessionRow,
  provider: NotificationProvider,
): row is NonNullable<SessionRow> {
  return Boolean(row && row.provider === provider);
}

function resolveSessionRow(
  sessionId: string | null,
  provider: NotificationProvider,
): SessionRow {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId, provider);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession<TEvent extends NotificationPayloadEvent>(event: TEvent): TEvent {
  if (!event.sessionId || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  } as TEvent;
}

function resolveSessionName(event: NotificationPayloadEvent): string | null {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

/** Notification delivery and its integration tests use this to render channel payloads. */
export function buildNotificationPayload(event: NotificationPayloadEvent): NotificationPayload {
  const normalizedEvent = normalizeNotificationSession(event);
  const CODE_MAP: Record<string, string> = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId: number, payload: NotificationPayload): Promise<void> {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = result.reason?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

const notificationChannels: NotificationChannel[] = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences) => Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }) => sendDesktopNotificationToClients(userId, payload)
  }
];

/** Provider runtimes and Settings use this to deliver an event through enabled channels. */
export function notifyUserIfEnabled({
  userId,
  event,
}: {
  userId: number | null | undefined;
  event: NotificationEvent | null | undefined;
}): void {
  if (!userId || !event) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event);
  const preferences = notificationPreferencesDb.getPreferences(userId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, event: normalizedEvent, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

/** Provider runtimes use this helper to report completed or aborted runs. */
export function notifyRunStopped({
  userId,
  provider,
  sessionId = null,
  stopReason = 'completed',
  sessionName = null,
}: {
  userId: number | null | undefined;
  provider: LLMProvider;
  sessionId?: string | null;
  stopReason?: string;
  sessionName?: string | null;
}): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/** Provider runtimes use this helper to report failed runs. */
export function notifyRunFailed({
  userId,
  provider,
  sessionId = null,
  error,
  sessionName = null,
}: {
  userId: number | null | undefined;
  provider: LLMProvider;
  sessionId?: string | null;
  error: unknown;
  sessionName?: string | null;
}): void {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}
