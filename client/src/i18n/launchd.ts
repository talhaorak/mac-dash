/**
 * Display-time localisation of the English text that `shared/launchd.ts` produces.
 *
 * The shared functions stay English: the server and the Rust backend compare their output (`describeTriggers`
 * is part of the backend contract). The client translates here and falls back to the English input.
 *
 * For the active locale "en" every function below is a thin pass-through to the shared function, so the
 * English output stays byte-identical to `shared/launchd.ts` by construction. Only non-English locales parse
 * the English text (`localizeTrigger`) or rebuild the phrase from structured data (`localizeCalendarEntry`,
 * `localizeExitStatus`) using the dictionaries in `parts/launchd.*.ts`.
 */
import type { PlistDict } from "@shared/plist";
import {
  EXIT_CODES,
  KEY_SPEC,
  SIGNALS,
  describeCalendarEntry,
  explainExitStatus,
  formatInterval,
  scopeFor,
  type JobIssue,
} from "@shared/launchd";
import { getLocale, intlLocale, t, tDynamic, tn, type Locale } from "./index";

// ── Calendar phrase rendering ────────────────────────────────────────

const WEEKDAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** `weekday` is launchd's 0–7 range (0 and 7 both mean Sunday). */
function weekdayLabel(weekday: number, target: Locale): string {
  const idx = ((weekday % 7) + 7) % 7;
  if (target === "en") return WEEKDAY_NAMES_EN[idx];
  // 2023-01-01 is a Sunday: build a date whose weekday matches idx and let Intl name it.
  const date = new Date(Date.UTC(2023, 0, 1 + idx));
  return new Intl.DateTimeFormat(intlLocale(target), { weekday: "short", timeZone: "UTC" }).format(date);
}

function monthLabel(month: number, target: Locale): string {
  if (month < 1 || month > 12) return String(month);
  if (target === "en") return MONTH_NAMES_EN[month - 1];
  const date = new Date(Date.UTC(2023, month - 1, 1));
  return new Intl.DateTimeFormat(intlLocale(target), { month: "short", timeZone: "UTC" }).format(date);
}

interface CalendarFields {
  hour?: number;
  minute?: number;
  day?: number;
  weekday?: number;
  month?: number;
}

/** Non-English renderer for a `StartCalendarInterval` entry. Mirrors the structure of `describeCalendarEntry`. */
function renderCalendarFields(fields: CalendarFields, target: Locale): string {
  const { hour, minute, day, weekday, month } = fields;

  let time: string;
  if (hour !== undefined && minute !== undefined) time = t("launchd.calendar.atTime", { hour: pad(hour), minute: pad(minute) });
  else if (hour !== undefined) time = t("launchd.calendar.everyMinuteOfHour", { hour: pad(hour) });
  else if (minute !== undefined) time = t("launchd.calendar.atMinuteOfEveryHour", { minute: pad(minute) });
  else time = t("launchd.calendar.everyMinute");

  const dayParts: string[] = [];
  if (day !== undefined) dayParts.push(t("launchd.calendar.onDay", { day }));
  if (weekday !== undefined) dayParts.push(t("launchd.calendar.onWeekday", { weekday: weekdayLabel(weekday, target) }));
  const parts = dayParts.length > 0 ? [dayParts.join(` ${t("launchd.calendar.or")} `)] : [];
  if (month !== undefined) parts.push(t("launchd.calendar.inMonth", { month: monthLabel(month, target) }));

  return [time, ...parts].join(" ");
}

/** `describeCalendarEntry` in the active language. English is byte-identical to the shared function. */
export function localizeCalendarEntry(entry: PlistDict): string {
  const target = getLocale();
  if (target === "en") return describeCalendarEntry(entry);
  const num = (k: string) => (typeof entry[k] === "number" ? (entry[k] as number) : undefined);
  return renderCalendarFields({ hour: num("Hour"), minute: num("Minute"), day: num("Day"), weekday: num("Weekday"), month: num("Month") }, target);
}

