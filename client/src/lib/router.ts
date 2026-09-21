/**
 * Routes of the dashboard. The URL hash is the single source of navigation truth,
 * so a reload, a second browser tab and a second desktop window restore the same state.
 *
 * Grammar:
 *   #/dashboard
 *   #/services?view=&folder=&status=&owner=&tag=&q=&job=&edit=|duplicate=|new=&panel=
 *   #/processes?pid=<number>
 *   #/logs?process=<name>
 *   #/plugins
 *   #/plugin/<id>
 *
 * `parseRoute` and `formatRoute` are pure. The functions at the end of the file talk to `window.history`.
 */

import { JOB_SCOPES, JOB_TEMPLATES, type JobCategory } from "@shared/launchd";

// ── Model ────────────────────────────────────────────────────────────

export const SERVICES_VIEWS = ["groups", "list", "grid", "timeline"] as const;
export type ServicesView = (typeof SERVICES_VIEWS)[number];

export const STATUS_FILTERS = ["all", "running", "stopped", "error", "disabled"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const OWNER_FILTERS = ["all", "apple", "third-party"] as const;
export type OwnerFilter = (typeof OWNER_FILTERS)[number];

/** A job in a URL. `category` is null for the short form `job=<label>`: the first job with that label is meant. */
export interface RouteJobRef {
  label: string;
  category: JobCategory | null;
}

export type EditorRoute = { mode: "edit"; job: RouteJobRef } | { mode: "duplicate"; job: RouteJobRef } | { mode: "new"; templateId: string };

export interface ServicesRoute {
  page: "services";
  view: ServicesView;
  /** Id of the active smart folder. */
  folder: string | null;
  status: StatusFilter;
  owner: OwnerFilter;
  tag: string | null;
  /** Text of the search box, exactly as typed. */
  q: string;
  /** The job in the detail drawer. */
  job: RouteJobRef | null;
  /** The open job editor. */
  editor: EditorRoute | null;
  /** "changes" opens the job change history. */
  panel: "changes" | null;
}

export type Route =
  | { page: "dashboard" }
  | ServicesRoute
  | { page: "processes"; pid: number | null }
  | { page: "logs"; process: string | null }
  | { page: "plugins" }
  | { page: "plugin"; id: string };

export const DEFAULT_ROUTE: Route = { page: "dashboard" };

export const DEFAULT_SERVICES_ROUTE: ServicesRoute = {
  page: "services",
  view: "groups",
  folder: null,
  status: "all",
  owner: "all",
  tag: null,
  q: "",
  job: null,
  editor: null,
  panel: null,
};

/** Services route with the given fields. Every other field has its default. */
export function servicesRoute(fields: Partial<Omit<ServicesRoute, "page">> = {}): ServicesRoute {
  return { ...DEFAULT_SERVICES_ROUTE, ...fields };
}

// ── Limits of untrusted input ────────────────────────────────────────

const MAX_HASH_LENGTH = 4000;
const MAX_LABEL_LENGTH = 300;
const MAX_QUERY_LENGTH = 200;
const MAX_TAG_LENGTH = 100;
const MAX_ID_LENGTH = 100;
const MAX_PID = 2 ** 31 - 1;

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const CONTROL_CHARACTERS_ALL = /[\x00-\x1f\x7f]/g;
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const validPluginId = (id: string) => id.length <= MAX_ID_LENGTH && PLUGIN_ID_PATTERN.test(id);

const CATEGORIES = new Set<string>(JOB_SCOPES.map((s) => s.category));
const TEMPLATE_IDS = new Set(JOB_TEMPLATES.map((t) => t.id));

/** Template of `new=` with an unknown id. */
export const DEFAULT_TEMPLATE_ID = JOB_TEMPLATES[0].id;

const isCategory = (value: string): value is JobCategory => CATEGORIES.has(value);

function oneOf<T extends string>(values: readonly T[], value: string | undefined, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

/** `decodeURIComponent` that returns null for a malformed escape sequence. */
function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Percent-encode a value. "/" and ":" stay readable: both are legal inside a URL fragment. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/").replace(/%3A/g, ":");
}

// ── Job references ───────────────────────────────────────────────────

/** "<category>/<label>", or "<label>" when the category is not known. */
export function formatJobRef(ref: RouteJobRef): string {
  return ref.category ? `${ref.category}/${ref.label}` : ref.label;
}

const usableLabel = (label: string) => label !== "" && label.length <= MAX_LABEL_LENGTH && !CONTROL_CHARACTERS.test(label);

/** Null for an empty, over-long or control-character label. */
export function parseJobRef(value: string): RouteJobRef | null {
  const slash = value.indexOf("/");
  const head = slash === -1 ? "" : value.slice(0, slash);
  const ref: RouteJobRef = isCategory(head) ? { category: head, label: value.slice(slash + 1) } : { category: null, label: value };
  return usableLabel(ref.label) ? ref : null;
}

/** Job reference from loose parts, e.g. the payload of a desktop event. An unknown category is dropped. Null for an unusable label. */
export function jobRefFromParts(label: unknown, category: unknown): RouteJobRef | null {
  if (typeof label !== "string" || !usableLabel(label)) return null;
  return { label, category: typeof category === "string" && isCategory(category) ? category : null };
}

// ── Parse ────────────────────────────────────────────────────────────

/** First value of every parameter that decodes. A parameter with a malformed escape sequence is dropped. */
function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? "" : safeDecode(pair.slice(eq + 1));
    if (name === null || value === null || params.has(name)) continue;
    params.set(name, value);
  }
  return params;
}

