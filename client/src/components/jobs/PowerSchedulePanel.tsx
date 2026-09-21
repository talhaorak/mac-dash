import { useEffect, useId, useState } from "react";
import { Moon, Sunrise } from "lucide-react";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { toast } from "@/components/ui/Toast";
import { backend, type PowerEvent, type PowerSchedule } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { intlLocale, t, useT, type TKey } from "@/i18n";
import { inputClass } from "./fields";
import { CollapsibleCard, InlineError, useLoader } from "./StartupPanels";

// `pmset repeat` takes one event that starts the Mac and one event that stops it.

type Slot = "on" | "off";
type PowerType = PowerEvent["type"];

const SLOT_TITLE_KEY: Record<Slot, TKey> = { on: "detail.power.slotOn", off: "detail.power.slotOff" };

const SLOTS: Record<Slot, { icon: typeof Moon; types: PowerType[] }> = {
  on: { icon: Sunrise, types: ["wakeorpoweron", "wake", "poweron"] },
  off: { icon: Moon, types: ["sleep", "shutdown", "restart"] },
};

const TYPE_TITLE_KEY: Record<PowerType, TKey> = {
  wakeorpoweron: "detail.power.typeWakeOrPowerOn",
  wake: "detail.power.typeWake",
  poweron: "detail.power.typePowerOn",
  sleep: "detail.power.typeSleep",
  shutdown: "detail.power.typeShutdown",
  restart: "common.restart",
};

/** Display title of a power event type, in the active language. Called at use time. */
function typeTitle(type: PowerType): string {
  return t(TYPE_TITLE_KEY[type]);
}

const slotOf = (type: PowerType): Slot => (SLOTS.on.types.some((v) => v === type) ? "on" : "off");

/** pmset day letters, Monday first. Thursday is R and Sunday is U. These never change with the language. */
const DAY_LETTERS = ["M", "T", "W", "R", "F", "S", "U"] as const;

/** A fixed reference week (2024-01-01 is a Monday, in UTC) used only to ask `Intl` for weekday names. */
function weekdayDate(index: number): Date {
  return new Date(Date.UTC(2024, 0, 1 + index));
}

/** "M"/"P" (narrow), "Mon"/"Pzt" (short) or "Monday"/"Pazartesi" (long), in the active language. Called at use time. */
function weekdayLabel(index: number, style: "narrow" | "short" | "long"): string {
  return new Intl.DateTimeFormat(intlLocale(), { weekday: style, timeZone: "UTC" }).format(weekdayDate(index));
}

/** The 7 days of the week, Monday first, with the pmset letter and the display forms of the active language. */
function powerDays(): { letter: string; display: string; name: string }[] {
  return DAY_LETTERS.map((letter, i) => ({ letter, display: weekdayLabel(i, "narrow"), name: weekdayLabel(i, "long") }));
}

interface SlotDraft {
  enabled: boolean;
  type: PowerType;
  /** Subset of "MTWRFSU". The order is restored on save. */
  days: string;
  /** "HH:MM" from the time input, or "" when it is not set. */
  time: string;
}

const EMPTY: Record<Slot, SlotDraft> = {
  on: { enabled: false, type: "wakeorpoweron", days: "MTWRF", time: "07:00" },
  off: { enabled: false, type: "sleep", days: "MTWRFSU", time: "23:00" },
};

function draftsFrom(schedule: PowerSchedule | null): Record<Slot, SlotDraft> {
  const drafts = { on: { ...EMPTY.on }, off: { ...EMPTY.off } };
  for (const event of schedule?.repeating ?? []) {
    drafts[slotOf(event.type)] = { enabled: true, type: event.type, days: event.days, time: event.time.slice(0, 5) };
  }
  return drafts;
}

/** Called at use time, in the active language. */
function describeDays(days: string): string {
  if (days === "MTWRFSU") return t("detail.power.everyDay");
  if (days === "MTWRF") return t("detail.power.weekdays");
  if (days === "SU") return t("detail.power.weekends");
  const list = DAY_LETTERS.map((letter, i) => (days.includes(letter) ? weekdayLabel(i, "short") : null))
    .filter((label): label is string => label !== null)
    .join(", ");
  return t("detail.power.onDays", { days: list });
}

