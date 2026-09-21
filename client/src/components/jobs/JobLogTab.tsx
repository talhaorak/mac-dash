import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { backend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { intlLocale, t, tn, useT, type TKey } from "@/i18n";

// "Log" tab of the job details: the unified system log (`log show`), narrowed to one job.
// The first half of this file is pure and unit-tested (helpers.test.ts).

export const LOG_SPANS = [
  { minutes: 5, labelKey: "detail.log.span5m", noLinesKey: "detail.log.noLines5m" },
  { minutes: 60, labelKey: "detail.log.span1h", noLinesKey: "detail.log.noLines1h" },
  { minutes: 360, labelKey: "detail.log.span6h", noLinesKey: "detail.log.noLines6h" },
  { minutes: 1440, labelKey: "detail.log.span24h", noLinesKey: "detail.log.noLines24h" },
] as const satisfies { minutes: number; labelKey: TKey; noLinesKey: TKey }[];

export const LOG_ROW_LIMIT = 500;
/** Both backends refuse a longer predicate (docs/backend-contract.md). */
export const LOG_PREDICATE_MAX = 500;

export const LOG_LEVELS = ["error", "warning", "info", "debug", "default"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_KEYS: Record<LogLevel, TKey> = {
  error: "common.error",
  warning: "common.warning",
  info: "common.info",
  debug: "detail.log.levelDebug",
  default: "detail.log.levelDefault",
};

/** Display text of a log level, in the active language. Called at use time (module-scope text is never cached). */
export function logLevelLabel(level: LogLevel): string {
  return t(LOG_LEVEL_KEYS[level]);
}

export interface LogRow {
  timestamp: string;
  level: LogLevel;
  process: string;
  pid: number | null;
  message: string;
  subsystem: string | null;
}

/** A string literal of the predicate language: backslash and double quote are escaped. */
export function predicateLiteral(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Lines of the job's process, lines of a subsystem named like the label, and lines that mention the label
 * (launchd writes those). A job without a program has no process clause.
 * Clauses are dropped from the end when the predicate is over the length limit.
 */
export function buildLogPredicate(label: string, program: string | null | undefined): string {
  const processName = (program ?? "").split("/").filter(Boolean).pop() ?? "";
  const clauses = [
    ...(processName ? [`process == ${predicateLiteral(processName)}`] : []),
    `subsystem == ${predicateLiteral(label)}`,
    `eventMessage CONTAINS ${predicateLiteral(label)}`,
  ];
  while (clauses.length > 1 && clauses.join(" OR ").length > LOG_PREDICATE_MAX) clauses.pop();
  return clauses.join(" OR ");
}

/** The HTTP backend returns `{ logs, truncated }`, the desktop backend returns the list. Wrong shapes give no rows. */
export function normalizeLogResult(raw: unknown): { rows: LogRow[]; truncated: boolean } {
  const holder = raw as { logs?: unknown; truncated?: unknown } | null;
  const list: unknown[] = Array.isArray(raw) ? raw : holder && typeof holder === "object" && Array.isArray(holder.logs) ? holder.logs : [];
  const rows = list
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      timestamp: typeof e.timestamp === "string" ? e.timestamp : "",
      level: (LOG_LEVELS as readonly string[]).includes(e.level as string) ? (e.level as LogLevel) : "default",
      process: typeof e.process === "string" ? e.process : "",
      pid: typeof e.pid === "number" ? e.pid : null,
      message: typeof e.message === "string" ? e.message : "",
      subsystem: typeof e.subsystem === "string" && e.subsystem !== "" ? e.subsystem : null,
    }));
  return { rows, truncated: !Array.isArray(raw) && holder?.truncated === true };
}

/**
 * Filter, order and cap. The cap keeps the NEWEST rows in both orders.
 * `log show` prints one timestamp format, so the text order is the time order. The sort is stable.
 */
export function selectLogRows(rows: LogRow[], options: { text: string; level: LogLevel | "all"; newestFirst: boolean; limit?: number }): LogRow[] {
  const q = options.text.trim().toLowerCase();
  const matching = rows.filter(
    (r) =>
      (options.level === "all" || r.level === options.level) &&
      (q === "" || r.message.toLowerCase().includes(q) || r.process.toLowerCase().includes(q) || (r.subsystem ?? "").toLowerCase().includes(q))
  );
  const newest = [...matching].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0)).slice(0, options.limit ?? LOG_ROW_LIMIT);
  return options.newestFirst ? newest : newest.reverse();
}

export function logRowsAsText(rows: LogRow[]): string {
  return rows
    .map((r) => `${r.timestamp} ${logLevelLabel(r.level).toLocaleUpperCase(intlLocale())} ${r.process}${r.pid !== null ? `[${r.pid}]` : ""}: ${r.message}`)
    .join("\n");
}

// ── Component ────────────────────────────────────────────────────────

const LEVEL_TEXT: Record<LogLevel, string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-cyan-400",
  debug: "text-gray-500",
  default: "text-gray-400",
};

const LEVEL_BORDER: Record<LogLevel, string> = {
  error: "border-l-red-500/60",
  warning: "border-l-amber-500/60",
  info: "border-l-cyan-500/40",
  debug: "border-l-gray-600/40",
  default: "border-l-white/10",
};