function cleanText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  const text = value.replace(CONTROL_CHARACTERS_ALL, "").slice(0, maxLength);
  return text.trim() === "" ? null : text;
}

function parseEditor(params: Map<string, string>): EditorRoute | null {
  for (const mode of ["edit", "duplicate"] as const) {
    const value = params.get(mode);
    const job = value === undefined ? null : parseJobRef(value);
    if (job) return { mode, job };
  }
  const templateId = params.get("new");
  if (templateId === undefined) return null;
  return { mode: "new", templateId: TEMPLATE_IDS.has(templateId) ? templateId : DEFAULT_TEMPLATE_ID };
}

function parseServices(params: Map<string, string>): ServicesRoute {
  const job = params.get("job");
  return {
    page: "services",
    view: oneOf(SERVICES_VIEWS, params.get("view"), "groups"),
    folder: cleanText(params.get("folder"), MAX_ID_LENGTH)?.trim() ?? null,
    status: oneOf(STATUS_FILTERS, params.get("status"), "all"),
    owner: oneOf(OWNER_FILTERS, params.get("owner"), "all"),
    tag: cleanText(params.get("tag"), MAX_TAG_LENGTH)?.trim() ?? null,
    q: cleanText(params.get("q"), MAX_QUERY_LENGTH) ?? "",
    job: job === undefined ? null : parseJobRef(job),
    editor: parseEditor(params),
    panel: params.get("panel") === "changes" ? "changes" : null,
  };
}

/**
 * Route of a URL hash ("#/services?view=list", with or without the "#").
 * The input is untrusted. An unknown page gives the dashboard. An unknown or malformed parameter is ignored.
 */
export function parseRoute(hash: string): Route {
  if (typeof hash !== "string" || hash.length > MAX_HASH_LENGTH) return DEFAULT_ROUTE;
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  const mark = text.indexOf("?");
  const path = mark === -1 ? text : text.slice(0, mark);
  const params = parseQuery(mark === -1 ? "" : text.slice(mark + 1));
  const segments = path.split("/").filter((s) => s !== "");

  switch (segments[0]) {
    case "services":
      return parseServices(params);
    case "processes": {
      const pid = params.get("pid") ?? "";
      const value = /^[1-9]\d{0,9}$/.test(pid) ? Number(pid) : null;
      return { page: "processes", pid: value !== null && value <= MAX_PID ? value : null };
    }
    case "logs":
      return { page: "logs", process: cleanText(params.get("process"), MAX_QUERY_LENGTH)?.trim() ?? null };
    case "plugins":
      return { page: "plugins" };
    case "plugin": {
      const id = segments.length === 2 ? safeDecode(segments[1]) : null;
      return id !== null && validPluginId(id) ? { page: "plugin", id } : { page: "plugins" };
    }
    default:
      return DEFAULT_ROUTE;
  }
}

// ── Format ───────────────────────────────────────────────────────────

