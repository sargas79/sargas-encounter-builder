/**
 * "New encounter" start dialog: party, threat, mixed-level policy and mode, asked before the
 * workspace opens. Returns null when cancelled. Also applies the answer to the party profiles.
 */
import { THREAT_LEVELS, type ReferenceLevelPolicy, type ThreatLevel } from "../core/budget.js";
import type { PartyProfile } from "../core/schemas.js";
import { DialogV2, renderTemplate } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { MODULE_ID, SETTINGS } from "../constants.js";
import { services } from "../foundry/services.js";
import { getSetting, setSetting } from "../foundry/settings.js";

export type StartMode = "manual" | "random" | "table" | "saved";

export interface StartChoice {
  /** "actor:<uuid>" | "profile:<id>" | "new" */
  party: string;
  threat: ThreatLevel;
  policy: ReferenceLevelPolicy;
  manualLevel: number | null;
  mode: StartMode;
}

export interface StartDialogOptions {
  partyActors: { uuid: string; name: string }[];
  profiles: PartyProfile[];
  /** Pre-selected values (last used). */
  initial?: Partial<StartChoice>;
}

const POLICIES: ReferenceLevelPolicy[] = ["averageFloor", "highest", "lowest", "manual"];
const MODES: StartMode[] = ["manual", "random", "table", "saved"];

export async function showStartDialog(options: StartDialogOptions): Promise<StartChoice | null> {
  const initial = options.initial ?? {};
  const linkedByActor = new Map(
    options.profiles
      .filter((p) => p.kind === "linked" && p.partyActorUuid)
      .map((p) => [p.partyActorUuid!, p]),
  );
  const partyOptions = [
    ...options.partyActors.map((a) => ({
      value: `actor:${a.uuid}`,
      label: a.name,
      group: "actors",
      selected: initial.party === `actor:${a.uuid}` || (!initial.party && options.partyActors.length === 1),
      hint: linkedByActor.has(a.uuid) ? t("start.linkedHint") : "",
    })),
    ...options.profiles
      .filter((p) => p.kind === "standalone")
      .map((p) => ({
        value: `profile:${p.id}`,
        label: p.name,
        group: "profiles",
        selected: initial.party === `profile:${p.id}`,
        hint: "",
      })),
    { value: "new", label: t("start.newProfile"), group: "new", selected: initial.party === "new", hint: "" },
  ];
  if (!partyOptions.some((o) => o.selected)) partyOptions[0]!.selected = true;

  const content = await renderTemplate(`modules/${MODULE_ID}/templates/start-dialog.hbs`, {
    partyOptions,
    hasPartyActors: options.partyActors.length > 0,
    threats: THREAT_LEVELS.map((value) => ({
      value,
      label: t(`threat.${value}`),
      active: (initial.threat ?? "moderate") === value,
    })),
    policies: POLICIES.map((value) => ({
      value,
      label: t(`party.policy.${value}`),
      selected: (initial.policy ?? "averageFloor") === value,
    })),
    manualLevel: initial.manualLevel ?? "",
    modes: MODES.map((value) => ({
      value,
      label: t(`start.mode.${value}`),
      hint: t(`start.modeHint.${value}`),
      icon: MODE_ICONS[value],
      active: (initial.mode ?? "random") === value,
    })),
  });

  const result = (await DialogV2().wait({
    window: { title: t("start.title"), icon: "fa-solid fa-dragon" },
    classes: ["seb-dialog", "seb-start"],
    position: { width: 520 },
    content,
    modal: true,
    rejectClose: false,
    render: (_event: Event, dialog: { element: HTMLElement }) => bindSegments(dialog.element),
    buttons: [
      {
        action: "start",
        label: t("start.begin"),
        icon: "fa-solid fa-play",
        default: true,
        callback: (_event: Event, _button: HTMLButtonElement, dialog: { element: HTMLElement }) =>
          readChoice(dialog.element),
      },
      { action: "cancel", label: t("start.cancel"), icon: "fa-solid fa-xmark", callback: () => null },
    ],
  })) as StartChoice | null | "cancel";
  return result && typeof result === "object" ? result : null;
}

const MODE_ICONS: Record<StartMode, string> = {
  manual: "fa-solid fa-hand",
  random: "fa-solid fa-dice",
  table: "fa-solid fa-table-list",
  saved: "fa-solid fa-folder-open",
};

