import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, getThemeChoice, watchSystemTheme, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

const CHOICES: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "Match macOS", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  useEffect(() => watchSystemTheme(), []);

  return (
    <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-lg bg-white/[0.04] p-0.5">
      {CHOICES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={choice === id}
          aria-label={label}
          title={label}
          onClick={() => {
            setChoice(id);
            applyTheme(id);
          }}
          className={cn(
            "p-1.5 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
            choice === id ? "bg-white/[0.08] text-gray-100" : "text-gray-500 hover:text-gray-300"
          )}
        >
          <Icon className="w-3.5 h-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}
