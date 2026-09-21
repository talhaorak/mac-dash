/**
 * Dependency-free XML property list parser and serializer.
 * Shared by the Bun server and the React client (no DOM APIs used).
 *
 * Binary plists are converted to XML by the backend before they reach this code.
 */

export class PlistReal {
  constructor(public value: number) {}
}

export class PlistData {
  constructor(public base64: string) {}
}

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | PlistReal
  | PlistData
  | PlistValue[]
  | PlistDict;

export interface PlistDict {
  [key: string]: PlistValue;
}

export class PlistParseError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "PlistParseError";
  }
}

export function isPlistDict(v: unknown): v is PlistDict {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof PlistReal) &&
    !(v instanceof PlistData)
  );
}

// ── Entities ─────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Tokenizer ────────────────────────────────────────────────────────

type Token =
  | { kind: "open"; name: string; pos: number }
  | { kind: "close"; name: string; pos: number }
  | { kind: "empty"; name: string; pos: number }
  | { kind: "text"; text: string; pos: number };

function tokenize(xml: string, fail: (msg: string, pos: number) => never): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", text: xml.slice(i), pos: i });
      break;
    }
    if (lt > i) tokens.push({ kind: "text", text: xml.slice(i, lt), pos: i });

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) fail("Unterminated comment", lt);
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) fail("Unterminated CDATA section", lt);
      // Re-escape so the value handler can decode uniformly
      tokens.push({ kind: "text", text: escapeXml(xml.slice(lt + 9, end)), pos: lt });
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) fail("Unterminated processing instruction", lt);
      i = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      // DOCTYPE, possibly with an internal subset in [...]
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const ch = xml[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
      }
      if (j >= n) fail("Unterminated DOCTYPE", lt);
      i = j + 1;
    } else {
      const gt = xml.indexOf(">", lt + 1);
      if (gt === -1) fail("Unterminated tag", lt);
      let body = xml.slice(lt + 1, gt).trim();
      if (body.startsWith("/")) {
        tokens.push({ kind: "close", name: body.slice(1).trim(), pos: lt });
      } else {
        const selfClosing = body.endsWith("/");
        if (selfClosing) body = body.slice(0, -1).trim();
        const name = body.split(/\s/, 1)[0];
        if (!name) fail("Empty tag name", lt);
        tokens.push({ kind: selfClosing ? "empty" : "open", name, pos: lt });
      }
      i = gt + 1;
    }
  }
  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────

const SCALAR_TAGS = new Set(["string", "integer", "real", "date", "data", "key"]);

