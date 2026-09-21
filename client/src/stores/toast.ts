import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  success: 5000,
  info: 5000,
  error: 8000,
};

/** Oldest toasts are dropped when more than this many are on screen. */
const MAX_VISIBLE = 5;

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, message, durationMs) => {
    const id = nextId++;
    const all = [...get().toasts, { id, kind, message }];
    const dropped = all.slice(0, Math.max(0, all.length - MAX_VISIBLE));
    for (const t of dropped) clearTimer(t.id);
    set({ toasts: all.slice(-MAX_VISIBLE) });

    const duration = durationMs ?? DEFAULT_DURATION_MS[kind];
    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => get().dismiss(id), duration)
      );
    }
    return id;
  },
  dismiss: (id) => {
    clearTimer(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/**
 * Imperative toast API. Works outside React components.
 * Pass `durationMs = 0` to keep a toast until the user dismisses it.
 */
export const toast = {
  success: (message: string, durationMs?: number) =>
    useToastStore.getState().push("success", message, durationMs),
  error: (message: string, durationMs?: number) =>
    useToastStore.getState().push("error", message, durationMs),
  info: (message: string, durationMs?: number) =>
    useToastStore.getState().push("info", message, durationMs),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};
