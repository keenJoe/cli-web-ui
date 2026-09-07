/**
 * E2E fixture extension (task 8.3 / T40) loaded into a REAL Pi 0.84.4 RPC
 * child alongside the REAL cloudcli-vision-bridge extension.
 *
 * It is intentionally import-free so Pi's jiti loader can resolve it from any
 * absolute path without node_modules resolution surprises. It registers two
 * controlled, credential-free providers via pi.registerProvider():
 *
 *  - cloudcli-test-vision : a "vision" model (input includes "image") whose
 *    streamSimple records the image bytes it received and returns a canned
 *    untrusted observation. This is the controlled local vision provider.
 *  - cloudcli-test-main   : a no-vision text model (input ["text"]) whose
 *    streamSimple records the provider-neutral context it received (structure
 *    only — never image bytes) and returns a canned assistant reply. This is
 *    the "无视觉主 provider": it must receive the observation text, NOT the
 *    original image.
 *
 * Both providers use a custom api kind ("cloudcli-test-api") and a literal
 * apiKey so provider-composer routes stream->streamSimple with no network and
 * no real credentials. Records are written to $CLOUDCLI_E2E_RECORD_DIR so the
 * host-side driver (separate process) can assert against them.
 *
 * The streamSimple handlers return a duck-typed AssistantMessageEventStream
 * (async-iterable yielding a `done` event + a result() resolver), matching the
 * shape ModelRegistry.complete() consumes (proven by the group-1 contract test
 * block (b) and by lazyStream/forwardStream in @earendil-works/pi-ai).
 */

const VISION_PROVIDER = 'cloudcli-test-vision';
const VISION_MODEL = 'vision-model';
const MAIN_PROVIDER = 'cloudcli-test-main';
const MAIN_MODEL = 'main-model';
const API_KIND = 'cloudcli-test-api';

const RECORD_DIR = process.env.CLOUDCLI_E2E_RECORD_DIR;

function record(name: string, payload: unknown): void {
  // Defensive: the fixture runs in the child; if RECORD_DIR is unset, skip
  // silently rather than crash the turn. The host always sets it.
  if (!RECORD_DIR) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RECORD_DIR, name),
      JSON.stringify({ ...payload, recordedAt: Date.now() }),
    );
  } catch {
    /* best-effort record; never fail the turn on a recording error */
  }
}

function assistantMessage(provider: string, modelId: string, text: string): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: API_KIND,
    provider,
    model: modelId,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** Duck-typed AssistantMessageEventStream: async-iterable + result(). */
function duckStream(message: any): any {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: 'stop', message };
    },
    result: () => Promise.resolve(message),
  };
}

/**
 * Structural snapshot of a provider-neutral context, with image `data` stripped
 * (only presence + length recorded) so no image bytes ever hit the record.
 */
function snapshotContext(context: any): any {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  return {
    messageCount: messages.length,
    messages: messages.map((m: any) => ({
      role: m?.role,
      toolCallId: m?.toolCallId,
      contentBlocks: Array.isArray(m?.content)
        ? m.content.map((b: any) => {
            if (b?.type === 'image') {
              return { type: 'image', hasData: typeof b.data === 'string', dataLength: b.data?.length };
            }
            if (b?.type === 'text') {
              return { type: 'text', text: b.text?.slice(0, 400) };
            }
            return { type: b?.type };
          })
        : typeof m?.content === 'string'
          ? [{ type: 'string-text', text: m.content.slice(0, 400) }]
          : [],
    })),
  };
}

export default function visionBridgeE2eFixture(pi: any): void {
  // Vision provider: controlled local vision fake. Records the image it
  // received and returns a canned observation. No network, no credentials.
  pi.registerProvider(VISION_PROVIDER, {
    name: 'CloudCLI E2E Vision Fake',
    baseUrl: 'https://cloudcli-e2e-vision.invalid/v1',
    apiKey: 'e2e-fake-vision-key',
    api: API_KIND,
    models: [
      {
        id: VISION_MODEL,
        name: 'E2E Vision Model',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: (model: any, context: any, _options: any) => {
      // Record exactly what the vision model was handed: the user message
      // text + the image block presence/base64 length/mimeType. The base64
      // is the secure adapter output (path->base64), so recording its length
      // and mimeType proves the adapter generated real ImageContent.
      const msgs = Array.isArray(context?.messages) ? context.messages : [];
      const userMsg = msgs.find((m: any) => m?.role === 'user');
      const imgBlock = Array.isArray(userMsg?.content)
        ? userMsg.content.find((b: any) => b?.type === 'image')
        : undefined;
      record('vision-received.json', {
        provider: VISION_PROVIDER,
        modelId: VISION_MODEL,
        receivedText: userMsg?.content?.find?.((b: any) => b?.type === 'text')?.text?.slice(0, 200),
        receivedImage: imgBlock
          ? { type: imgBlock.type, mimeType: imgBlock.mimeType, dataLength: imgBlock.data?.length }
          : null,
      });
      return duckStream(assistantMessage(VISION_PROVIDER, VISION_MODEL, 'E2E 视觉观察：图中显示一个红色方块'));
    },
  });

  // Main provider: no-vision text model. Records the transformed context it
  // received (structure only, image bytes stripped) and returns a canned
  // reply so the turn settles.
  pi.registerProvider(MAIN_PROVIDER, {
    name: 'CloudCLI E2E Main Fake',
    baseUrl: 'https://cloudcli-e2e-main.invalid/v1',
    apiKey: 'e2e-fake-main-key',
    api: API_KIND,
    models: [
      {
        id: MAIN_MODEL,
        name: 'E2E Main Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: (model: any, context: any, _options: any) => {
      const snap = snapshotContext(context);
      const hasImage = snap.messages.some((m: any) =>
        m.contentBlocks.some((b: any) => b.type === 'image' && b.hasData),
      );
      record('main-received.json', {
        provider: MAIN_PROVIDER,
        modelId: MAIN_MODEL,
        hasImageBlock: hasImage,
        context: snap,
      });
      return duckStream(assistantMessage(MAIN_PROVIDER, MAIN_MODEL, 'E2E 主模型回复：已确认视觉观察'));
    },
  });
}