/** Parse an XML property list. Throws PlistParseError with line/column on malformed input. */
export function parsePlist(xml: string): PlistValue {
  const fail = (msg: string, pos: number): never => {
    const before = xml.slice(0, pos);
    const line = before.split("\n").length;
    const column = pos - before.lastIndexOf("\n");
    throw new PlistParseError(msg, line, column);
  };

  const tokens = tokenize(xml, fail);
  let p = 0;

  /** Next structural token. Whitespace between elements is layout; inside a scalar it is content. */
  const peek = () => {
    while (p < tokens.length) {
      const t = tokens[p];
      if (t.kind === "text" && t.text.trim() === "") p++;
      else break;
    }
    return tokens[p];
  };
  const endPos = xml.length;

  function readScalarText(name: string, openPos: number): string {
    let text = "";
    while (p < tokens.length && tokens[p].kind === "text") {
      text += (tokens[p] as { text: string }).text;
      p++;
    }
    const close = tokens[p];
    if (!close || close.kind !== "close" || close.name !== name) {
      fail(`Expected </${name}>`, close ? close.pos : openPos);
    }
    p++;
    return decodeEntities(text);
  }

  function scalar(name: string, raw: string, pos: number): PlistValue {
    switch (name) {
      case "string":
        return raw;
      case "integer": {
        const t = raw.trim();
        const v = /^[+-]?0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
        if (!Number.isFinite(v)) fail(`Invalid integer "${t}"`, pos);
        return v;
      }
      case "real": {
        const v = parseFloat(raw.trim());
        if (Number.isNaN(v)) fail(`Invalid real "${raw.trim()}"`, pos);
        return new PlistReal(v);
      }
      case "date": {
        const d = new Date(raw.trim());
        if (Number.isNaN(d.getTime())) fail(`Invalid date "${raw.trim()}"`, pos);
        return d;
      }
      case "data":
        return new PlistData(raw.replace(/\s+/g, ""));
      default:
        return fail(`Unexpected <${name}>`, pos);
    }
  }

  function readValue(): PlistValue {
    const tok = peek();
    if (!tok) return fail("Unexpected end of document", endPos);
    if (tok.kind === "text") return fail(`Unexpected text "${tok.text.trim().slice(0, 30)}"`, tok.pos);
    if (tok.kind === "close") return fail(`Unexpected </${tok.name}>`, tok.pos);

    p++;
    const { name, pos } = tok;

    if (tok.kind === "empty") {
      if (name === "true") return true;
      if (name === "false") return false;
      if (name === "dict") return {};
      if (name === "array") return [];
      if (name === "string") return "";
      if (name === "data") return new PlistData("");
      return fail(`Unexpected <${name}/>`, pos);
    }

    if (name === "dict") {
      const dict: PlistDict = {};
      for (;;) {
        const next = peek();
        if (!next) return fail("Unterminated <dict>", pos);
        if (next.kind === "close") {
          if (next.name !== "dict") return fail(`Expected </dict>, found </${next.name}>`, next.pos);
          p++;
          return dict;
        }
        if (next.kind === "empty" && next.name === "key") {
          return fail("Empty <key/> is not allowed", next.pos);
        }
        if (next.kind !== "open" || next.name !== "key") {
          return fail("Expected <key> inside <dict>", next.pos);
        }
        p++;
        const key = readScalarText("key", next.pos);
        if (key === "") return fail("Empty <key> is not allowed", next.pos);
        const after = peek();
        if (!after || after.kind === "close") {
          return fail(`Missing value for key "${key}"`, after ? after.pos : next.pos);
        }
        dict[key] = readValue();
      }
    }

    if (name === "array") {
      const arr: PlistValue[] = [];
      for (;;) {
        const next = peek();
        if (!next) return fail("Unterminated <array>", pos);
        if (next.kind === "close") {
          if (next.name !== "array") return fail(`Expected </array>, found </${next.name}>`, next.pos);
          p++;
          return arr;
        }
        arr.push(readValue());
      }
    }

    if (name === "true" || name === "false") {
      const close = peek();
      if (!close || close.kind !== "close" || close.name !== name) {
        return fail(`Expected </${name}>`, close ? close.pos : pos);
      }
      p++;
      return name === "true";
    }

    if (SCALAR_TAGS.has(name) && name !== "key") {
      return scalar(name, readScalarText(name, pos), pos);
    }

    return fail(`Unknown element <${name}>`, pos);
  }

  // Optional <plist> wrapper
  let wrapped = false;
  const first = peek();
  if (!first) fail("Document is empty", 0);
  if (first.kind !== "text" && first.name === "plist") {
    if (first.kind === "empty") fail("<plist/> has no root value", first.pos);
    wrapped = true;
    p++;
  }

  const value = readValue();

  if (wrapped) {
    const close = peek();
    if (!close || close.kind !== "close" || close.name !== "plist") {
      fail("Expected </plist>", close ? close.pos : endPos);
    }
    p++;
  }
  const trailing = peek();
  if (trailing) fail("Unexpected content after the root value", trailing.pos);

  return value;
}

/** Parse and require a dictionary root (every launchd job is one). */
export function parsePlistDict(xml: string): PlistDict {
  const value = parsePlist(xml);
  if (!isPlistDict(value)) throw new PlistParseError("Root element must be a <dict>", 1, 1);
  return value;
}

// ── Serializer ───────────────────────────────────────────────────────

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

function writeValue(value: PlistValue, indent: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(`${indent}<string>${escapeXml(value)}</string>`);
  } else if (typeof value === "boolean") {
    out.push(`${indent}<${value ? "true" : "false"}/>`);
  } else if (typeof value === "number") {
    out.push(
      Number.isInteger(value)
        ? `${indent}<integer>${value}</integer>`
        : `${indent}<real>${value}</real>`
    );
  } else if (value instanceof PlistReal) {
    out.push(`${indent}<real>${value.value}</real>`);
  } else if (value instanceof Date) {
    out.push(`${indent}<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`);
  } else if (value instanceof PlistData) {
    out.push(`${indent}<data>${value.base64}</data>`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${indent}<array/>`);
    } else {
      out.push(`${indent}<array>`);
      for (const item of value) writeValue(item, indent + "\t", out);
      out.push(`${indent}</array>`);
    }
  } else {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push(`${indent}<dict/>`);
    } else {
      out.push(`${indent}<dict>`);
      for (const key of keys) {
        const v = value[key];
        if (v === undefined || v === null) continue;
        out.push(`${indent}\t<key>${escapeXml(key)}</key>`);
        writeValue(v, indent + "\t", out);
      }
      out.push(`${indent}</dict>`);
    }
  }
}

/** Serialize to Apple's XML plist layout (tab indented, DOCTYPE header). */
export function serializePlist(value: PlistValue): string {
  const out: string[] = [];
  writeValue(value, "", out);
  return `${HEADER}${out.join("\n")}\n</plist>\n`;
}
