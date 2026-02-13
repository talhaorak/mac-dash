import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: "running" | "stopped" | "error" | "unknown" | "enabled" | "disabled";
  label?: string;
  size?: "sm" | "md";
}

const config = {
  running: { color: "bg-green-500", ring: "ring-green-500/30", label: "Running" },
  stopped: { color: "bg-gray-500", ring: "ring-gray-500/30", label: "Stopped" },
  error: { color: "bg-red-500", ring: "ring-red-500/30", label: "Error" },
  unknown: { color: "bg-yellow-500", ring: "ring-yellow-500/30", label: "Unknown" },
  enabled: { color: "bg-cyan-500", ring: "ring-cyan-500/30", label: "Enabled" },
  disabled: { color: "bg-gray-600", ring: "ring-gray-600/30", label: "Disabled" },
};

export function StatusBadge({ status, label, size = "md" }: StatusBadgeProps) {
  const c = config[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "rounded-full ring-2",
          c.color,
          c.ring,
          status === "running" && "status-pulse",
          size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5"
        )}
      />
      {(label ?? c.label) && (
        <span
          className={cn(
            "font-medium",
            size === "sm" ? "text-xs" : "text-xs",
            status === "running" && "text-green-400",
            status === "stopped" && "text-gray-400",
            status === "error" && "text-red-400",
            status === "unknown" && "text-yellow-400"
          )}
        >
          {label ?? c.label}
        </span>
      )}
    </span>
  );
}
