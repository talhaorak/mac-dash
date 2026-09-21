import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import type { KeyboardEvent, ReactNode } from "react";

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  glow?: "accent" | "success" | "danger" | "none";
  hover?: boolean;
  onClick?: () => void;
  padding?: "sm" | "md" | "lg";
  /** Accessible name for a clickable card. Defaults to the card's text content. */
  ariaLabel?: string;
}

export function GlowCard({
  children,
  className,
  glow = "none",
  hover = false,
  onClick,
  padding = "md",
  ariaLabel,
}: GlowCardProps) {
  const paddings = { sm: "p-3", md: "p-4", lg: "p-6" };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ignore keys that come from interactive children.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      onClick={onClick}
      {...(onClick
        ? {
            role: "button",
            tabIndex: 0,
            onKeyDown: handleKeyDown,
            "aria-label": ariaLabel,
          }
        : {})}
      className={cn(
        "glass rounded-2xl",
        paddings[padding],
        hover && "glass-hover cursor-pointer transition-all duration-200",
        onClick &&
          "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
        glow === "accent" && "glow-accent",
        glow === "success" && "glow-success",
        glow === "danger" && "glow-danger",
        className
      )}
    >
      {children}
    </motion.div>
  );
}
