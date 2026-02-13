import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

/**
 * Start dragging the current desktop window.
 * We prefer app invoke (Rust command) to avoid frontend window permission issues.
 */
export async function startDesktopWindowDrag(
  startScreenX: number,
  startScreenY: number
): Promise<void> {
  try {
    await invoke("begin_window_drag");
    return;
  } catch {
    // fallback to direct window API
  }

  try {
    await getCurrentWindow().startDragging();
    return;
  } catch {
    // fallback to manual move when start_dragging is unavailable
  }

  const win = getCurrentWindow();
  const startPos = await win.outerPosition();
  const baseX = startPos.x;
  const baseY = startPos.y;

  let raf: number | null = null;
  let latestScreenX = startScreenX;
  let latestScreenY = startScreenY;
  let dragging = true;

  const applyMove = async () => {
    raf = null;
    if (!dragging) return;
    const dx = latestScreenX - startScreenX;
    const dy = latestScreenY - startScreenY;
    try {
      await win.setPosition(new PhysicalPosition(baseX + dx, baseY + dy));
    } catch {
      cleanup();
    }
  };

  const scheduleMove = () => {
    if (raf !== null) return;
    raf = window.requestAnimationFrame(() => {
      void applyMove();
    });
  };

  const onMouseMove = (event: MouseEvent) => {
    latestScreenX = event.screenX;
    latestScreenY = event.screenY;
    scheduleMove();
  };

  const cleanup = () => {
    if (!dragging) return;
    dragging = false;
    if (raf !== null) {
      window.cancelAnimationFrame(raf);
      raf = null;
    }
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", cleanup, true);
    window.removeEventListener("mouseleave", cleanup, true);
    window.removeEventListener("blur", cleanup, true);
  };

  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", cleanup, true);
  window.addEventListener("mouseleave", cleanup, true);
  window.addEventListener("blur", cleanup, true);
}
