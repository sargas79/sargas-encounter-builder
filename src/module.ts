/**
 * Module entry point. Registers settings and hooks once; everything else is lazy.
 */
import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./foundry/settings.js";
import { registerLauncher } from "./foundry/launcher.js";
import { log } from "./foundry/i18n.js";

let initialized = false;

Hooks.once("init", () => {
  if (initialized) return;
  initialized = true;
  registerSettings();
  // Scene controls render before `ready`; the launcher hooks must exist by then (they re-check isGM).
  registerLauncher();
  log("initialized");
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  if (game.system.id !== "pf2e") {
    console.warn(`${MODULE_ID} | This module requires the PF2e system; most features are disabled.`);
    return;
  }
  const { onReady } = await import("./foundry/bootstrap.js");
  await onReady();
});

// Quench fires `quenchReady` once its own API is ready (during `ready`); register here at module load so
// the batches exist before Quench builds its UI, independent of how long our migrations take.
Hooks.once("quenchReady", async (quench: Quench) => {
  if (!game.user?.isGM || game.system?.id !== "pf2e") return;
  const { registerQuenchTests } = await import("./quench/tests.js");
  registerQuenchTests(quench);
});
