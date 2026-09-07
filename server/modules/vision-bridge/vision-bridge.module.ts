/**
 * Vision-bridge module assembly.
 *
 * Wires the config repository (per-user, `~/.cloudcli/vision-bridge` by
 * default) and the injected model-catalog port into the config service, and
 * returns the router plus the launch-policy resolver for the composition root
 * to hand to the Pi-owned launch-policy port.
 */
import type { VisionBridgeModelCatalogPort } from '@/shared/types.js';

import { createVisionBridgeConfigRepository } from './vision-bridge-config.repository.js';
import { createVisionBridgeConfigService } from './vision-bridge-config.service.js';
import { createVisionBridgeRouter } from './vision-bridge.routes.js';

/** Options for {@link createVisionBridgeModule}. */
export type VisionBridgeModuleOptions = {
  /** Image-capable model catalog port (the Pi adapter), injected to avoid a module cycle. */
  modelCatalog: VisionBridgeModelCatalogPort;
  /** Override the config root; production defaults to `~/.cloudcli/vision-bridge`. */
  configRoot?: string;
};

/**
 * Creates the vision-bridge HTTP router plus the launch-policy resolver.
 *
 * The resolver is returned (not the whole service) so the composition root
 * can inject it into the Pi-owned launch-policy port without exposing the
 * vision-bridge implementation to the providers module.
 */
export function createVisionBridgeModule(options: VisionBridgeModuleOptions) {
  const repository = createVisionBridgeConfigRepository({ root: options.configRoot });
  const service = createVisionBridgeConfigService({
    repository,
    modelCatalog: options.modelCatalog,
  });

  return {
    router: createVisionBridgeRouter(service),
    /** Launch-policy resolver to inject into the Pi launch-policy port. */
    resolveLaunchPolicy: service.resolveLaunchPolicy,
    /** Config service exposed only for composition and tests. */
    service,
  };
}