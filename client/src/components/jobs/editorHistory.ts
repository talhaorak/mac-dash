import type { JobCategory } from "@shared/launchd";

// Undo and redo for the whole job editor. A snapshot is what a save would write: the XML text and the scope.
// Pure state transitions: the editor component owns the clock and the keyboard.

export interface EditorSnapshot {
  xml: string;
  category: JobCategory;
}

export interface EditorHistory {
  past: EditorSnapshot[];
  present: EditorSnapshot;
  future: EditorSnapshot[];
  /** Time of the last recorded edit. `null` closes the current step: the next edit starts a new one. */
  lastEditAt: number | null;
}

/** Edits that follow each other within this time are one undo step (one burst of typing). */
export const HISTORY_COALESCE_MS = 600;
export const HISTORY_LIMIT = 200;

export function sameSnapshot(a: EditorSnapshot, b: EditorSnapshot): boolean {
  return a.xml === b.xml && a.category === b.category;
}

export function createHistory(initial: EditorSnapshot): EditorHistory {
  return { past: [], present: initial, future: [], lastEditAt: null };
}

/** Record an edit made at `now` (milliseconds). An edit always clears the redo list. */
export function recordEdit(history: EditorHistory, snapshot: EditorSnapshot, now: number): EditorHistory {
  if (sameSnapshot(history.present, snapshot)) return history;
  const coalesce =
    history.lastEditAt !== null && history.past.length > 0 && now >= history.lastEditAt && now - history.lastEditAt <= HISTORY_COALESCE_MS;
  if (coalesce) {
    // Typing "abc" and deleting it again within one burst leaves no step behind.
    const before = history.past[history.past.length - 1];
    if (sameSnapshot(before, snapshot)) return { past: history.past.slice(0, -1), present: snapshot, future: [], lastEditAt: null };
    return { past: history.past, present: snapshot, future: [], lastEditAt: now };
  }
  const past = [...history.past, history.present];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, present: snapshot, future: [], lastEditAt: now };
}

export const canUndo = (history: EditorHistory) => history.past.length > 0;
export const canRedo = (history: EditorHistory) => history.future.length > 0;

export function undo(history: EditorHistory): EditorHistory {
  if (!canUndo(history)) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
    lastEditAt: null,
  };
}

export function redo(history: EditorHistory): EditorHistory {
  if (!canRedo(history)) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
    lastEditAt: null,
  };
}

/** Close the current step, so the next edit is not merged into it (used before a discrete action such as "Discard changes"). */
export function sealHistory(history: EditorHistory): EditorHistory {
  return history.lastEditAt === null ? history : { ...history, lastEditAt: null };
}

// ── Keyboard ─────────────────────────────────────────────────────────

/** Input types that do not hold text: the browser has no undo of its own for them. */
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/**
 * True when the focused element has its own text undo (Cmd+Z must stay with the field).
 * Takes plain values, so it is tested without a DOM.
 */
export function isTextEntry(element: { tagName: string; type?: string | null; isContentEditable?: boolean; readOnly?: boolean } | null): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  return !NON_TEXT_INPUTS.has((element.type ?? "text").toLowerCase());
}

export type HistoryShortcut = "undo" | "redo" | null;

/** Cmd/Ctrl+Z is undo. Shift+Cmd/Ctrl+Z and Ctrl+Y are redo. */
export function historyShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): HistoryShortcut {
  if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}
