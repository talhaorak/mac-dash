import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToastStore, type ToastKind } from "@/stores/toast";

export { toast } from "@/stores/toast";

const kindStyles: Record<
  ToastKind,
  { icon: typeof Info; iconClass: string; border: string; label: string }
> = {
  success: {
    icon: CheckCircle2,
    iconClass: "text-green-400",
    border: "border-green-500/30",
    label: "Success",
  },
  error: {
    icon: AlertTriangle,
    iconClass: "text-red-400",
    border: "border-red-500/30",
    label: "Error",
  },
  info: {
    icon: Info,
    iconClass: "text-cyan-400",
    border: "border-cyan-500/30",
    label: "Info",
  },
};

/** Renders the toast stack. Mount it once, near the root of the app. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-2 pointer-events-none"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const style = kindStyles[t.kind];
          const Icon = style.icon;
          const isError = t.kind === "error";
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.2 }}
              role={isError ? "alert" : "status"}
              aria-live={isError ? "assertive" : "polite"}
              className={cn(
                "pointer-events-auto glass rounded-xl shadow-xl border w-80 max-w-[calc(100vw-2rem)] px-3 py-2.5 flex items-start gap-2.5",
                style.border
              )}
            >
              <Icon
                className={cn("w-4 h-4 mt-0.5 flex-shrink-0", style.iconClass)}
                aria-hidden="true"
              />
              <p className="flex-1 min-w-0 text-xs text-gray-200 break-words">
                <span className="sr-only">{style.label}: </span>
                {t.message}
              </p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="p-1 -m-0.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
