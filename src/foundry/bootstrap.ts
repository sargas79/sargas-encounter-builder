/**
 * GM-only startup: migrations and launcher redraw. Quench batches are registered from `module.ts`.
 * Loaded lazily from the `ready` hook so non-GM clients never import the heavy parts.
 */
import { MODULE_ID } from "../constants.js";
import { log } from "./i18n.js";

export async function onReady(): Promise<void> {
  const { runMigrations } = await import("./migrations.js");
  await runMigrations();

  // Hooks were registered at init; if the controls or the directory rendered before this client
  // knew it was a GM, redraw them so the launchers appear without a reload.
  ui.controls?.render({ reset: true });
  ui.actors?.render();

  log("ready", {
    module: game.modules.get(MODULE_ID)?.version,
    foundry: game.version,
    pf2e: game.system.version,
  });
}
