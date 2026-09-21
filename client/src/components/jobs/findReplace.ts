import { escapeXml } from "@shared/plist";

// Literal find and replace for the Expert-mode editor. No DOM: everything here is unit-tested.

export interface TextMatch {
  start: number;
  end: number;
}

/** Layout constants of the editor layers (XmlEditor.tsx): `leading-5` and `p-3`. */
export const LINE_HEIGHT = 20;
export const EDITOR_PADDING = 12;

/** A one-letter query in a 200 KB plist could give 100 000 matches. */
export const MAX_MATCHES = 5000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Non-overlapping literal matches, in document order.
 * A regular expression with the `i` flag folds case without moving indexes (toLowerCase() can change the length).
 */
export function findMatches(text: string, query: string, caseSensitive: boolean, limit = MAX_MATCHES): TextMatch[] {
  if (query === "") return [];
  const re = new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi");
  const matches: TextMatch[] = [];
  for (let m = re.exec(text); m !== null && matches.length < limit; m = re.exec(text)) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

/** Index of the first match that starts at or after `offset`. Wraps to the first match. -1 when there is none. */
export function matchIndexFrom(matches: TextMatch[], offset: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.start >= offset);
  return i === -1 ? 0 : i;
}

/** Next or previous match index, with wrap-around. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** Replace one match. `caret` is the offset right after the inserted text. The replacement is literal ("$1" stays "$1"). */
export function replaceMatch(text: string, match: TextMatch, replacement: string): { text: string; caret: number } {
  return {
    text: text.slice(0, match.start) + replacement + text.slice(match.end),
    caret: match.start + replacement.length,
  };
}

export function replaceAllMatches(
  text: string,
  query: string,
  replacement: string,
  caseSensitive: boolean
): { text: string; count: number } {
  // No limit here: "Replace all" must not stop at the display limit.
  const matches = findMatches(text, query, caseSensitive, Infinity);
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacement;
    last = m.end;
  }
  return { text: out + text.slice(last), count: matches.length };
}

/** Zero-based line of a character offset. */
export function lineOfIndex(text: string, index: number): number {
  let line = 0;
  const end = Math.min(index, text.length);
  for (let i = text.indexOf("\n"); i !== -1 && i < end; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * scrollTop that shows `line`. Returns the current value when the line is already fully visible,
 * otherwise centres the line.
 */
export function scrollTopForLine(line: number, scrollTop: number, clientHeight: number): number {
  const top = EDITOR_PADDING + line * LINE_HEIGHT;
  if (top >= scrollTop && top + LINE_HEIGHT <= scrollTop + clientHeight) return scrollTop;
  return Math.max(0, Math.round(top - (clientHeight - LINE_HEIGHT) / 2));
}

export const MATCH_STYLE = "color:transparent;background:rgba(250,204,21,0.28);border-radius:2px";
export const CURRENT_MATCH_STYLE = "color:transparent;background:rgba(34,211,238,0.5);border-radius:2px;outline:1px solid rgba(34,211,238,0.9)";

/**
 * HTML of the match layer: the same text as the editor with a <mark> around every match.
 * XSS-safe by construction: every piece of the text goes through escapeXml() first,
 * and the only markup added afterwards is the constant <mark> tag.
 */
export function matchLayerHtml(text: string, matches: TextMatch[], current: number): string {
  let html = "";
  let last = 0;
  matches.forEach((m, i) => {
    html += escapeXml(text.slice(last, m.start));
    html += `<mark${i === current ? " data-current" : ""} style="${i === current ? CURRENT_MATCH_STYLE : MATCH_STYLE}">`;
    html += escapeXml(text.slice(m.start, m.end));
    html += "</mark>";
    last = m.end;
  });
  return html + escapeXml(text.slice(last));
}
