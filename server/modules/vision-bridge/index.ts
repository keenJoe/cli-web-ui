/**
 * Vision-bridge public surface.
 *
 * Exports only the router factory, config service factory, launch-policy
 * resolver (via the module assembly), and the necessary types. The vision
 * bridge never deep-imports Pi internals: the model-catalog port is injected.
 */
export { createVisionBridgeModule, type VisionBridgeModuleOptions } from './vision-bridge.module.js';
export { createVisionBridgeRouter, type VisionBridgeRouteService } from './vision-bridge.routes.js';
export {
  createVisionBridgeConfigService,
  type VisionBridgeConfigServiceDependencies,
} from './vision-bridge-config.service.js';
export {
  createVisionBridgeConfigRepository,
  visionBridgeUserKey,
  type VisionBridgeConfigRepository,
  type VisionBridgeConfigRepositoryOptions,
  type VisionBridgeStoredConfigShape,
} from './vision-bridge-config.repository.js';
