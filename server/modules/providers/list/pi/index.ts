/**
 * Public surface of the Pi provider for the central registry.
 *
 * Only the assembled provider class is exported; individual facets stay
 * internal to this module. Two vision-bridge adapters are additionally
 * exported for the composition root (`server/index.ts`): the vision-model
 * catalog port and the launch-policy port. Neither imports the vision-bridge
 * implementation, so no providers → vision-bridge → providers cycle forms.
 */
export { PiProvider } from './pi.provider.js';

// Vision-model catalog port: the read-only image-capable model catalog the
// vision-bridge config service consumes through constructor injection.
export {
  createPiVisionModelCatalogProvider,
  decodePiModelSnapshot,
  probePiVisionModelsRaw,
  type PiVisionModelProbe,
} from './pi-vision-model-catalog.provider.js';

// Launch-policy port: the passive holder the Pi live runtime reads to decide
// whether to inject the vision-bridge extension for a run. The composition
// root installs the vision-bridge resolver at assembly time.
export {
  configureVisionBridgeLaunchPolicy,
  resolveVisionBridgeLaunchPolicy,
  type VisionBridgeLaunchPolicyResolver,
} from './pi-vision-launch-policy.provider.js';