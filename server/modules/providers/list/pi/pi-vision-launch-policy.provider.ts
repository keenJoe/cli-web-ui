/**
 * Pi-owned vision-bridge launch-policy port.
 *
 * This is the seam the Pi live runtime (added in a later task group) will read
 * before spawning a live RPC child. It is a passive holder: by default its
 * resolver returns a disabled policy, and the composition root
 * (`server/index.ts`) injects the vision-bridge config service's resolver at
 * assembly. The Pi module never imports the vision-bridge implementation, and
 * the vision-bridge module never imports this file, so no
 * `providers → vision-bridge → providers` cycle can form.
 */
import type { VisionBridgeLaunchPolicy } from '@/shared/types.js';

/** Resolver signature the Pi runtime consumes. */
export type VisionBridgeLaunchPolicyResolver = (
  userId: string | number | null | undefined,
) => VisionBridgeLaunchPolicy | Promise<VisionBridgeLaunchPolicy>;

/** Default disabled policy returned before the composition root injects a resolver. */
const DISABLED_POLICY: VisionBridgeLaunchPolicy = {
  enabled: false,
  configPath: null,
  keyPath: null,
  diagnostics: [],
};

let activeResolver: VisionBridgeLaunchPolicyResolver = () => DISABLED_POLICY;

/**
 * Installs the application resolver. Only the composition root calls this; the
 * holder starts disabled so any consumer that reads before wiring is safe.
 */
export function configureVisionBridgeLaunchPolicy(
  resolver: VisionBridgeLaunchPolicyResolver,
): void {
  activeResolver = resolver;
}

/**
 * Resolves the launch policy for one live run. Never throws: a missing or
 * corrupt user id/config yields a disabled policy, not an exception.
 */
export async function resolveVisionBridgeLaunchPolicy(
  userId: string | number | null | undefined,
): Promise<VisionBridgeLaunchPolicy> {
  return activeResolver(userId);
}