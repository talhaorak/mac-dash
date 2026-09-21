import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type DialogVariant = "modal" | "drawer";

export interface DialogProps {
  /** Controls visibility. The exit animation runs after this becomes false. */
  open: boolean;
  /** Called on Escape, on backdrop click, and by your own close button. */
  onClose: () => void;
  /** `modal` is centered. `drawer` slides in from the right edge. */
  variant?: DialogVariant;
  /** `id` of the element that titles the dialog. Use `useId()` for the value. */
  labelledBy?: string;
  /** Accessible name when the dialog has no visible title. */
  ariaLabel?: string;
  /** `id` of the element that describes the dialog. */
  describedBy?: string;
  /** Extra classes for the panel (padding, width, spacing). */
  className?: string;
  /** Element that receives focus on open. Defaults to the panel itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Set to false to ignore backdrop clicks. Defaults to true. */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0
  );
}

/** Open dialogs, oldest first. Only the last one reacts to the keyboard. */
const openDialogs: symbol[] = [];

const variants = {
  modal: {
    wrapper: "items-center justify-center p-8",
    backdrop: "bg-black/50",
    panel: "rounded-2xl w-full max-w-xl max-h-[85vh]",
    initial: { scale: 0.95, y: 20 },
    animate: { scale: 1, y: 0 },
    exit: { scale: 0.95, y: 20 },
    transition: { duration: 0.2 },
  },
  drawer: {
    wrapper: "justify-end",
    backdrop: "bg-black/40",
    panel: "w-full max-w-md h-full border-l border-white/[0.06]",
    initial: { x: 400 },
    animate: { x: 0 },
    exit: { x: 400 },
    transition: { type: "spring" as const, damping: 30, stiffness: 300 },
  },
};

/**
 * Accessible modal or drawer.
 *
 * The dialog closes on Escape and on backdrop click. It moves focus into the
 * panel on open, keeps Tab inside the panel, and returns focus to the trigger
 * element on close.
 */
export function Dialog({
  open,
  onClose,
  variant = "modal",
  labelledBy,
  ariaLabel,
  describedBy,
  className,
  initialFocusRef,
  closeOnBackdrop = true,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const token = Symbol("dialog");
    openDialogs.push(token);

    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    (initialFocusRef?.current ?? panelRef.current)?.focus({
      preventScroll: true,
    });

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;

      if (e.key === "Escape") {
        // A child that consumes Escape calls preventDefault().
        if (e.defaultPrevented) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const focusable = getFocusable(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      if (e.shiftKey) {
        if (!inside || active === first || active === panel) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const index = openDialogs.indexOf(token);
      if (index !== -1) openDialogs.splice(index, 1);
      if (trigger && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open, initialFocusRef]);

  if (typeof document === "undefined") return null;

  const v = variants[variant];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={cn("fixed inset-0 z-50 flex", v.wrapper)}
        >
          <div
            aria-hidden="true"
            className={cn("absolute inset-0 backdrop-blur-sm", v.backdrop)}
            onClick={closeOnBackdrop ? () => onClose() : undefined}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : ariaLabel}
            aria-describedby={describedBy}
            tabIndex={-1}
            initial={v.initial}
            animate={v.animate}
            exit={v.exit}
            transition={v.transition}
            className={cn(
              "relative glass overflow-y-auto focus:outline-none",
              v.panel,
              className
            )}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
