import { useCallback, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "@/lib/backend";

/**
 * Window dragging in the desktop (Tauri) build.
 *
 * Primary mechanism: the `data-tauri-drag-region` attribute. Tauri handles it
 * natively, but only when the attribute is on the event target itself. It does
 * not apply to child elements.
 *
 * Fallback: `useWindowDrag()` returns a `mousedown` handler for a drag
 * container. It covers non-interactive children (logo, labels) that do not
 * carry the attribute, and calls the Rust command `begin_window_drag`.
 */

const DRAG_REGION_ATTR = "data-tauri-drag-region";

const NO_DRAG_SELECTOR =
  "button, a, input, textarea, select, [role=button], [data-no-drag], .no-drag";

export function useWindowDrag() {
  return useCallback((e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || !backend.isDesktop()) return;
    const target = e.target as Element;
    // Tauri handles elements that carry the attribute.
    if (target.hasAttribute(DRAG_REGION_ATTR)) return;
    if (target.closest(NO_DRAG_SELECTOR)) return;
    e.preventDefault();
    invoke("begin_window_drag").catch(() => {
      // The window stays in place when the command is unavailable.
    });
  }, []);
}
