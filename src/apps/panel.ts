/**
 * Contract between the workspace and its tab panels. Every member is optional: the app asks each
 * panel in turn and a panel that does not handle the input returns false.
 */
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import type { TabId } from "./view-models.js";

/** A method templates may call as `data-action="ext" data-ext="<panel>" data-method="<name>"`. */
export type PanelAction = (uuid: string | undefined, target: HTMLElement) => Promise<void>;

export interface Panel {
  /** Methods reachable from `data-method`; anything else on the panel is not callable from markup. */
  readonly actions?: ReadonlySet<string>;
  /** Context for the part of the same name (the Build part also reads the generator's). */
  prepareContext?(): Promise<Record<string, unknown>>;
  /** A named input changed; true when handled. */
  onChange?(name: string, value: string, target: HTMLElement): Promise<boolean> | boolean;
  /** Something was dropped on a `.seb-dropzone`; true when handled. */
  onDrop?(purpose: string | undefined, data: Record<string, unknown>): Promise<boolean> | boolean;
  onTabShown?(tab: TabId): void;
  /** The draft was swapped for one that shares no creature with the previous one. */
  onDraftReplaced?(): void;
  dispose?(): void;
}

/** Method names of `T`, so a panel's whitelist cannot name something it does not have. */
type MethodName<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T] &
  string;

/** Build a panel's `actions` whitelist. */
export function panelActions<T>(...names: MethodName<T>[]): ReadonlySet<string> {
  return new Set(names);
}

type Panels = EncounterBuilderApp["panels"];
type TargetHandler = (target: HTMLElement) => Promise<void>;
type TargetHandlerName<P> = { [M in keyof P]: P[M] extends TargetHandler ? M : never }[keyof P];

/** A `data-action` handled by a panel method that takes the clicked element. */
export function route<K extends keyof Panels>(key: K, method: TargetHandlerName<Panels[K]>) {
  return function (this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const panel = this.panels[key];
    return (panel[method] as TargetHandler).call(panel, target);
  };
}
