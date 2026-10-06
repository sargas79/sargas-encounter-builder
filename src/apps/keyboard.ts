/**
 * Keyboard support shared by the module's windows: Enter/Space on `role="button"` elements that
 * are not native buttons, and arrow-key navigation with a roving tabindex inside a tablist.
 */

/** Keys that move focus within a tablist. */
const TAB_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * Index of the tab to focus after `key`, skipping disabled tabs and wrapping around; null when the
 * key does not navigate or no other tab is enabled.
 */
export function nextTabIndex(disabled: readonly boolean[], current: number, key: string): number | null {
  if (!TAB_KEYS.has(key)) return null;
  const enabled = disabled.flatMap((off, i) => (off ? [] : [i]));
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0]!;
  if (key === "End") return enabled[enabled.length - 1]!;
  const step = key === "ArrowRight" ? 1 : -1;
  const n = disabled.length;
  for (let k = 1; k <= n; k++) {
    const i = (((current + step * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return null;
}

/**
 * Delegated keydown handler: true when it handled the event.
 * - Enter/Space on a non-native `[role="button"]` clicks it (ApplicationV2 actions listen for clicks).
 * - Left/Right/Home/End on a `[role="tab"]` moves focus to the next enabled tab of its tablist and
 *   makes it the only tab in the tab order (activation stays on Enter/Space or click).
 */
export function handleKeyboardActivation(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement) || event.altKey || event.ctrlKey || event.metaKey) return false;

  if ((event.key === "Enter" || event.key === " ") && target.getAttribute("role") === "button") {
    if (target instanceof HTMLButtonElement || target.getAttribute("aria-disabled") === "true") return false;
    event.preventDefault();
    target.click();
    return true;
  }

  if (target.getAttribute("role") === "tab" && TAB_KEYS.has(event.key)) {
    const list = target.closest('[role="tablist"]');
    if (!list) return false;
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    const disabled = tabs.map(
      (tab) => tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true",
    );
    const next = nextTabIndex(disabled, tabs.indexOf(target), event.key);
    if (next === null) return false;
    event.preventDefault();
    tabs.forEach((tab, i) => tab.setAttribute("tabindex", i === next ? "0" : "-1"));
    tabs[next]!.focus();
    return true;
  }
  return false;
}