/** Segmented controls inside a DialogV2 have no app actions; toggle them by hand. */
function bindSegments(root: HTMLElement): void {
  for (const group of root.querySelectorAll<HTMLElement>("[data-segment-group]")) {
    group.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-value]");
      if (!button) return;
      for (const b of group.querySelectorAll<HTMLButtonElement>("button[data-value]")) {
        const active = b === button;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", String(active));
      }
      const hidden = root.querySelector<HTMLInputElement>(`input[name='${group.dataset.segmentGroup}']`);
      if (hidden) hidden.value = button.dataset.value ?? "";
    });
  }
  const policy = root.querySelector<HTMLSelectElement>("select[name='policy']");
  const manual = root.querySelector<HTMLElement>("[data-manual-level]");
  const sync = () => manual?.classList.toggle("is-hidden", policy?.value !== "manual");
  policy?.addEventListener("change", sync);
  sync();
}

function readChoice(root: HTMLElement): StartChoice {
  const read = (name: string) =>
    root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name='${name}']`)?.value ?? "";
  const threat = read("threat") as ThreatLevel;
  const policy = read("policy") as ReferenceLevelPolicy;
  const manualRaw = Number.parseInt(read("manualLevel"), 10);
  return {
    party: read("party") || "new",
    threat: THREAT_LEVELS.includes(threat) ? threat : "moderate",
    policy: POLICIES.includes(policy) ? policy : "averageFloor",
    manualLevel: Number.isInteger(manualRaw) ? manualRaw : null,
    mode: (MODES as string[]).includes(read("mode")) ? (read("mode") as StartMode) : "random",
  };
}

/* -------------------------------------------- */
/*  Workspace flow                              */
/* -------------------------------------------- */

/** Last start-dialog answers, remembered per client. */
export interface UiState {
  lastParty?: string;
  lastMode?: StartMode;
  lastThreat?: ThreatLevel;
}

export function loadUiState(): UiState {
  try {
    return (getSetting<UiState>(SETTINGS.uiState) ?? {}) as UiState;
  } catch {
    return {};
  }
}

export async function saveUiState(patch: UiState): Promise<void> {
  try {
    await setSetting(SETTINGS.uiState, { ...loadUiState(), ...patch });
  } catch {
    /* client setting unavailable in tests */
  }
}

/** Show the dialog pre-filled from the active profile and the last answers. */
export async function askStartChoice(): Promise<StartChoice | null> {
  const { party, adapter } = services();
  const ui = loadUiState();
  const active = party.activeProfile();
  const initialParty =
    ui.lastParty ??
    (active
      ? active.kind === "linked" && active.partyActorUuid
        ? `actor:${active.partyActorUuid}`
        : `profile:${active.id}`
      : undefined);
  return showStartDialog({
    partyActors: adapter.listPartyActors(),
    profiles: party.profiles(),
    initial: {
      party: initialParty,
      threat: active?.selectedThreat ?? ui.lastThreat,
      mode: ui.lastMode,
      policy: active?.referencePolicy ?? undefined,
      manualLevel: active?.manualReferenceLevel ?? null,
    },
  });
}

/**
 * Find or create the chosen profile, store the threat and policy on it, make it active and
 * remember the answers. Returns the profile as it was before the update.
 */
export async function activateStartChoice(choice: StartChoice): Promise<PartyProfile> {
  const { party, adapter } = services();
  let profile: PartyProfile | null = null;
  if (choice.party.startsWith("actor:")) {
    const uuid = choice.party.slice("actor:".length);
    profile = party.profiles().find((p) => p.kind === "linked" && p.partyActorUuid === uuid) ?? null;
    if (!profile) {
      const actor = adapter.listPartyActors().find((a) => a.uuid === uuid);
      profile = await party.createProfile(actor?.name ?? t("party.defaultName"), "linked", uuid);
    }
  } else if (choice.party.startsWith("profile:")) {
    profile = party.getProfile(choice.party.slice("profile:".length));
  }
  if (!profile) profile = await party.createProfile(t("party.defaultName"), "standalone");
  await party.updateProfile({
    ...profile,
    selectedThreat: choice.threat,
    referencePolicy: choice.policy,
    manualReferenceLevel: choice.manualLevel,
  });
  await party.setActive(profile.id);
  await saveUiState({ lastParty: choice.party, lastMode: choice.mode, lastThreat: choice.threat });
  return profile;
}
