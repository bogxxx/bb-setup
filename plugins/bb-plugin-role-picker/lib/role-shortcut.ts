// The Role control's keyboard shortcut: Alt+R cycles the role, Shift+Alt+R
// backward, as Alt+M, Alt+P and Alt+T cycle BB's model picker.
import type { Role } from "../server";

/** The roles in the order the control lists them. */
export const ROLE_ORDER: Role[] = ["regular", "orchestrator", "interviewer"];

/** The role after `role`, or before it with `backward`, wrapping around. */
export function cycleRole(role: Role, backward: boolean): Role {
  const at = Math.max(0, ROLE_ORDER.indexOf(role));
  const step = backward ? -1 : 1;
  return ROLE_ORDER[(at + step + ROLE_ORDER.length) % ROLE_ORDER.length]!;
}

/** Alt+R by key position, so it works in any keyboard layout and on macOS's Option. */
export function isRoleShortcut(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "code" | "repeat">) {
  return event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyR" && !event.repeat;
}
