import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  glow?: "accent" | "success" | "danger" | "none";
  hover?: boolean;
  onClick?: () => void;
  padding?: "sm" | "md" | "lg";
}

export function GlowCard({
  children,
  className,
  glow = "none",
  hover = false,
  onClick,
  padding = "md",
}: GlowCardProps) {
  const paddings = { sm: "p-3", md: "p-4", lg: "p-6" };
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      onClick={onClick}
      className={cn(
        "glass rounded-2xl",
        paddings[padding],
        hover && "glass-hover cursor-pointer transition-all duration-200",
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
