/**
 * Lazily constructed singletons wiring the services to Foundry. Hooks are registered once.
 */
import { CreatureCatalog, FoundryPackProvider } from "./creature-catalog.js";
import { FoundryItemPackProvider, ItemCatalog } from "./item-catalog.js";
import { PartyService, SettingsProfileStore } from "./party-service.js";
import { PF2eAdapter } from "./pf2e-adapter.js";
import { TagStoreService } from "./tag-store.js";
import { ThemeStoreService } from "./theme-store.js";
import { randomID } from "./compat.js";
import { registerDataJournalHooks } from "./data-journal.js";

export interface Services {
  adapter: PF2eAdapter;
  party: PartyService;
  catalog: CreatureCatalog;
  tags: TagStoreService;
  themes: ThemeStoreService;
  items: ItemCatalog;
}

let instance: Services | null = null;

export function services(): Services {
  if (instance) return instance;
  const adapter = new PF2eAdapter();
  const tags = new TagStoreService();
  const themes = new ThemeStoreService();
  const party = new PartyService(adapter, new SettingsProfileStore(), randomID);
  const catalog = new CreatureCatalog(new FoundryPackProvider(), tags);
  const items = new ItemCatalog(new FoundryItemPackProvider());
  party.registerHooks();
  catalog.registerHooks();
  items.registerHooks();
  // Another GM, another tab or a migration rewrote a store: drop the cached copy, and re-apply
  // tags to the loaded catalog (which notifies the open workspace).
  registerDataJournalHooks((change) => {
    if (change.tags) {
      tags.invalidate();
      catalog.retag();
    }
    if (change.themes) themes.invalidate();
  });
  instance = { adapter, party, catalog, tags, themes, items };
  return instance;
}
