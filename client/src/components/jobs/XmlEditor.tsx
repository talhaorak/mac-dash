import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { escapeXml } from "@shared/plist";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { XML_COLOR_FALLBACKS, appearanceFrom, themeVariables, type Appearance, type EditorThemeId } from "./editorThemes";
import {
  MAX_MATCHES,
  findMatches,
  lineOfIndex,
  matchIndexFrom,
  matchLayerHtml,
  replaceAllMatches,
  replaceMatch,
  scrollTopForLine,
  stepMatch,
} from "./findReplace";

// Expert mode: a textarea with two mirrors behind it. The bottom mirror paints the find matches,
// the middle one the syntax colours. All three layers share font metrics and scroll position.
// The textarea text is transparent.

const LAYER = "absolute inset-0 m-0 p-3 font-mono text-xs leading-5 whitespace-pre overflow-auto [tab-size:2]";

const barInput =
  "w-44 px-2 py-1 rounded-md bg-black/40 border border-white/[0.1] text-xs text-gray-200 placeholder-gray-600 font-mono " +
  "focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20";
const barButton =
  "inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-md text-xs text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-40 disabled:hover:bg-transparent";

// Both mirrors are filled with dangerouslySetInnerHTML. The rule for both: escape the whole text first,
// then add constant markup only. No part of the document reaches the HTML parser unescaped.
// Colours are CSS variables (editorThemes.ts). The container sets them, so a theme change needs no new HTML.
const C = XML_COLOR_FALLBACKS;
function highlight(xml: string): string {
  return escapeXml(xml)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, `<span style="color:${C.comment}">$1</span>`)
    .replace(/(&lt;key&gt;)([^&]*)(&lt;\/key&gt;)/g, `$1<span style="color:${C.key}">$2</span>$3`)
    .replace(/(&lt;(?:string|integer|real|date|data)&gt;)([^<]*?)(&lt;\/)/g, `$1<span style="color:${C.value}">$2</span>$3`)
    .replace(/(&lt;\/?(?:[A-Za-z?]|!DOCTYPE)[^&]*?&gt;)/g, `<span style="color:${C.tag}">$1</span>`);
}

function readAppearance(): Appearance {
  if (typeof document === "undefined") return "dark";
  const root = document.documentElement;
  let colorScheme: string | null = null;
  try {
    colorScheme = getComputedStyle(root).colorScheme;
  } catch {
    colorScheme = null;
  }
  return appearanceFrom({ dataTheme: root.getAttribute("data-theme"), classNames: [...root.classList], colorScheme });
}

/** Follows the theme of the app: the root element announces it through an attribute, a class or `color-scheme`. */
function useAppAppearance(): Appearance {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setAppearance(readAppearance()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    setAppearance(readAppearance());
    return () => observer.disconnect();
  }, []);
  return appearance;
}