const control =
  "px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-gray-200 placeholder-gray-600 " +
  "focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20";

export function JobLogTab({ label, program }: { label: string; program: string | null }) {
  useT(); // subscribe: re-render when the language changes
  const [minutes, setMinutes] = useState<number>(LOG_SPANS[0].minutes);
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [text, setText] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [result, setResult] = useState<{ rows: LogRow[]; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const hintId = useId();

  const predicate = useMemo(() => buildLogPredicate(label, program), [label, program]);

  const load = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const next = normalizeLogResult(await backend.queryLogs(minutes, predicate));
      if (token !== request.current) return;
      setResult(next);
    } catch (e) {
      if (token !== request.current) return;
      setError((e as Error).message || t("detail.log.readError"));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [minutes, predicate]);

  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [load]);

  const rows = useMemo(() => selectLogRows(result?.rows ?? [], { text, level, newestFirst }), [result, text, level, newestFirst]);
  const total = result?.rows.length ?? 0;
  const span = LOG_SPANS.find((s) => s.minutes === minutes)!;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label={t("detail.log.timeSpanAria")} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={control}>
          {LOG_SPANS.map((s) => (
            <option key={s.minutes} value={s.minutes}>
              {t(s.labelKey)}
            </option>
          ))}
        </select>
        <select aria-label={t("detail.log.levelAria")} value={level} onChange={(e) => setLevel(e.target.value as LogLevel | "all")} className={control}>
          <option value="all">{t("detail.log.allLevels")}</option>
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {logLevelLabel(l)}
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label={t("detail.log.filterAria")}
          placeholder={t("detail.log.filterPlaceholder")}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={cn(control, "flex-1 min-w-[7rem]")}
        />
        <label className="flex items-center gap-1.5 text-xs text-gray-400 whitespace-nowrap">
          <input
            type="checkbox"
            checked={newestFirst}
            onChange={(e) => setNewestFirst(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
          />
          {t("detail.log.newestFirst")}
        </label>
        <button
          type="button"
          aria-label={t("detail.log.refreshAria")}
          disabled={loading}
          onClick={load}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden />}
        </button>
      </div>

      <p id={hintId} className="text-[11px] leading-snug text-gray-600">
        {t("detail.log.hint")}
      </p>

      <details className="text-[11px] text-gray-600">
        <summary className="cursor-pointer rounded hover:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50">
          {t("detail.log.queryLabel")}
        </summary>
        <p className="mt-1 flex items-start gap-1 rounded-lg bg-black/20 px-2 py-1.5 font-mono text-gray-400 break-all selectable">
          <span className="flex-1">{predicate}</span>
          <CopyButton text={`log show --last ${minutes}m --predicate '${predicate.replace(/'/g, "'\\''")}'`} />
        </p>
      </details>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 space-y-2">
          <p className="text-xs text-red-300 break-words">{error}</p>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06]"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden />
            {t("common.retry")}
          </button>
        </div>
      ) : result === null ? (
        <p className="flex items-center gap-2 text-sm text-gray-500" role="status">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          {t("detail.log.reading")} {minutes > 60 ? t("detail.log.longSpanWarning") : ""}
        </p>
      ) : (
        <>
          <p role="status" className="flex items-center gap-2 text-[11px] text-gray-500">
            <span>
              {total === 0 ? t(span.noLinesKey) : rows.length === total ? tn("detail.log.lineCount", total) : t("detail.log.linesOfTotal", { shown: rows.length, total })}
              {result.truncated ? ` ${t("detail.log.truncatedSuffix")}` : ""}
              {total >= LOG_ROW_LIMIT ? ` ${t("detail.log.limitSuffix", { limit: LOG_ROW_LIMIT })}` : ""}
            </span>
            {rows.length > 0 && (
              <span className="ml-auto">
                <CopyButton text={logRowsAsText(rows)} />
              </span>
            )}
          </p>
          {total === 0 ? (
            <p className="text-sm text-gray-500">{t("detail.log.emptyDetail")}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-500">{t("detail.log.noMatch")}</p>
          ) : (
            <ol
              aria-label={t("detail.log.rowsAria")}
              aria-describedby={hintId}
              aria-busy={loading}
              tabIndex={0}
              className={cn(
                "selectable max-h-[52vh] overflow-auto rounded-xl bg-black/40 p-2 space-y-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40",
                loading && "opacity-60"
              )}
            >
              {rows.map((row, i) => (
                <li key={`${row.timestamp}-${i}`} className={cn("border-l-2 pl-2", LEVEL_BORDER[row.level])}>
                  <p className="flex flex-wrap gap-x-2 text-[10px] font-mono text-gray-500">
                    <time>{row.timestamp}</time>
                    <span className={cn("font-semibold uppercase", LEVEL_TEXT[row.level])}>{logLevelLabel(row.level)}</span>
                    <span className="text-gray-400">
                      {row.process}
                      {row.pid !== null ? `[${row.pid}]` : ""}
                    </span>
                    {row.subsystem && <span className="truncate">{row.subsystem}</span>}
                  </p>
                  <p className="text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-words">{row.message}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