/** Canonical hash of a route. A field that has its default value is left out. */
export function formatRoute(route: Route): string {
  const params: [string, string][] = [];
  let path: string;

  switch (route.page) {
    case "services":
      path = "services";
      if (route.view !== "groups") params.push(["view", route.view]);
      if (route.folder) params.push(["folder", route.folder]);
      if (route.status !== "all") params.push(["status", route.status]);
      if (route.owner !== "all") params.push(["owner", route.owner]);
      if (route.tag) params.push(["tag", route.tag]);
      if (route.q !== "") params.push(["q", route.q]);
      if (route.job) params.push(["job", formatJobRef(route.job)]);
      if (route.editor) params.push(route.editor.mode === "new" ? ["new", route.editor.templateId] : [route.editor.mode, formatJobRef(route.editor.job)]);
      if (route.panel) params.push(["panel", route.panel]);
      break;
    case "processes":
      path = "processes";
      if (route.pid !== null) params.push(["pid", String(route.pid)]);
      break;
    case "logs":
      path = "logs";
      if (route.process) params.push(["process", route.process]);
      break;
    case "plugin":
      path = `plugin/${encodeURIComponent(route.id)}`;
      break;
    default:
      path = route.page;
  }

  const query = params.map(([name, value]) => `${name}=${encode(value)}`).join("&");
  return `#/${path}${query ? `?${query}` : ""}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}

// ── Page ids of the navigation store ─────────────────────────────────

/** "dashboard", "services", … and "plugin:<id>" for a plugin page. */
export function pageIdOf(route: Route): string {
  return route.page === "plugin" ? `plugin:${route.id}` : route.page;
}

/** The plain route of a page id, without parameters. An unknown id gives the dashboard. */
export function routeForPage(pageId: string): Route {
  if (pageId.startsWith("plugin:")) {
    const id = pageId.slice("plugin:".length);
    return validPluginId(id) ? { page: "plugin", id } : { page: "plugins" };
  }
  switch (pageId) {
    case "services":
      return DEFAULT_SERVICES_ROUTE;
    case "processes":
      return { page: "processes", pid: null };
    case "logs":
      return { page: "logs", process: null };
    case "plugins":
      return { page: "plugins" };
    default:
      return DEFAULT_ROUTE;
  }
}

// ── window.history ───────────────────────────────────────────────────
// "push" adds a history entry, so Back returns to the state before. "replace" is for changes that arrive
// with every keystroke. Safari throws after 100 history calls in 30 seconds, so a replace waits for a pause.

export type NavigateMode = "push" | "replace";

const REPLACE_DELAY_MS = 250;

let pendingHash: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function commit(method: "pushState" | "replaceState", hash: string): void {
  try {
    const current = window.location.hash;
    // A push to the route that is already shown would add a useless Back step. A replace also tidies a sloppy hash.
    const same = method === "pushState" ? formatRoute(parseRoute(current)) === hash : current === hash;
    if (!same) window.history[method](window.history.state, "", hash);
  } catch {
    // The browser refused (rate limit, sandboxed frame). The store still holds the route for this session.
  }
}

function flushPending(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  if (pendingHash !== null) commit("replaceState", pendingHash);
  pendingHash = null;
}

function dropPending(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingHash = null;
}

export function readLocationRoute(): Route {
  return typeof window === "undefined" ? DEFAULT_ROUTE : parseRoute(window.location.hash);
}

/** Write the route to the address bar. Does not notify `onLocationRouteChange` listeners: the caller already knows the route. */
export function writeLocationRoute(route: Route, mode: NavigateMode, options: { immediate?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const hash = formatRoute(route);
  if (mode === "push") {
    // The entry that stays behind must hold the last filter text.
    flushPending();
    commit("pushState", hash);
    return;
  }
  pendingHash = hash;
  if (options.immediate) {
    flushPending();
    return;
  }
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPending, REPLACE_DELAY_MS);
}

/** Calls `listener` when the user changes the URL: Back, Forward, a typed hash, a clicked link. */
export function onLocationRouteChange(listener: (route: Route) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onChange = () => {
    // The URL is newer than a replace that still waits.
    dropPending();
    listener(parseRoute(window.location.hash));
  };
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener("pagehide", flushPending);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("pagehide", flushPending);
  };
}
