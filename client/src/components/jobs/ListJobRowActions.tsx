import { memo } from "react";
import { Copy, Pencil, Play, Power, PowerOff, RotateCw, Square } from "lucide-react";
import type { JobEditorTarget } from "@/components/jobs/JobEditor";
import type { ServiceAction } from "@/lib/backend";
import type { ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";

/** Stable identity of a job across the views of the Services page. */
export const serviceKey = (s: { category: string; label: string }) => `${s.category}/${s.label}`;

/** Actions that ask for a second click before they run. */
export type ArmedAction = "stop" | "disable";

export interface JobRowActionsProps {
  service: ServiceInfo;
  /** An action of this job is in flight: the launchctl buttons are disabled. */
  busy: boolean;
  /** The action that waits for its confirming second click, if any. */
  armedAction: ArmedAction | null;
  /** The owner decides which actions need a confirmation. */
  onAction: (action: ServiceAction, service: ServiceInfo) => void;
  onEdit: (target: JobEditorTarget) => void;
  /** Extra classes for the button group, e.g. the reveal-on-hover classes of a row. */
  className?: string;
}

const iconButton =
  "p-1.5 rounded-lg text-gray-500 transition-colors disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-cyan-500/50 focus:outline-none";

/**
 * Icon buttons of one job row: run or stop and restart, enable or disable, edit, duplicate.
 * The buttons stop click propagation, so a clickable row around them does not open.
 */
export const JobRowActions = memo(function JobRowActions({ service, busy, armedAction, onAction, onEdit, className }: JobRowActionsProps) {
  const ref = { label: service.label, category: service.category };
  const hasFile = service.plistPath !== null;
  const act = (action: ServiceAction) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onAction(action, service);
  };
  const edit = (mode: "edit" | "duplicate") => (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit({ mode, job: ref });
  };

  return (
    <div className={cn("flex gap-1", className)}>
      {service.status === "running" ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={act("stop")}
            aria-label={armedAction === "stop" ? `Confirm stop ${service.label}` : `Stop ${service.label}`}
            title={armedAction === "stop" ? "Click again to stop" : "Stop"}
            className={cn(iconButton, armedAction === "stop" ? "bg-red-500/25 text-red-300" : "hover:bg-red-500/10 hover:text-red-400")}
          >
            <Square className="w-3 h-3" aria-hidden />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={act("restart")}
            aria-label={`Restart ${service.label}`}
            title="Restart"
            className={cn(iconButton, "hover:bg-cyan-500/10 hover:text-cyan-400")}
          >
            <RotateCw className="w-3 h-3" aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={act("start")}
          aria-label={`Run ${service.label} now`}
          title="Run now"
          className={cn(iconButton, "hover:bg-green-500/10 hover:text-green-400")}
        >
          <Play className="w-3 h-3" aria-hidden />
        </button>
      )}

      {service.disabled ? (
        <button
          type="button"
          disabled={busy}
          onClick={act("enable")}
          aria-label={`Enable ${service.label}`}
          title="Enable and load"
          className={cn(iconButton, "hover:bg-cyan-500/10 hover:text-cyan-400")}
        >
          <Power className="w-3 h-3" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={act("disable")}
          aria-label={armedAction === "disable" ? `Confirm disable ${service.label}` : `Disable ${service.label}`}
          title={armedAction === "disable" ? "Click again to disable" : "Disable and unload"}
          className={cn(iconButton, armedAction === "disable" ? "bg-amber-500/25 text-amber-300" : "hover:bg-amber-500/10 hover:text-amber-400")}
        >
          <PowerOff className="w-3 h-3" aria-hidden />
        </button>
      )}

      {hasFile && (
        <>
          <button
            type="button"
            onClick={edit("edit")}
            aria-label={`${service.writable ? "Edit" : "View"} ${service.label}`}
            title={service.writable ? "Edit" : "View plist"}
            className={cn(iconButton, "hover:bg-white/[0.06] hover:text-gray-300")}
          >
            <Pencil className="w-3 h-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={edit("duplicate")}
            aria-label={`Duplicate ${service.label}`}
            title="Duplicate"
            className={cn(iconButton, "hover:bg-white/[0.06] hover:text-gray-300")}
          >
            <Copy className="w-3 h-3" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
});
