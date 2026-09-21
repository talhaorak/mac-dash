/**
 * Dependency-free localisation layer.
 *
 * - `en.ts` is the source of truth. `tr.ts` is typed against it, so a missing key is a compile error.
 * - `t(key, params)` interpolates `{name}` placeholders. `tn(key, count, params)` picks `key.one` / `key.other`
 *   with `Intl.PluralRules` and provides `{count}` (formatted for the locale).
 * - `useT()` re-renders the component when the language changes. Code outside React imports `t` directly.
 * - Technical tokens (launchd key names, commands, paths, signal names, the app name) are not in the dictionaries.
 */

import { useSyncExternalStore } from "react";
import { en } from "./en";
import { tr } from "./tr";

export type Locale = "en" | "tr";
export type LanguageChoice = "system" | Locale;
export type TKey = keyof typeof en;
export type TParams = Record<string, string | number>;
/** Base of a plural pair: "services.count" for the keys "services.count.one" and "services.count.other". */
export type TPluralKey = { [K in TKey]: K extends `${infer Base}.other` ? Base : never }[TKey];

export const LANGUAGE_KEY = "macdash.language";

const DICTIONARIES: Record<Locale, Record<TKey, string>> = { en, tr };

/** Languages of the switch, with their own names (never translated). */
export const LANGUAGES: { id: Locale; name: string }[] = [
  { id: "en", name: "English" },
  { id: "tr", name: "Türkçe" },
];

const isLocale = (value: unknown): value is Locale => typeof value === "string" && Object.hasOwn(DICTIONARIES, value);

// ── Active language ──────────────────────────────────────────────────

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return typeof navigator.language === "string" ? [navigator.language] : [];
}

function systemLocale(): Locale {
  const first = systemLanguages()[0]?.toLowerCase() ?? "";
  return first.startsWith("tr") ? "tr" : "en";
}

function readChoice(): LanguageChoice {
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_KEY);
    return isLocale(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

let choice: LanguageChoice = readChoice();
let locale: Locale = choice === "system" ? systemLocale() : choice;
const listeners = new Set<() => void>();

function applyLocale(next: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === locale) return;
  locale = next;
  formatters.clear();
  for (const listener of [...listeners]) listener();
}

export function getLocale(): Locale {
  return locale;
}

export function getLanguageChoice(): LanguageChoice {
  return choice;
}

/** "system" follows the browser or macOS language. The choice is remembered in localStorage. */
export function setLocale(next: LanguageChoice): void {
  choice = next === "system" || isLocale(next) ? next : "system";
  try {
    globalThis.localStorage?.setItem(LANGUAGE_KEY, choice);
  } catch {
    // Private mode: the choice lasts for this page.
  }
  applyLocale(choice === "system" ? systemLocale() : choice);
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof document !== "undefined") document.documentElement.lang = locale;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("languagechange", () => {
    if (choice === "system") applyLocale(systemLocale());
  });
}

// ── Translation ──────────────────────────────────────────────────────

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

function lookup(target: Locale, key: string): string | undefined {
  return (DICTIONARIES[target] as Record<string, string>)[key] ?? (en as Record<string, string>)[key];
}

function translate(target: Locale, key: TKey, params?: TParams): string {
  return interpolate(lookup(target, key) ?? key, params);
}

function translatePlural(target: Locale, key: TPluralKey, count: number, params?: TParams): string {
  const category = pluralRules(target).select(count);
  const template = lookup(target, `${key}.${category}`) ?? lookup(target, `${key}.other`) ?? key;
  return interpolate(template, { count: formatNumberFor(target, count), ...params });
}

/** A dictionary key that is only known at run time (e.g. `launchd.key.${name}.title`). Returns `fallback` when it is missing. */
function translateDynamic(target: Locale, key: string, fallback: string, params?: TParams): string {
  const template = lookup(target, key);
  return template === undefined ? fallback : interpolate(template, params);
}

export function t(key: TKey, params?: TParams): string {
  return translate(locale, key, params);
}

export function tn(key: TPluralKey, count: number, params?: TParams): string {
  return translatePlural(locale, key, count, params);
}

export function tDynamic(key: string, fallback: string, params?: TParams): string {
  return translateDynamic(locale, key, fallback, params);
}

export function hasKey(key: string): key is TKey {
  return Object.hasOwn(en, key);
}

export interface Translator {
  locale: Locale;
  t: (key: TKey, params?: TParams) => string;
  tn: (key: TPluralKey, count: number, params?: TParams) => string;
}

/** One translator per locale, so `t` changes identity with the language and works as a hook dependency. */
const translators = new Map<Locale, Translator>();

export function translatorFor(target: Locale): Translator {
  let translator = translators.get(target);
  if (!translator) {
    translator = {
      locale: target,
      t: (key, params) => translate(target, key, params),
      tn: (key, count, params) => translatePlural(target, key, count, params),
    };
    translators.set(target, translator);
  }
  return translator;
}

/** `const { t, tn, locale } = useT();` The component re-renders when the language changes. */
export function useT(): Translator {
  return translatorFor(useSyncExternalStore(subscribeLocale, getLocale, getLocale));
}

export function useLanguageChoice(): LanguageChoice {
  return useSyncExternalStore(subscribeLocale, getLanguageChoice, getLanguageChoice);
}

// ── Dates and numbers ────────────────────────────────────────────────

/**
 * BCP 47 tag for `Intl`. The regional variant of the system wins when it has the same language
 * ("en-GB" keeps its date order), otherwise the plain language is used.
 */
export function intlLocale(target: Locale = locale): string {
  const regional = systemLanguages().find((tag) => tag.toLowerCase().startsWith(target));
  return regional ?? target;
}

const formatters = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.PluralRules>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.PluralRules>(id: string, create: () => T): T {
  let formatter = formatters.get(id) as T | undefined;
  if (!formatter) {
    formatter = create();
    formatters.set(id, formatter);
  }
  return formatter;
}

function pluralRules(target: Locale): Intl.PluralRules {
  return cached(`plural:${target}`, () => new Intl.PluralRules(target));
}

function formatNumberFor(target: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  const id = `number:${target}:${options ? JSON.stringify(options) : ""}`;
  return cached(id, () => new Intl.NumberFormat(intlLocale(target), options)).format(value);
}

function formatDateFor(kind: string, value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const id = `${kind}:${locale}:${options ? JSON.stringify(options) : ""}`;
  return cached(id, () => new Intl.DateTimeFormat(intlLocale(), options)).format(date);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberFor(locale, value, options);
}

/** Replacement for `date.toLocaleString()`. */
export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return formatDateFor("datetime", value, options ?? { dateStyle: "short", timeStyle: "medium" });
}

/** Replacement for `date.toLocaleDateString()`. */
export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return formatDateFor("date", value, options ?? { dateStyle: "short" });
}

/** Replacement for `date.toLocaleTimeString()`. */
export function formatTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return formatDateFor("time", value, options ?? { timeStyle: "medium" });
}

/** "12s ago", "5m ago", "3h ago", "2d ago" in the active language. */
export function formatAgo(value: Date | number | string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return t("time.secondsAgo", { count: seconds });
  if (seconds < 3600) return t("time.minutesAgo", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("time.hoursAgo", { count: Math.floor(seconds / 3600) });
  return t("time.daysAgo", { count: Math.floor(seconds / 86400) });
}
