/**
 * VisionBridge routes — thin transport handlers for the authenticated
 * vision-bridge API.
 *
 * Responsibilities are limited to: resolving the authenticated user id from
 * the request, refusing a non-route user id as an authorization cross-check
 * (body/URL userId is never an authorization basis), delegating to the config
 * service, and wrapping results in the standard success envelope. All
 * validation, persistence, and orchestration live in the service.
 */
import express, { type Request, type Response } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { VisionBridgeModelCatalogResult } from '@/shared/types.js';
import { VISION_BRIDGE_CONFIG_INVALID } from '../../../shared/vision-bridge.js';

/** Service surface these routes depend on. */
export type VisionBridgeRouteService = {
  getPublicConfig(userId: string | number): Promise<unknown>;
  saveConfig(userId: string | number, update: unknown): Promise<unknown>;
  listModels(): Promise<VisionBridgeModelCatalogResult>;
};

type AuthenticatedRequest = Request & { user?: { id?: string | number } };

/**
 * Resolves the authenticated user id. Returns `null` when unauthenticated so
 * the caller can return 401; throws `ERR-VB-CONFIG-INVALID` when the request
 * attempts to smuggle a different `userId` through the body or query string.
 */
function authenticatedUserId(req: Request): string | number | null {
  // Cross-user access guard: the ONLY authorization basis is the authenticated
  // token. A `userId` in the body or URL is treated as an attempt to target
  // another user and is rejected without leaking whether that user exists.
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.userId !== undefined) {
    throw new AppError('视觉桥配置无效，请检查模型和参数', {
      code: VISION_BRIDGE_CONFIG_INVALID,
      statusCode: 400,
    });
  }
  if (req.query.userId !== undefined) {
    throw new AppError('视觉桥配置无效，请检查模型和参数', {
      code: VISION_BRIDGE_CONFIG_INVALID,
      statusCode: 400,
    });
  }

  const userId = (req as AuthenticatedRequest).user?.id;
  return typeof userId === 'string' || typeof userId === 'number' ? userId : null;
}

/** Builds the authenticated vision-bridge router around a config service. */
export function createVisionBridgeRouter(service: VisionBridgeRouteService): express.Router {
  const router = express.Router();

  router.get(
    '/config',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = authenticatedUserId(req);
      if (userId === null) {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_TOKEN_INVALID', message: '未认证' },
        });
        return;
      }
      res.json(createApiSuccessResponse(await service.getPublicConfig(userId)));
    }),
  );

  router.put(
    '/config',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = authenticatedUserId(req);
      if (userId === null) {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_TOKEN_INVALID', message: '未认证' },
        });
        return;
      }
      res.json(createApiSuccessResponse(await service.saveConfig(userId, req.body ?? {})));
    }),
  );

  router.get(
    '/models',
    asyncHandler(async (_req: Request, res: Response) => {
      // The frontend model picker consumes a bare desensitized model array;
      // `listModels()` throws ERR-VB-MODELS-UNAVAILABLE when the probe cannot
      // be read, so an empty/unavailable catalog never reaches a 200 response.
      const { models } = await service.listModels();
      res.json(createApiSuccessResponse(models));
    }),
  );

  return router;
}