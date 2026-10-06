/**
 * Small modal prompts shared by the workspace, its panels and the table editor (DialogV2).
 * Every one resolves to a value or null/false when the GM closes the dialog.
 */
import { escapeHtml } from "../core/util.js";
import { DialogV2 } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";

/** Yes/no confirmation. `html` is trusted markup (escape user data first) and is wrapped in a <p>. */
export async function confirm(
  title: string,
  html: string,
  icon = "fa-solid fa-triangle-exclamation",
): Promise<boolean> {
  const ok = await DialogV2().confirm({
    window: { title, icon },
    classes: ["seb-dialog"],
    content: `<p>${html}</p>`,
    modal: true,
    rejectClose: false,
  });
  return ok === true;
}

/** Single-line text prompt; null when cancelled. */
export async function promptText(title: string, label: string, initial = ""): Promise<string | null> {
  const result = await DialogV2().prompt({
    window: { title },
    classes: ["seb-dialog"],
    content: `<div class="seb-field"><label>${escapeHtml(label)}</label><input type="text" name="value" value="${escapeHtml(initial)}" autofocus></div>`,
    ok: {
      callback: (_event: Event, button: HTMLButtonElement) =>
        (button.form?.elements.namedItem("value") as HTMLInputElement | null)?.value ?? "",
    },
    rejectClose: false,
  });
  return typeof result === "string" ? result : null;
}

/** Pick one uuid from a list; null when cancelled or (with a warning) when the list is empty. */
export async function promptSelect(
  title: string,
  label: string,
  options: { uuid: string; name: string }[],
): Promise<string | null> {
  if (options.length === 0) {
    ui.notifications.warn(t("party.noCandidates"));
    return null;
  }
  const opts = options
    .map((o) => `<option value="${escapeHtml(o.uuid)}">${escapeHtml(o.name)}</option>`)
    .join("");
  const result = await DialogV2().prompt({
    window: { title },
    classes: ["seb-dialog"],
    content: `<div class="seb-field"><label>${escapeHtml(label)}</label><select name="value">${opts}</select></div>`,
    ok: {
      callback: (_event: Event, button: HTMLButtonElement) =>
        (button.form?.elements.namedItem("value") as HTMLSelectElement | null)?.value ?? "",
    },
    rejectClose: false,
  });
  return typeof result === "string" && result ? result : null;
}
