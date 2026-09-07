/**
 * Probe extension loaded into a real Pi 0.84.4 RPC child via `-e`.
 *
 * This fixture exercises only the seams the vision bridge relies on, with no
 * side effects. It is intentionally import-free so pi's jiti loader can load it
 * from any location without module resolution surprises.
 *
 * Contract surface exercised:
 * - `context` / `turn_end` hooks load (registered in the factory).
 * - `registerCommand("cloudcli-vision-bridge-health-v1")` appears in `getCommands()`.
 * - `ctx.ui.setStatus()` emits a non-blocking `extension_ui_request` (method "setStatus").
 * - `pi.appendEntry()` writes a custom session entry that does NOT enter LLM context.
 * - `ctx.sessionManager.getEntries()` exposes user/tool/history image entries so the
 *   vision bridge can match a `sourceEntryId`.
 *
 * NOTE: Pi 0.84.4 has NO `before_provider_payload` event (only
 * `before_provider_request`). `pi.on()` does not validate event names at runtime,
 * so a runtime registration attempt is a silent no-op and cannot prove absence.
 * Absence is asserted statically against the shipped types.d.ts in
 * `pi-vision-contract.test.ts` (block (a)), not here.
 */

const PROBE_STATUS_KEY = 'cloudcli.vision-bridge.probe.v1';

export default function visionBridgeProbe(pi: any) {
  // Register the hooks BEFORE the command. `registerCommand` runs last, so the
  // health command appearing in `getCommands()` also proves this factory ran
  // to completion and both `on()` registrations succeeded without throwing.
  pi.on('context', async (event: any, ctx: any) => {
    // The context hook is the only correctness seam: it sees provider-neutral
    // messages before provider-specific image downgrade.
    ctx.ui.setStatus('cloudcli.vision-bridge.probe.context', 'fired');
    return { messages: event.messages };
  });

  pi.on('turn_end', async (event: any) => {
    // turn_end only persists completed batches; it never rewrites messages.
    pi.appendEntry('cloudcli.vision-bridge.probe.turn-end', { turnIndex: event.turnIndex });
  });

  pi.registerCommand('cloudcli-vision-bridge-health-v1', {
    description: 'Vision bridge health probe (no side effects)',
    handler: async (args: string, ctx: any) => {
      ctx.ui.setStatus(PROBE_STATUS_KEY, JSON.stringify({ ok: true, args }));

      // Persist a custom entry through the same seam the bridge uses for batch
      // results. This must not participate in LLM context.
      pi.appendEntry('cloudcli.vision-bridge.probe.v1', { ok: true, args });

      // Report the ids of entries that carry image blocks. The bridge matches
      // these ids as sourceEntryId for user/tool/history image positions.
      const imageEntryIds: string[] = [];
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === 'message') {
          const content = entry.message?.content;
          if (Array.isArray(content) && content.some((b) => b?.type === 'image')) {
            imageEntryIds.push(entry.id);
          }
        }
      }
      ctx.ui.setStatus(
        'cloudcli.vision-bridge.probe.image-entries',
        JSON.stringify({ ids: imageEntryIds }),
      );
    },
  });
}