export function XmlEditor({
  value,
  onChange,
  readOnly,
  theme,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  /** Syntax colour theme. The default theme is used when it is missing. */
  theme?: EditorThemeId;
}) {
  const appearance = useAppAppearance();
  const themeStyle = useMemo(() => themeVariables(theme, appearance) as CSSProperties, [theme, appearance]);
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const matchLayer = useRef<HTMLPreElement>(null);
  const findInput = useRef<HTMLInputElement>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [status, setStatus] = useState<string | null>(null);
  /** After a replace: continue with the first match behind the inserted text. */
  const resumeAt = useRef<number | null>(null);
  /** Bumped when a match is selected on purpose, so the same index scrolls again. */
  const [revealTick, setRevealTick] = useState(0);

  const html = useMemo(() => highlight(value) + "\n", [value]);
  const matches = useMemo(() => (findOpen ? findMatches(value, query, caseSensitive) : []), [findOpen, value, query, caseSensitive]);
  const matchHtml = useMemo(() => (matches.length > 0 ? matchLayerHtml(value, matches, current) + "\n" : ""), [value, matches, current]);

  const syncScroll = () => {
    const el = area.current;
    if (!el) return;
    for (const layer of [mirror.current, matchLayer.current]) {
      if (!layer) continue;
      layer.scrollTop = el.scrollTop;
      layer.scrollLeft = el.scrollLeft;
    }
  };

  // The match list changes with the text, the query and the case toggle. Pick the current match:
  // the first one behind a replacement, else the first one at or after the caret.
  // A layout effect, so the corrected index is on screen in the same frame as the new list.
  useLayoutEffect(() => {
    const afterReplace = resumeAt.current !== null;
    const from = resumeAt.current ?? area.current?.selectionStart ?? 0;
    resumeAt.current = null;
    setCurrent(matchIndexFrom(matches, from));
    // Typing in the document also refreshes the list. That must not move the caret or the view.
    if (afterReplace || document.activeElement !== area.current) setRevealTick((t) => t + 1);
  }, [matches]);

  // New content can clamp or reset the scroll position of a mirror.
  useLayoutEffect(syncScroll, [html, matchHtml]);

  // Reveal the current match: select it in the textarea (focus stays where it is) and scroll it into view.
  useLayoutEffect(() => {
    const el = area.current;
    const match = matches[current];
    if (revealTick === 0 || !el || !match) return;
    el.setSelectionRange(match.start, match.end);
    // Vertical: line index × line height. The layers use a fixed 20 px line.
    el.scrollTop = scrollTopForLine(lineOfIndex(value, match.start), el.scrollTop, el.clientHeight);
    // Horizontal: the <mark> in the match layer has the exact pixel offset, tabs included.
    const mark = matchLayer.current?.querySelector<HTMLElement>("mark[data-current]");
    if (mark) {
      const left = mark.offsetLeft;
      const right = left + mark.offsetWidth;
      if (left < el.scrollLeft + 12 || right > el.scrollLeft + el.clientWidth - 12) el.scrollLeft = Math.max(0, left - 48);
    }
    syncScroll();
    // Runs once per request. `matches`, `current` and `value` are read as they are in that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  const openFind = () => {
    const el = area.current;
    if (el && el.selectionEnd > el.selectionStart) {
      const selected = value.slice(el.selectionStart, el.selectionEnd);
      if (!selected.includes("\n") && selected.length <= 200) setQuery(selected);
    }
    setFindOpen(true);
    setStatus(null);
    // The input is mounted after this render.
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };

  const closeFind = () => {
    setFindOpen(false);
    setStatus(null);
    const el = area.current;
    if (!el) return;
    const match = matches[current];
    el.focus({ preventScroll: true });
    if (match) el.setSelectionRange(match.start, match.end);
  };

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    setCurrent((c) => stepMatch(c, matches.length, direction));
    setRevealTick((t) => t + 1);
    setStatus(null);
  };

  /**
   * Insert through the browser's editing command, so Cmd+Z in the textarea undoes a replace.
   * Falls back to a plain state update when the command is not available.
   */
  const applyEdit = (start: number, end: number, text: string, next: string) => {
    const el = area.current;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let done = false;
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(start, end);
      try {
        const ran = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
        done = ran && el.value === next;
      } catch {
        done = false;
      }
      back?.focus({ preventScroll: true });
    }
    if (!done) onChange(next);
  };

  const replaceCurrent = () => {
    const match = matches[current];
    if (readOnly || !match) return;
    const result = replaceMatch(value, match, replacement);
    resumeAt.current = result.caret;
    applyEdit(match.start, match.end, replacement, result.text);
    setStatus(null);
  };

  const replaceEverything = () => {
    if (readOnly || query === "") return;
    const result = replaceAllMatches(value, query, replacement, caseSensitive);
    if (result.count === 0) return;
    applyEdit(0, value.length, result.text, result.text);
    setStatus(t("fields.xmlEditor.replacedCount", { count: result.count }));
  };

  const onBarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Consume Escape so the enclosing Dialog stays open.
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  };

  const onContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "f") {
      e.preventDefault();
      openFind();
    } else if (key === "g" && findOpen) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const countText =
    query === ""
      ? ""
      : matches.length === 0
        ? t("fields.xmlEditor.noResults")
        : t("fields.xmlEditor.matchCount", {
            current: current + 1,
            total: matches.length >= MAX_MATCHES ? `${matches.length}+` : matches.length,
          });

  return (
    <div
      data-editor-theme={theme ?? "default"}
      data-appearance={appearance}
      style={{ ...themeStyle, background: C.background }}
      className="relative h-full min-h-[320px] rounded-xl border border-white/[0.08] overflow-hidden"
      onKeyDown={onContainerKeyDown}
    >
      <pre ref={matchLayer} aria-hidden className={`${LAYER} text-transparent pointer-events-none`} dangerouslySetInnerHTML={{ __html: matchHtml }} />
      <pre ref={mirror} aria-hidden style={{ color: C.text }} className={`${LAYER} pointer-events-none`} dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
        ref={area}
        aria-label={t("fields.xmlEditor.textareaLabel")}
        aria-keyshortcuts="Meta+F Control+F"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || readOnly) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: start, selectionEnd: end } = el;
          onChange(value.slice(0, start) + "\t" + value.slice(end));
          requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
        }}
        style={{ caretColor: C.caret }}
        className={`${LAYER} w-full h-full resize-none bg-transparent text-transparent selection:bg-cyan-500/30 focus:outline-none`}
      />

      {findOpen && (
        <div
          role="search"
          aria-label={t("fields.xmlEditor.findReplaceLabel")}
          onKeyDown={onBarKeyDown}
          className="absolute top-2 right-4 z-10 space-y-1.5 rounded-lg border border-white/[0.1] bg-gray-900/95 p-2 shadow-xl backdrop-blur"
        >
          <div className="flex items-center gap-1">
            <input
              ref={findInput}
              type="text"
              aria-label={t("fields.xmlEditor.find")}
              placeholder={t("fields.xmlEditor.find")}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setStatus(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }}
              className={barInput}
            />
            <span aria-live="polite" className={cn("w-20 px-1 text-[11px] tabular-nums", query && matches.length === 0 ? "text-red-400" : "text-gray-500")}>
              {countText}
            </span>
            <button
              type="button"
              aria-label={t("fields.xmlEditor.matchCase")}
              aria-pressed={caseSensitive}
              title={t("fields.xmlEditor.matchCase")}
              onClick={() => setCaseSensitive((v) => !v)}
              className={cn(barButton, caseSensitive && "bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/25 hover:text-cyan-200")}
            >
              <CaseSensitive className="w-4 h-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t("fields.xmlEditor.previousMatch")}
              title={t("fields.xmlEditor.actionShortcut", { action: t("fields.xmlEditor.previousMatch"), shortcut: "Shift+Enter" })}
              disabled={matches.length === 0}
              onClick={() => step(-1)}
              className={barButton}
            >
              <ChevronUp className="w-4 h-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t("fields.xmlEditor.nextMatch")}
              title={t("fields.xmlEditor.actionShortcut", { action: t("fields.xmlEditor.nextMatch"), shortcut: "Enter" })}
              disabled={matches.length === 0}
              onClick={() => step(1)}
              className={barButton}
            >
              <ChevronDown className="w-4 h-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t("fields.xmlEditor.closeFindReplace")}
              title={t("fields.xmlEditor.actionShortcut", { action: t("common.close"), shortcut: "Escape" })}
              onClick={closeFind}
              className={barButton}
            >
              <X className="w-4 h-4" aria-hidden />
            </button>
          </div>

          {!readOnly && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                aria-label={t("fields.xmlEditor.replaceWith")}
                placeholder={t("fields.xmlEditor.replaceWith")}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  replaceCurrent();
                }}
                className={barInput}
              />
              <button type="button" disabled={current < 0} onClick={replaceCurrent} className={barButton}>
                {t("fields.xmlEditor.replace")}
              </button>
              <button type="button" disabled={matches.length === 0} onClick={replaceEverything} className={barButton}>
                {t("fields.xmlEditor.replaceAll")}
              </button>
              <span role="status" className="px-1 text-[11px] text-gray-500">
                {status}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