/** Reverses `describeCalendarEntry`'s grammar so `localizeTrigger` can translate a "Calendar: …" tag. */
function parseCalendarPhrase(text: string): CalendarFields | null {
  const fields: CalendarFields = {};
  let rest = text;

  let m: RegExpMatchArray | null;
  if ((m = rest.match(/^at (\d{2}):(\d{2})/))) {
    fields.hour = Number(m[1]);
    fields.minute = Number(m[2]);
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^every minute of hour (\d{2})/))) {
    fields.hour = Number(m[1]);
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^at minute (\d{2}) of every hour/))) {
    fields.minute = Number(m[1]);
    rest = rest.slice(m[0].length);
  } else if (rest.startsWith("every minute")) {
    rest = rest.slice("every minute".length);
  } else {
    return null;
  }
  rest = rest.trim();

  if (rest.startsWith("on ")) {
    const both = rest.match(/^on day (\d+) or on (\S+)/);
    if (both) {
      const wd = WEEKDAY_NAMES_EN.indexOf(both[2]);
      if (wd < 0) return null;
      fields.day = Number(both[1]);
      fields.weekday = wd;
      rest = rest.slice(both[0].length).trim();
    } else {
      const dayOnly = rest.match(/^on day (\d+)/);
      if (dayOnly) {
        fields.day = Number(dayOnly[1]);
        rest = rest.slice(dayOnly[0].length).trim();
      } else {
        const wdOnly = rest.match(/^on (\S+)/);
        if (wdOnly) {
          const wd = WEEKDAY_NAMES_EN.indexOf(wdOnly[1]);
          if (wd < 0) return null;
          fields.weekday = wd;
          rest = rest.slice(wdOnly[0].length).trim();
        }
      }
    }
  }

  if (rest.startsWith("in ")) {
    const monthMatch = rest.match(/^in (\S+)/);
    if (monthMatch) {
      const mo = MONTH_NAMES_EN.indexOf(monthMatch[1]);
      if (mo < 0) return null;
      fields.month = mo + 1;
      rest = rest.slice(monthMatch[0].length).trim();
    }
  }

  return rest.length === 0 ? fields : null;
}

// ── Trigger tags ──────────────────────────────────────────────────────

const INTERVAL_UNIT_FALLBACK: Record<string, string> = { s: "s", min: "min", h: "h", d: "d" };

/** `formatInterval`'s output ("5 min", "45 s", "2 h", "2 d") in the active language. */
function localizeIntervalText(text: string): string | null {
  const m = text.match(/^(\d+) (s|min|h|d)$/);
  if (!m) return null;
  const label = tDynamic(`launchd.unit.${m[2]}`, INTERVAL_UNIT_FALLBACK[m[2]]);
  return `${m[1]} ${label}`;
}

/** `formatInterval` in the active language: "5 min" → "5 dk". */
export function localizeInterval(seconds: number): string {
  const text = formatInterval(seconds);
  if (getLocale() === "en") return text;
  return localizeIntervalText(text) ?? text;
}

const CALENDAR_PREFIX = "Calendar: ";

/** Translates one `describeTriggers` tag. Unknown text, and every trigger in English, is returned unchanged. */
export function localizeTrigger(text: string): string {
  const target = getLocale();
  if (target === "en") return text;

  if (text === "At load") return t("launchd.trigger.atLoad");
  if (text === "Keep alive") return t("launchd.trigger.keepAlive");
  if (text === "Keep alive (conditional)") return t("launchd.trigger.keepAliveConditional");
  if (text === "Queue directory") return t("launchd.trigger.queueDirectory");
  if (text === "On mount") return t("launchd.trigger.onMount");
  if (text === "Socket") return t("launchd.trigger.socket");
  if (text === "Mach service") return t("launchd.trigger.machService");
  if (text === "Launch event") return t("launchd.trigger.launchEvent");

  let m = text.match(/^Every (.+)$/);
  if (m) {
    const interval = localizeIntervalText(m[1]);
    return interval === null ? text : t("launchd.trigger.every", { interval });
  }

  if (text.startsWith(CALENDAR_PREFIX)) {
    const fields = parseCalendarPhrase(text.slice(CALENDAR_PREFIX.length));
    return fields === null ? text : t("launchd.trigger.calendar", { entry: renderCalendarFields(fields, target) });
  }

  m = text.match(/^Calendar ×(\d+)$/);
  if (m) return t("launchd.trigger.calendarCount", { count: Number(m[1]) });

  m = text.match(/^Watches (\d+) paths?$/);
  if (m) return tn("launchd.trigger.watchesPath", Number(m[1]));

  return text;
}

