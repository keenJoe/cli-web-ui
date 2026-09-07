import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import type { VisionBridgeConfigService } from '../vision-bridge-config.service.js';
import { createVisionBridgeRouter } from '../vision-bridge.routes.js';
import {
  VISION_BRIDGE_CONFIG_INVALID,
  VISION_BRIDGE_CONFIG_WRITE_FAILED,
  VISION_BRIDGE_MODEL_NOT_VISION,
  VISION_BRIDGE_MODELS_UNAVAILABLE,
} from '../../../../shared/vision-bridge.js';

type CatalogService = {
  getPublicConfig(userId: string): Promise<unknown>;
  saveConfig(userId: string, update: unknown): Promise<unknown>;
  listModels(userId?: string): Promise<unknown>;
};

function buildService(overrides: Partial<CatalogService> = {}): VisionBridgeConfigService {
  return {
    getPublicConfig: async (userId: string) => overrides.getPublicConfig?.(userId) ?? {
      schemaVersion: 1,
      enabled: false,
      maxImagesPerRun: 4,
      timeoutMs: 20000,
      concurrency: 2,
      maxTokens: 1024,
      promptTemplate: 'default',
      sources: { userImages: true, toolImages: false },
    },
    saveConfig: async (userId: string, update: unknown) =>
      overrides.saveConfig?.(userId, update) ?? { enabled: true },
    listModels: async (userId?: string) =>
      overrides.listModels?.(userId) ?? {
        available: true,
        models: [{ provider: 'openai', id: 'gpt-4o-mini', credentialAvailable: true }],
      },
    resolveLaunchPolicy: async () => ({ enabled: false, configPath: null, diagnostics: [] }),
  } as unknown as VisionBridgeConfigService;
}

type TestUser = { id: number | string };

function buildApp(service: VisionBridgeConfigService, user?: TestUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      (req as Request & { user?: TestUser }).user = user;
    }
    next();
  });
  app.use('/api/vision-bridge', createVisionBridgeRouter(service));
  // Mirror the server's error envelope middleware so AppError responses are
  // shaped identically to production.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { statusCode?: number; code?: number | string; message?: string; details?: unknown };
    res.status(e.statusCode ?? 500).json({
      success: false,
      error: { code: e.code, message: e.message, details: e.details },
    });
  });
  return app;
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** Envelope shape returned by the route + test error middleware. */
type JsonBody = {
  success: boolean;
  data: Record<string, unknown>;
  error?: { code?: number | string; message?: string };
};

const json = async (res: { json(): Promise<unknown> }): Promise<JsonBody> =>
  (await res.json()) as JsonBody;

test('GET /config returns the success envelope', async () => {
  const app = buildApp(buildService(), { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.success, true);
    assert.equal(body.data.enabled, false);
  } finally {
    server.close();
  }
});

test('PUT /config returns the success envelope with saved config', async () => {
  const app = buildApp(buildService(), { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, visionModel: { provider: 'p', id: 'm' } }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.success, true);
    assert.equal(body.data.enabled, true);
  } finally {
    server.close();
  }
});

test('GET /models returns the success envelope', async () => {
  const app = buildApp(buildService(), { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/models`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data), 'models data is a bare desensitized array');
  } finally {
    server.close();
  }
});

test('unauthenticated requests are rejected with 401', async () => {
  // No user injected → route must require an authenticated user itself.
  const app = buildApp(buildService(), undefined);
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`);
    assert.equal(res.status, 401);
    const body = await json(res);
    assert.equal(body.success, false);
  } finally {
    server.close();
  }
});

test('request with an arbitrary userId in the URL is rejected', async () => {
  // The router must not accept a userId path/query parameter as authorization.
  const app = buildApp(buildService(), { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config?userId=other`);
    assert.notEqual(res.status, 200, 'arbitrary userId must not change the response');
  } finally {
    server.close();
  }
});

test('ERR-VB-MODEL-NOT-VISION surfaces as error code 4002 / 400', async () => {
  const service = buildService({
    saveConfig: async () => {
      const { AppError } = await import('@/shared/utils.js');
      throw new AppError('模型未声明图片输入能力', {
        code: VISION_BRIDGE_MODEL_NOT_VISION,
        statusCode: 400,
      });
    },
  });
  const app = buildApp(service, { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, visionModel: { provider: 'p', id: 'm' } }),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.success, false);
    assert.equal(body.error?.code, VISION_BRIDGE_MODEL_NOT_VISION);
  } finally {
    server.close();
  }
});

test('ERR-VB-MODELS-UNAVAILABLE surfaces as error code 5031 / 503', async () => {
  const service = buildService({
    listModels: async () => {
      const { AppError } = await import('@/shared/utils.js');
      throw new AppError('暂时无法读取可用视觉模型', {
        code: VISION_BRIDGE_MODELS_UNAVAILABLE,
        statusCode: 503,
      });
    },
  });
  const app = buildApp(service, { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/models`);
    assert.equal(res.status, 503);
    const body = await json(res);
    assert.equal(body.error?.code, VISION_BRIDGE_MODELS_UNAVAILABLE);
  } finally {
    server.close();
  }
});

test('ERR-VB-CONFIG-INVALID surfaces as error code 4001 / 400', async () => {
  const service = buildService({
    saveConfig: async () => {
      const { AppError } = await import('@/shared/utils.js');
      throw new AppError('视觉桥配置无效', {
        code: VISION_BRIDGE_CONFIG_INVALID,
        statusCode: 400,
      });
    },
  });
  const app = buildApp(service, { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.error?.code, VISION_BRIDGE_CONFIG_INVALID);
  } finally {
    server.close();
  }
});

test('ERR-VB-CONFIG-WRITE surfaces as error code 5002 / 500', async () => {
  const service = buildService({
    saveConfig: async () => {
      const { AppError } = await import('@/shared/utils.js');
      throw new AppError('无法保存视觉桥配置', {
        code: VISION_BRIDGE_CONFIG_WRITE_FAILED,
        statusCode: 500,
      });
    },
  });
  const app = buildApp(service, { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 500);
    const body = await json(res);
    assert.equal(body.error?.code, VISION_BRIDGE_CONFIG_WRITE_FAILED);
  } finally {
    server.close();
  }
});

test('request body userId is rejected (ERR-VB-CONFIG-INVALID)', async () => {
  const app = buildApp(buildService(), { id: 'u1' });
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/vision-bridge/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, userId: 'evil' }),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.success, false);
    assert.equal(body.error?.code, 4001);
  } finally {
    server.close();
  }
});