/** Problem of one slot as a sentence, or null. A slot that is off has no problem. Called at use time. */
function slotProblem(draft: SlotDraft): string | null {
  if (!draft.enabled) return null;
  if (!DAY_LETTERS.some((letter) => draft.days.includes(letter))) return t("detail.power.chooseDay");
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(draft.time)) return t("detail.power.setTime");
  return null;
}

function toEvent(draft: SlotDraft): PowerEvent {
  return {
    type: draft.type,
    days: DAY_LETTERS.filter((letter) => draft.days.includes(letter)).join(""),
    time: draft.time.length === 5 ? `${draft.time}:00` : draft.time,
  };
}

const loadSchedule = () => backend.getPowerSchedule();

/** Collapsible card that shows and edits the repeating wake and sleep schedule of the Mac (`pmset repeat`). */
export function PowerSchedulePanel() {
  useT(); // subscribe: re-render when the language changes
  const schedule = useLoader<PowerSchedule>(loadSchedule);
  const [drafts, setDrafts] = useState(() => draftsFrom(null));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A fresh read replaces the drafts: the Mac is the source of truth.
  useEffect(() => {
    if (schedule.data) {
      setDrafts(draftsFrom(schedule.data));
      setSubmitted(false);
    }
  }, [schedule.data]);

  const problems = { on: slotProblem(drafts.on), off: slotProblem(drafts.off) };
  const noneEnabled = !drafts.on.enabled && !drafts.off.enabled;

  const send = async (events: PowerEvent[], done: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await backend.setPowerSchedule(events);
      toast.success(done);
      await schedule.load();
    } catch (e) {
      const message = (e as Error).message;
      setSaveError(message);
      toast.error(`${t("detail.power.errorPrefix")} ${message}`);
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    setSubmitted(true);
    if (noneEnabled || problems.on || problems.off) return;
    void send(
      (["on", "off"] as const).filter((slot) => drafts[slot].enabled).map((slot) => toEvent(drafts[slot])),
      t("detail.power.saved")
    );
  };

  const current = schedule.data?.repeating ?? [];

  return (
    <CollapsibleCard title={t("detail.power.title")} summary={t("detail.power.summary")} onFirstOpen={schedule.load}>
      <div className="p-2 space-y-4">
        {schedule.error && <InlineError title={t("detail.power.readError")} message={schedule.error} onRetry={schedule.load} retrying={schedule.loading} />}

        <section aria-label={t("detail.power.currentTitle")} className="space-y-1">
          <h3 className="text-xs font-semibold text-gray-400">{t("detail.power.currentTitle")}</h3>
          {schedule.data === null ? (
            <p className="text-[11px] text-gray-600">
              {schedule.loading ? t("detail.power.readingPmset") : schedule.error ? t("detail.power.unknownState") : t("detail.common.notLoaded")}
            </p>
          ) : current.length === 0 ? (
            <p className="text-[11px] text-gray-600">{t("detail.power.noEvents")}</p>
          ) : (
            <ul className="space-y-0.5">
              {current.map((event, i) => (
                <li key={i} className="text-xs text-gray-300">
                  {t("detail.power.scheduleLine", { type: typeTitle(event.type), time: event.time.slice(0, 5), days: describeDays(event.days) })}
                </li>
              ))}
            </ul>
          )}
          {schedule.data?.raw && (
            <details className="text-[11px] text-gray-600">
              <summary className="cursor-pointer hover:text-gray-400 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50">
                {t("detail.power.pmsetOutput")}
              </summary>
              <pre className="mt-1 p-2 rounded-lg bg-black/30 font-mono text-[10px] text-gray-400 whitespace-pre-wrap">{schedule.data.raw}</pre>
            </details>
          )}
        </section>

        <form
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3 className="text-xs font-semibold text-gray-400">{t("common.edit")}</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {(["on", "off"] as const).map((slot) => (
              <SlotEditor
                key={slot}
                slot={slot}
                draft={drafts[slot]}
                problem={submitted ? problems[slot] : null}
                disabled={saving}
                onChange={(next) => setDrafts({ ...drafts, [slot]: next })}
              />
            ))}
          </div>

          {submitted && noneEnabled && (
            <p role="alert" className="text-[11px] text-red-400">
              {t("detail.power.enableAtLeastOne")}
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-[11px] text-red-400 break-words">
              {t("detail.power.notSaved")} {saveError}
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-2 rounded-xl text-xs font-semibold text-cyan-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              {saving ? t("detail.power.waitingForMacOS") : t("detail.power.saveButton")}
            </button>
            <ConfirmButton
              onConfirm={() => send([], t("detail.power.cleared"))}
              disabled={saving}
              confirmLabel={t("detail.power.confirmClear")}
              className="px-3 py-2 rounded-xl text-xs text-gray-300 bg-white/[0.04] hover:bg-red-500/10 hover:text-red-400 border border-white/[0.06] disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50"
              armedClassName="bg-red-500/20! text-red-300!"
            >
              {t("detail.power.clearButton")}
            </ConfirmButton>
            <p className="text-[11px] text-gray-600 basis-full sm:basis-auto">
              {t("detail.power.bothButtons", { cmd: "pmset repeat" })}
            </p>
          </div>
        </form>
      </div>
    </CollapsibleCard>
  );
}

function SlotEditor({
  slot,
  draft,
  problem,
  disabled,
  onChange,
}: {
  slot: Slot;
  draft: SlotDraft;
  problem: string | null;
  disabled: boolean;
  onChange: (draft: SlotDraft) => void;
}) {
  const id = useId();
  const spec = SLOTS[slot];
  const slotTitle = t(SLOT_TITLE_KEY[slot]);
  const off = disabled || !draft.enabled;

  const toggleDay = (letter: string) =>
    onChange({ ...draft, days: draft.days.includes(letter) ? draft.days.replace(letter, "") : draft.days + letter });

  return (
    <fieldset className={cn("min-w-0 rounded-xl border bg-black/20 p-3 space-y-2.5", problem ? "border-red-500/30" : "border-white/[0.06]")}>
      <legend className="sr-only">{slotTitle}</legend>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          className="w-3.5 h-3.5 accent-cyan-400"
        />
        <spec.icon className="w-4 h-4 text-gray-400" aria-hidden />
        <span className="text-sm font-medium text-gray-200">{slotTitle}</span>
        <span className="ml-auto text-[11px] text-gray-600">{draft.enabled ? t("detail.power.scheduled") : t("detail.power.notScheduled")}</span>
      </label>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <label className="space-y-1 min-w-0">
          <span className="block text-[11px] text-gray-500">{t("detail.power.action")}</span>
          <select value={draft.type} disabled={off} onChange={(e) => onChange({ ...draft, type: e.target.value as PowerType })} className={cn(inputClass, "py-1.5 text-xs")}>
            {spec.types.map((type) => (
              <option key={type} value={type}>
                {typeTitle(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] text-gray-500">{t("detail.power.time")}</span>
          <input
            type="time"
            value={draft.time}
            disabled={off}
            required
            aria-invalid={problem !== null}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onChange={(e) => onChange({ ...draft, time: e.target.value })}
            className={cn(inputClass, "w-auto! py-1.5 text-xs font-mono [color-scheme:dark]")}
          />
        </label>
      </div>

      <div role="group" aria-label={t("detail.power.daysGroupAria", { slot: slotTitle })} aria-describedby={problem ? `${id}-problem` : undefined} className="flex gap-1">
        {powerDays().map((day) => {
          const on = draft.days.includes(day.letter);
          return (
            <button
              key={day.letter}
              type="button"
              disabled={off}
              aria-pressed={on}
              aria-label={day.name}
              title={day.name}
              onClick={() => toggleDay(day.letter)}
              className={cn(
                "w-8 h-8 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
                // Pressed days carry an outline and a filled background, so the state does not depend on the hue alone.
                on ? "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/40" : "bg-transparent text-gray-600 hover:text-gray-300 border border-dashed border-white/[0.08]"
              )}
            >
              {day.display}
            </button>
          );
        })}
      </div>

      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-[11px] text-red-400">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
