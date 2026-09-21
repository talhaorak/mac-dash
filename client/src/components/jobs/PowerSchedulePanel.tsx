import { useEffect, useId, useState } from "react";
import { Moon, Sunrise } from "lucide-react";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { toast } from "@/components/ui/Toast";
import { backend, type PowerEvent, type PowerSchedule } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { inputClass } from "./fields";
import { CollapsibleCard, InlineError, useLoader } from "./StartupPanels";

// `pmset repeat` takes one event that starts the Mac and one event that stops it.

type Slot = "on" | "off";
type PowerType = PowerEvent["type"];

const SLOTS: Record<Slot, { title: string; icon: typeof Moon; types: { value: PowerType; title: string }[] }> = {
  on: {
    title: "Power on",
    icon: Sunrise,
    types: [
      { value: "wakeorpoweron", title: "Wake or start up" },
      { value: "wake", title: "Wake" },
      { value: "poweron", title: "Start up" },
    ],
  },
  off: {
    title: "Power off",
    icon: Moon,
    types: [
      { value: "sleep", title: "Sleep" },
      { value: "shutdown", title: "Shut down" },
      { value: "restart", title: "Restart" },
    ],
  },
};

const TYPE_TITLE = Object.fromEntries([...SLOTS.on.types, ...SLOTS.off.types].map((t) => [t.value, t.title])) as Record<PowerType, string>;
const slotOf = (type: PowerType): Slot => (SLOTS.on.types.some((t) => t.value === type) ? "on" : "off");

/** pmset day letters, Monday first. Thursday is R and Sunday is U. */
const DAYS: { letter: string; short: string; name: string }[] = [
  { letter: "M", short: "M", name: "Monday" },
  { letter: "T", short: "T", name: "Tuesday" },
  { letter: "W", short: "W", name: "Wednesday" },
  { letter: "R", short: "T", name: "Thursday" },
  { letter: "F", short: "F", name: "Friday" },
  { letter: "S", short: "S", name: "Saturday" },
  { letter: "U", short: "S", name: "Sunday" },
];

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

function describeDays(days: string): string {
  if (days === "MTWRFSU") return "every day";
  if (days === "MTWRF") return "on weekdays";
  if (days === "SU") return "on weekends";
  return `on ${DAYS.filter((d) => days.includes(d.letter))
    .map((d) => d.name.slice(0, 3))
    .join(", ")}`;
}

/** Problem of one slot as a sentence, or null. A slot that is off has no problem. */
function slotProblem(draft: SlotDraft): string | null {
  if (!draft.enabled) return null;
  if (!DAYS.some((d) => draft.days.includes(d.letter))) return "Choose at least one day.";
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(draft.time)) return "Set a time.";
  return null;
}

function toEvent(draft: SlotDraft): PowerEvent {
  return {
    type: draft.type,
    days: DAYS.filter((d) => draft.days.includes(d.letter))
      .map((d) => d.letter)
      .join(""),
    time: draft.time.length === 5 ? `${draft.time}:00` : draft.time,
  };
}

const loadSchedule = () => backend.getPowerSchedule();

/** Collapsible card that shows and edits the repeating wake and sleep schedule of the Mac (`pmset repeat`). */
export function PowerSchedulePanel() {
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
      toast.error(`Power schedule: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    setSubmitted(true);
    if (noneEnabled || problems.on || problems.off) return;
    void send(
      (["on", "off"] as const).filter((slot) => drafts[slot].enabled).map((slot) => toEvent(drafts[slot])),
      "Power schedule saved"
    );
  };

  const current = schedule.data?.repeating ?? [];

  return (
    <CollapsibleCard title="Power schedule" summary="Repeating wake, start up, sleep and shut down" onFirstOpen={schedule.load}>
      <div className="p-2 space-y-4">
        {schedule.error && <InlineError title="The power schedule could not be read." message={schedule.error} onRetry={schedule.load} retrying={schedule.loading} />}

        <section aria-label="Current schedule" className="space-y-1">
          <h3 className="text-xs font-semibold text-gray-400">Current schedule</h3>
          {schedule.data === null ? (
            <p className="text-[11px] text-gray-600">{schedule.loading ? "Reading pmset…" : schedule.error ? "Unknown." : "Not loaded."}</p>
          ) : current.length === 0 ? (
            <p className="text-[11px] text-gray-600">The Mac has no repeating power event.</p>
          ) : (
            <ul className="space-y-0.5">
              {current.map((event, i) => (
                <li key={i} className="text-xs text-gray-300">
                  <span className="font-medium">{TYPE_TITLE[event.type] ?? event.type}</span> at <span className="font-mono">{event.time.slice(0, 5)}</span>{" "}
                  {describeDays(event.days)}
                </li>
              ))}
            </ul>
          )}
          {schedule.data?.raw && (
            <details className="text-[11px] text-gray-600">
              <summary className="cursor-pointer hover:text-gray-400 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50">pmset output</summary>
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
          <h3 className="text-xs font-semibold text-gray-400">Edit</h3>
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
              Turn on at least one event. To remove every event, use "Clear schedule".
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-[11px] text-red-400 break-words">
              The schedule was not saved: {saveError}
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-2 rounded-xl text-xs font-semibold text-cyan-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              {saving ? "Waiting for macOS…" : "Save schedule"}
            </button>
            <ConfirmButton
              onConfirm={() => send([], "Power schedule cleared")}
              disabled={saving}
              confirmLabel="Click again to clear"
              className="px-3 py-2 rounded-xl text-xs text-gray-300 bg-white/[0.04] hover:bg-red-500/10 hover:text-red-400 border border-white/[0.06] disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50"
              armedClassName="bg-red-500/20! text-red-300!"
            >
              Clear schedule
            </ConfirmButton>
            <p className="text-[11px] text-gray-600 basis-full sm:basis-auto">
              Both buttons run <span className="font-mono">pmset repeat</span>. macOS asks for an administrator password on the Mac.
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
  const off = disabled || !draft.enabled;

  const toggleDay = (letter: string) =>
    onChange({ ...draft, days: draft.days.includes(letter) ? draft.days.replace(letter, "") : draft.days + letter });

  return (
    <fieldset className={cn("min-w-0 rounded-xl border bg-black/20 p-3 space-y-2.5", problem ? "border-red-500/30" : "border-white/[0.06]")}>
      <legend className="sr-only">{spec.title}</legend>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          className="w-3.5 h-3.5 accent-cyan-400"
        />
        <spec.icon className="w-4 h-4 text-gray-400" aria-hidden />
        <span className="text-sm font-medium text-gray-200">{spec.title}</span>
        <span className="ml-auto text-[11px] text-gray-600">{draft.enabled ? "scheduled" : "not scheduled"}</span>
      </label>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <label className="space-y-1 min-w-0">
          <span className="block text-[11px] text-gray-500">Action</span>
          <select value={draft.type} disabled={off} onChange={(e) => onChange({ ...draft, type: e.target.value as PowerType })} className={cn(inputClass, "py-1.5 text-xs")}>
            {spec.types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] text-gray-500">Time</span>
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

      <div role="group" aria-label={`${spec.title}: days`} aria-describedby={problem ? `${id}-problem` : undefined} className="flex gap-1">
        {DAYS.map((day) => {
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
              {day.short}
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
