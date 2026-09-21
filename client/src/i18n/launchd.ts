/**
 * Display-time localisation of the English text that `shared/launchd.ts` produces.
 *
 * The shared functions stay English: the server and the Rust backend compare their output (`describeTriggers`
 * is part of the backend contract). The client translates here and falls back to the English input.
 */

import type { PlistDict } from "@shared/plist";
import { describeCalendarEntry, explainExitStatus, formatInterval, scopeFor, type JobIssue } from "@shared/launchd";
import { tDynamic } from "./index";

/** "Every 5 min" → "5 dk'da bir". Unknown text is returned unchanged. */
export function localizeTrigger(text: string): string {
  return text;
}

export function localizeTriggers(triggers: readonly string[]): string[] {
  return triggers.map(localizeTrigger);
}

/** `formatInterval` in the active language: "5 min" → "5 dk". */
export function localizeInterval(seconds: number): string {
  return formatInterval(seconds);
}

/** `describeCalendarEntry` in the active language. */
export function localizeCalendarEntry(entry: PlistDict): string {
  return describeCalendarEntry(entry);
}

/** Translates a validation issue by its `code`. Issues without a code (older backends) keep their English message. */
export function localizeIssue(issue: JobIssue): string {
  return issue.message;
}

/** `explainExitStatus` in the active language. */
export function localizeExitStatus(status: number | null): string | null {
  return explainExitStatus(status);
}

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