export function localizeTriggers(triggers: readonly string[]): string[] {
  return triggers.map(localizeTrigger);
}

// ── Validation issues ────────────────────────────────────────────────

/** Translates a validation issue by its `code`. Issues without a code (older backends) keep their English message. */
export function localizeIssue(issue: JobIssue): string {
  if (getLocale() === "en" || !issue.code) return issue.message;
  const params = { ...issue.params };
  // Reuse the per-key help translation instead of embedding the shared (English) help text verbatim.
  if (issue.code === "key_deprecated" && typeof params.key === "string") {
    const spec = KEY_SPEC.get(params.key);
    if (spec) params.help = keyHelp(spec);
  }
  return tDynamic(`launchd.issue.${issue.code}`, issue.message, params);
}

// ── Exit status ───────────────────────────────────────────────────────

/** `explainExitStatus` in the active language. */
export function localizeExitStatus(status: number | null): string | null {
  if (status === null) return null;
  if (getLocale() === "en") return explainExitStatus(status);

  if (status < 0) {
    const sig = -status;
    const name = SIGNALS[sig];
    return name
      ? tDynamic("launchd.exit.signalNamed", `Terminated by signal ${sig} (${name})`, { number: sig, name })
      : tDynamic("launchd.exit.signal", `Terminated by signal ${sig}`, { number: sig });
  }
  if (status > 128 && SIGNALS[status - 128]) {
    const sig = status - 128;
    const name = SIGNALS[sig];
    return tDynamic("launchd.exit.signalNamed", `Terminated by signal ${sig} (${name})`, { number: sig, name });
  }
  const known = EXIT_CODES[status];
  if (known !== undefined) return tDynamic(`launchd.exit.${status}`, known);
  return tDynamic("launchd.exit.unknown", `Exited with code ${status}`, { code: status });
}

// ── Key schema, scopes and templates ────────────────────────────────

export function keyTitle(spec: { key: string; title: string }): string {
  return tDynamic(`launchd.key.${spec.key}.title`, spec.title);
}

export function keyHelp(spec: { key: string; help: string }): string {
  return tDynamic(`launchd.key.${spec.key}.help`, spec.help);
}

/** Help text of a `KEEPALIVE_CONDITIONS` entry. */
export function keepAliveHelp(condition: { key: string; help: string }): string {
  return tDynamic(`launchd.keepalive.${condition.key}.help`, condition.help);
}

/** Help text of a `CALENDAR_FIELDS` entry. */
export function calendarFieldHelp(field: { key: string; help: string }): string {
  return tDynamic(`launchd.calendar.${field.key}.help`, field.help);
}

export function scopeTitle(category: string): string {
  return tDynamic(`launchd.scope.${category}.title`, scopeFor(category)?.title ?? category);
}

export function scopeDescription(category: string): string {
  return tDynamic(`launchd.scope.${category}.description`, scopeFor(category)?.description ?? "");
}

export function templateTitle(template: { id: string; title: string }): string {
  return tDynamic(`launchd.template.${template.id}.title`, template.title);
}

export function templateDescription(template: { id: string; description: string }): string {
  return tDynamic(`launchd.template.${template.id}.description`, template.description);
}
