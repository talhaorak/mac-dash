import { scopeFor, type JobCategory } from "@shared/launchd";

// Unsaved editor state, kept in localStorage so it survives a closed dialog or a page reload.
// The storage is passed in, so the logic is unit-tested without a browser.

export const DRAFT_PREFIX = "macdash.jobDraft:";
/** Same limit as a privileged save (docs/backend-contract.md). */
export const DRAFT_MAX_LENGTH = 200 * 1024;
export const DRAFT_DEBOUNCE_MS = 800;

export interface JobDraft {
  xml: string;
  category: JobCategory;
  savedAt: number;
}

export type DraftTarget =
  | { mode: "new"; category?: JobCategory }
  | { mode: "edit" | "duplicate"; job: { label: string; category: JobCategory } };

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** macdash.jobDraft:<mode>:<category>/<label or "new"> */
export function jobDraftKey(target: DraftTarget): string {
  const tail = target.mode === "new" ? `${target.category ?? "user-agents"}/new` : `${target.job.category}/${target.job.label}`;
  return `${DRAFT_PREFIX}${target.mode}:${tail}`;
}

/** Parse a stored draft. Anything that is not a complete draft for a writable scope is ignored. */
export function parseDraft(raw: string | null): JobDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<JobDraft> | null;
    if (!v || typeof v.xml !== "string" || typeof v.category !== "string") return null;
    // The banner formats savedAt as a date: it must be a valid time value.
    if (typeof v.savedAt !== "number" || Number.isNaN(new Date(v.savedAt).getTime())) return null;
    if (v.xml.length > DRAFT_MAX_LENGTH || !scopeFor(v.category)?.writable) return null;
    return { xml: v.xml, category: v.category, savedAt: v.savedAt };
  } catch {
    return null;
  }
}

/** localStorage throws in private windows and when the quota is full. A draft is a convenience: never fail on it. */
export function readDraft(storage: DraftStorage | null, key: string): JobDraft | null {
  try {
    return storage ? parseDraft(storage.getItem(key)) : null;
  } catch {
    return null;
  }
}

/** Returns true when the draft is stored. Drafts over the size limit are not stored. */
export function writeDraft(storage: DraftStorage | null, key: string, draft: JobDraft): boolean {
  if (!storage || draft.xml.length > DRAFT_MAX_LENGTH) return false;
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // nothing to clean up
  }
}

/** `window.localStorage` itself throws when storage is blocked. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
