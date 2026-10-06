/**
 * Minimal ambient declarations for the Foundry VTT 13 / PF2e 7.x surface this module uses.
 *
 * These are intentionally narrow and loosely typed. Each member listed here was checked against the
 * type definitions shipped in the PF2e repository (`types/foundry`) — see docs/VERIFICATION.md §3.
 * Anything not listed here must not be used without extending this file and the verification record.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface FoundryDocument {
    id: string;
    uuid: string;
    name: string;
    documentName?: string;
    flags: Record<string, any>;
    _stats?: {
      compendiumSource?: string | null;
      duplicateSource?: string | null;
      /** Creation timestamp (ms). */
      createdTime?: number | null;
    };
    pack?: string | null;
    folder?: FolderDocument | null;
    getFlag(scope: string, key: string): any;
    setFlag(scope: string, key: string, value: unknown): Promise<this>;
    unsetFlag(scope: string, key: string): Promise<this>;
    update(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<this>;
    delete(options?: Record<string, unknown>): Promise<this>;
    toObject(source?: boolean): Record<string, any>;
    testUserPermission(
      user: FoundryUser,
      permission: string | number,
      options?: { exact?: boolean },
    ): boolean;
    sheet?: { render(force?: boolean, options?: Record<string, unknown>): unknown } | null;
    createEmbeddedDocuments(
      embeddedName: string,
      data: Record<string, unknown>[],
      operation?: Record<string, unknown>,
    ): Promise<any[]>;
    updateEmbeddedDocuments(
      embeddedName: string,
      updates: Record<string, unknown>[],
      operation?: Record<string, unknown>,
    ): Promise<any[]>;
    deleteEmbeddedDocuments(
      embeddedName: string,
      ids: string[],
      operation?: Record<string, unknown>,
    ): Promise<any[]>;
  }

  interface FoundryUser {
    id: string;
    name: string;
    isGM: boolean;
  }

  interface FolderDocument extends FoundryDocument {
    type: string;
  }

  interface ActorDocument extends FoundryDocument {
    type: string;
    img: string;
    level?: number;
    system: any;
    prototypeToken: {
      actorLink: boolean;
      width: number;
      height: number;
      name: string;
      toObject(): Record<string, any>;
    };
    isOfType?(...types: string[]): boolean;
    sourceId?: string | null;
    members?: ActorDocument[];
    ownership: Record<string, number>;
    hitPoints?: { value: number; max: number } | null;
    /** Core: a TokenDocument built from the prototype (resolves random wildcard images). */
    getTokenDocument?(
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<TokenDocument>;
    /** PF2e: the actor's inventory (physical items). */
    inventory?: {
      addCoins?(coins: { pp?: number; gp?: number; sp?: number; cp?: number }): Promise<void>;
    };
  }

  interface TableResultDocument extends FoundryDocument {
    type: "text" | "document";
    description: string;
    documentUuid: string | null;
    weight: number;
    range: [number, number];
    drawn: boolean;
    img: string;
  }

  interface RollTableDocument extends FoundryDocument {
    formula: string;
    replacement: boolean;
    description: string;
    results: Iterable<TableResultDocument> & {
      contents: TableResultDocument[];
      get(id: string): TableResultDocument | undefined;
      size: number;
    };
    roll(options?: {
      roll?: FoundryRoll;
      recursive?: boolean;
    }): Promise<{ roll: FoundryRoll; results: TableResultDocument[] }>;
    getResultsForRoll(value: number): TableResultDocument[];
  }

  interface JournalEntryDocument extends FoundryDocument {
    ownership: Record<string, number>;
    pages: { contents: any[] };
  }

  interface SceneDocument extends FoundryDocument {
    width: number;
    height: number;
    grid: {
      type: number;
      size: number;
      isSquare: boolean;
      isHexagonal: boolean;
      isGridless: boolean;
      getTopLeftPoint(coords: { i: number; j: number }): { x: number; y: number };
      getOffset(point: { x: number; y: number }): { i: number; j: number };
    };
    dimensions: {
      sceneX: number;
      sceneY: number;
      sceneWidth: number;
      sceneHeight: number;
      width: number;
      height: number;
      size: number;
    };
    tokens: { contents: TokenDocument[] };
    active: boolean;
  }

  interface TokenDocument extends FoundryDocument {
    x: number;
    y: number;
    width: number;
    height: number;
    hidden: boolean;
    actorId: string | null;
    actorLink: boolean;
    actor: ActorDocument | null;
    baseActor: ActorDocument | null;
    parent: SceneDocument | null;
  }

  interface CombatDocument extends FoundryDocument {
    combatants: { contents: { initiative?: number | null; uuid?: string; tokenId?: string | null }[] };
    scene: SceneDocument | null;
    started: boolean;
    round: number;
  }

  interface FoundryRoll {
    total: number | undefined;
    formula: string;
    dice: { results: { result: number; active: boolean }[]; faces: number }[];
    terms: unknown[];
    evaluate(options?: Record<string, unknown>): Promise<FoundryRoll>;
    toJSON(): Record<string, unknown>;
  }

  interface CompendiumIndexEntry {
    _id: string;
    name: string;
    type: string;
    img?: string;
    uuid: string;
    system?: any;
  }

  interface CompendiumPack {
    collection: string;
    metadata: {
      id: string;
      label: string;
      name: string;
      packageName: string;
      packageType: string;
      type: string;
    };
    documentName: string;
    visible: boolean;
    locked: boolean;
    index: { size: number; contents: CompendiumIndexEntry[] };
    getIndex(options?: { fields?: string[] }): Promise<{
      contents: CompendiumIndexEntry[];
      size: number;
      get(id: string): CompendiumIndexEntry | undefined;
    }>;
    getDocument(id: string): Promise<FoundryDocument | null>;
    testUserPermission?(user: FoundryUser, permission: string): boolean;
  }

  interface ClientSettings {
    register(namespace: string, key: string, data: Record<string, unknown>): void;
    get(namespace: string, key: string): any;
    set(namespace: string, key: string, value: unknown): Promise<unknown>;
  }

  interface WorldCollection<T> extends Iterable<T> {
    contents: T[];
    get(id: string): T | undefined;
    getName(name: string): T | undefined;
    filter(fn: (doc: T) => boolean): T[];
    find(fn: (doc: T) => boolean): T | undefined;
    size: number;
  }

  interface FoundryGame {
    user: FoundryUser;
    users: WorldCollection<FoundryUser>;
    settings: ClientSettings;
    actors: WorldCollection<ActorDocument>;
    scenes: WorldCollection<SceneDocument> & {
      current: SceneDocument | null;
      viewed: SceneDocument | null;
      active: SceneDocument | null;
    };
    journal: WorldCollection<JournalEntryDocument>;
    tables: WorldCollection<RollTableDocument>;
    folders: WorldCollection<FolderDocument>;
    combats: WorldCollection<CombatDocument> & {
      active: CombatDocument | null;
      viewed: CombatDocument | null;
    };
    combat: CombatDocument | null;
    packs: WorldCollection<CompendiumPack>;
    i18n: {
      localize(key: string): string;
      format(key: string, data?: Record<string, unknown>): string;
      has(key: string): boolean;
    };
    system: { id: string; version: string };
    version: string;
    modules: {
      get(id: string):
        | {
            active: boolean;
            version: string;
            title?: string;
            authors?: Iterable<{ name?: string; github?: string }>;
          }
        | undefined;
    };
    pf2e?: {
      gm?: {
        calculateXP?: (
          partyLevel: number,
          partySize: number,
          npcLevels: number[],
          hazards: unknown[],
          options: { pwol: boolean },
        ) => { totalXP: number; rating: string; encounterBudgets: Record<string, number> };
      };
      settings?: { variants?: { pwol?: { enabled: boolean } } };
    };
  }

  const game: FoundryGame;
  const canvas: {
    ready: boolean;
    scene: SceneDocument | null;
    tokens: any;
    stage: any;
    app: any;
    grid: any;
    mousePosition?: { x: number; y: number };
    canvasCoordinatesFromClient?(point: { x: number; y: number }): { x: number; y: number };
  };
  const ui: {
    notifications: {
      info(msg: string, opts?: Record<string, unknown>): void;
      warn(msg: string, opts?: Record<string, unknown>): void;
      error(msg: string, opts?: Record<string, unknown>): void;
    };
    sidebar?: any;
    controls?: any;
    actors?: any;
  };
  const CONST: {
    GRID_TYPES: { GRIDLESS: number; SQUARE: number };
    DOCUMENT_OWNERSHIP_LEVELS: {
      NONE: number;
      LIMITED: number;
      OBSERVER: number;
      OWNER: number;
      INHERIT: number;
    };
    TABLE_RESULT_TYPES: { TEXT: "text"; DOCUMENT: "document" };
    USER_ROLES: Record<string, number>;
  };
  const Hooks: {
    on(hook: string, fn: (...args: any[]) => unknown): number;
    once(hook: string, fn: (...args: any[]) => unknown): number;
    off(hook: string, id: number): void;
    call(hook: string, ...args: unknown[]): boolean;
    callAll(hook: string, ...args: unknown[]): boolean;
  };
  function fromUuid(uuid: string): Promise<FoundryDocument | null>;
  function fromUuidSync(uuid: string): FoundryDocument | CompendiumIndexEntry | null;

  const Roll: {
    new (formula: string, data?: Record<string, unknown>): FoundryRoll;
    validate(formula: string): boolean;
  };
  const Actor: {
    create(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<ActorDocument>;
    implementation: { fromDropData(data: Record<string, unknown>): Promise<ActorDocument | null> };
  };
  const JournalEntry: {
    create(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<JournalEntryDocument>;
  };
  const Folder: {
    create(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<FolderDocument>;
  };
  const Combat: {
    create(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<CombatDocument>;
  };
  const ChatMessage: {
    create(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<unknown>;
    getSpeaker(options?: Record<string, unknown>): Record<string, unknown>;
  };
  const RollTable: {
    create(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<RollTableDocument>;
  };
  const TextEditor: { getDragEventData(event: DragEvent): Record<string, any> };

  namespace foundry {
    namespace utils {
      function randomID(length?: number): string;
      function deepClone<T>(value: T): T;
      function mergeObject<T>(
        original: T,
        other?: Record<string, unknown>,
        options?: Record<string, unknown>,
      ): T;
      function debounce<T extends (...args: any[]) => unknown>(fn: T, delay: number): T;
      function parseUuid(uuid: string): { collection?: unknown; documentId?: string; primaryType?: string };
    }
    namespace applications {
      namespace api {
        class ApplicationV2 {
          static DEFAULT_OPTIONS: Record<string, unknown>;
          static tabGroups: Record<string, string>;
          constructor(options?: Record<string, unknown>);
          readonly element: HTMLElement;
          readonly rendered: boolean;
          readonly id: string;
          tabGroups: Record<string, string>;
          render(options?: boolean | Record<string, unknown>): Promise<this>;
          close(options?: Record<string, unknown>): Promise<this>;
          changeTab(tab: string, group: string, options?: Record<string, unknown>): void;
          protected _prepareContext(options: Record<string, unknown>): Promise<Record<string, unknown>>;
          protected _onRender(
            context: Record<string, unknown>,
            options: Record<string, unknown>,
          ): Promise<void> | void;
          protected _onClose(options: Record<string, unknown>): void;
          protected _onFirstRender(
            context: Record<string, unknown>,
            options: Record<string, unknown>,
          ): Promise<void> | void;
        }
        function HandlebarsApplicationMixin<T extends new (...args: any[]) => ApplicationV2>(
          Base: T,
        ): T & {
          PARTS: Record<string, { template: string; scrollable?: string[] }>;
        };
        class DialogV2 {
          static confirm(options: Record<string, unknown>): Promise<boolean | null>;
          static prompt(options: Record<string, unknown>): Promise<unknown>;
          static wait(options: Record<string, unknown>): Promise<unknown>;
        }
      }
      namespace handlebars {
        function renderTemplate(path: string, data: Record<string, unknown>): Promise<string>;
        function loadTemplates(paths: string[]): Promise<unknown>;
      }
      namespace ux {
        const TextEditor: { implementation: { getDragEventData(event: DragEvent): Record<string, any> } };
      }
    }
    namespace documents {
      const RollTable: {
        create(
          data: Record<string, unknown>,
          operation?: Record<string, unknown>,
        ): Promise<RollTableDocument>;
      };
    }
    namespace dice {
      const Roll: {
        new (formula: string, data?: Record<string, unknown>): FoundryRoll;
        validate(formula: string): boolean;
      };
    }
  }

  // Quench (optional test runner module)
  interface QuenchBatchContext {
    describe(name: string, fn: () => void): void;
    it(name: string, fn: () => unknown | Promise<unknown>): void;
    before(fn: () => unknown | Promise<unknown>): void;
    after(fn: () => unknown | Promise<unknown>): void;
    assert: {
      ok(v: unknown, msg?: string): void;
      equal(a: unknown, b: unknown, msg?: string): void;
      notEqual(a: unknown, b: unknown, msg?: string): void;
      deepEqual(a: unknown, b: unknown, msg?: string): void;
      isTrue(v: unknown, msg?: string): void;
      isFalse(v: unknown, msg?: string): void;
      isNull(v: unknown, msg?: string): void;
      isNotNull(v: unknown, msg?: string): void;
      isAbove(a: number, b: number, msg?: string): void;
      fail(msg?: string): void;
    };
  }
  interface Quench {
    registerBatch(
      key: string,
      fn: (context: QuenchBatchContext) => void,
      options?: { displayName?: string; preSelected?: boolean },
    ): void;
  }
}

export {};
