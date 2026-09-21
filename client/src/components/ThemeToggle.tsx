import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, getThemeChoice, watchSystemTheme, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, type TKey } from "@/i18n";

const CHOICES: { id: ThemeChoice; labelKey: TKey; icon: typeof Sun }[] = [
  { id: "system", labelKey: "theme.system", icon: Monitor },
  { id: "light", labelKey: "theme.light", icon: Sun },
  { id: "dark", labelKey: "theme.dark", icon: Moon },
];

export function ThemeToggle() {
  const { t } = useT();
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  useEffect(() => watchSystemTheme(), []);

  return (
    <div role="radiogroup" aria-label={t("theme.label")} className="inline-flex rounded-lg bg-white/[0.04] p-0.5">
      {CHOICES.map(({ id, labelKey, icon: Icon }) => {
        const label = t(labelKey);
        return (
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
        );
      })}
    </div>
  );
}
