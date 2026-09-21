import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SERVICES_ROUTE,
  formatJobRef,
  formatRoute,
  jobRefFromParts,
  onLocationRouteChange,
  pageIdOf,
  parseJobRef,
  parseRoute,
  readLocationRoute,
  routeForPage,
  sameRoute,
  servicesRoute,
  writeLocationRoute,
  type Route,
} from "./router";

describe("parseRoute", () => {
  test("an empty, unknown or non-text hash gives the dashboard", () => {
    for (const hash of ["", "#", "#/", "#/nope", "#garbage?x=1", "/dashboard", "#/dashboard?x=1", "#//dashboard//"]) {
      expect(parseRoute(hash)).toEqual({ page: "dashboard" });
    }
    expect(parseRoute(undefined as unknown as string)).toEqual({ page: "dashboard" });
    expect(parseRoute(`#/services?q=${"a".repeat(5000)}`)).toEqual({ page: "dashboard" });
  });

  test("the hash sign and the leading slash are optional", () => {
    expect(parseRoute("#/plugins")).toEqual({ page: "plugins" });
    expect(parseRoute("/plugins")).toEqual({ page: "plugins" });
    expect(parseRoute("#plugins")).toEqual({ page: "plugins" });
  });

  test("a plain services hash has every default", () => {
    expect(parseRoute("#/services")).toEqual(DEFAULT_SERVICES_ROUTE);
    expect(parseRoute("#/services?")).toEqual(DEFAULT_SERVICES_ROUTE);
  });

  test("every services parameter", () => {
    expect(
      parseRoute("#/services?view=list&folder=builtin:failed&status=error&owner=third-party&tag=backup&q=my%20job&job=user-agents/com.example.job&panel=changes")
    ).toEqual({
      page: "services",
      view: "list",
      folder: "builtin:failed",
      status: "error",
      owner: "third-party",
      tag: "backup",
      q: "my job",
      job: { category: "user-agents", label: "com.example.job" },
      editor: null,
      panel: "changes",
    });
  });

  test("unknown values and unknown parameters are ignored", () => {
    expect(parseRoute("#/services?view=cards&status=weird&owner=me&panel=settings&zzz=1&&=&=x")).toEqual(DEFAULT_SERVICES_ROUTE);
    expect(parseRoute("#/services?view=grid&view=list")).toEqual(servicesRoute({ view: "grid" }));
  });

  test("a malformed escape sequence drops only its own parameter", () => {
    expect(parseRoute("#/services?q=%E0%A4%A&status=running")).toEqual(servicesRoute({ status: "running" }));
    expect(parseRoute("#/services?job=%&view=timeline")).toEqual(servicesRoute({ view: "timeline" }));
  });

  test("the search text keeps its spaces, a plus sign stays a plus sign", () => {
    expect(parseRoute("#/services?q=a+b%20").page).toBe("services");
    expect((parseRoute("#/services?q=a+b%20") as typeof DEFAULT_SERVICES_ROUTE).q).toBe("a+b ");
    expect((parseRoute("#/services?q=%20%20") as typeof DEFAULT_SERVICES_ROUTE).q).toBe("");
  });

  test("control characters are removed and long values are cut", () => {
    const route = parseRoute(`#/services?q=a%00b%0Ac&tag=${"t".repeat(150)}`) as typeof DEFAULT_SERVICES_ROUTE;
    expect(route.q).toBe("abc");
    expect(route.tag).toHaveLength(100);
  });

  test("a job reference without a category is the short form", () => {
    expect((parseRoute("#/services?job=com.example.job") as typeof DEFAULT_SERVICES_ROUTE).job).toEqual({ category: null, label: "com.example.job" });
    expect((parseRoute("#/services?job=elsewhere/com.example.job") as typeof DEFAULT_SERVICES_ROUTE).job).toEqual({ category: null, label: "elsewhere/com.example.job" });
  });

  test("an unusable job reference is ignored", () => {
    expect((parseRoute("#/services?job=") as typeof DEFAULT_SERVICES_ROUTE).job).toBeNull();
    expect((parseRoute("#/services?job=user-agents/") as typeof DEFAULT_SERVICES_ROUTE).job).toBeNull();
    expect((parseRoute("#/services?job=user-agents/a%07b") as typeof DEFAULT_SERVICES_ROUTE).job).toBeNull();
    expect((parseRoute(`#/services?job=${"x".repeat(301)}`) as typeof DEFAULT_SERVICES_ROUTE).job).toBeNull();
  });

  test("edit, duplicate and new open the editor. edit wins over duplicate, duplicate over new", () => {
    const editor = (hash: string) => (parseRoute(hash) as typeof DEFAULT_SERVICES_ROUTE).editor;
    expect(editor("#/services?edit=global-daemons/com.example.d")).toEqual({ mode: "edit", job: { category: "global-daemons", label: "com.example.d" } });
    expect(editor("#/services?duplicate=user-agents/a.b")).toEqual({ mode: "duplicate", job: { category: "user-agents", label: "a.b" } });
    expect(editor("#/services?new=calendar")).toEqual({ mode: "new", templateId: "calendar" });
    expect(editor("#/services?new=")).toEqual({ mode: "new", templateId: "blank" });
    expect(editor("#/services?new=__proto__")).toEqual({ mode: "new", templateId: "blank" });
    expect(editor("#/services?new=login&duplicate=user-agents/a&edit=user-agents/b")).toEqual({ mode: "edit", job: { category: "user-agents", label: "b" } });
    expect(editor("#/services?edit=&new=login")).toEqual({ mode: "new", templateId: "login" });
  });

  test("processes takes a positive whole pid", () => {
    expect(parseRoute("#/processes?pid=123")).toEqual({ page: "processes", pid: 123 });
    for (const pid of ["0", "-5", "1.5", "12abc", "", "99999999999", "0x10", " 7"]) {
      expect(parseRoute(`#/processes?pid=${pid}`)).toEqual({ page: "processes", pid: null });
    }
  });

  test("logs takes a process name", () => {
    expect(parseRoute("#/logs?process=Google%20Chrome")).toEqual({ page: "logs", process: "Google Chrome" });
    expect(parseRoute("#/logs?process=%20")).toEqual({ page: "logs", process: null });
    expect(parseRoute("#/logs")).toEqual({ page: "logs", process: null });
  });

  test("a plugin page needs a safe id", () => {
    expect(parseRoute("#/plugin/network-info")).toEqual({ page: "plugin", id: "network-info" });
    for (const hash of ["#/plugin", "#/plugin/", "#/plugin/..", "#/plugin/a/b", "#/plugin/a%2Fb", "#/plugin/%", "#/plugin/a b", `#/plugin/${"p".repeat(101)}`]) {
      expect(parseRoute(hash)).toEqual({ page: "plugins" });
    }
  });
});

describe("formatRoute", () => {
  test("defaults are left out", () => {
    expect(formatRoute({ page: "dashboard" })).toBe("#/dashboard");
    expect(formatRoute(DEFAULT_SERVICES_ROUTE)).toBe("#/services");
    expect(formatRoute({ page: "processes", pid: null })).toBe("#/processes");
    expect(formatRoute({ page: "logs", process: null })).toBe("#/logs");
    expect(formatRoute({ page: "plugins" })).toBe("#/plugins");
    expect(formatRoute({ page: "plugin", id: "network-info" })).toBe("#/plugin/network-info");
  });

  test("slash and colon stay readable, everything else is escaped", () => {
    expect(formatRoute(servicesRoute({ folder: "user:abc", job: { category: "user-agents", label: "com.example.job" } }))).toBe(
      "#/services?folder=user:abc&job=user-agents/com.example.job"
    );
    expect(formatRoute(servicesRoute({ q: "a&b=c #d%e+f ü" }))).toBe("#/services?q=a%26b%3Dc%20%23d%25e%2Bf%20%C3%BC");
  });

  test("the parameters have a fixed order", () => {
    expect(
      formatRoute(
        servicesRoute({ panel: "changes", editor: { mode: "new", templateId: "watch" }, job: { category: null, label: "x" }, q: "q", tag: "t", owner: "apple", status: "disabled", folder: "f", view: "grid" })
      )
    ).toBe("#/services?view=grid&folder=f&status=disabled&owner=apple&tag=t&q=q&job=x&new=watch&panel=changes");
  });
});

describe("round trip", () => {
  const routes: Route[] = [
    { page: "dashboard" },
    DEFAULT_SERVICES_ROUTE,
    servicesRoute({ view: "timeline", status: "running", owner: "apple" }),
    servicesRoute({ q: "  spaces & signs = ? # % + / : ü 日本 ", tag: "work" }),
    servicesRoute({ job: { category: "system-daemons", label: "com.apple.weird label&=?#%+" } }),
    servicesRoute({ job: { category: null, label: "com.example.short" }, panel: "changes" }),
    servicesRoute({ editor: { mode: "edit", job: { category: "global-agents", label: "a.b.c" } } }),
    servicesRoute({ editor: { mode: "duplicate", job: { category: "user-agents", label: "a.b.c" } }, job: { category: "user-agents", label: "a.b.c" } }),
    servicesRoute({ editor: { mode: "new", templateId: "keepalive" }, folder: "builtin:third-party-daemons" }),
    { page: "processes", pid: 4242 },
    { page: "logs", process: "launchd & friends" },
    { page: "plugins" },
    { page: "plugin", id: "network-info" },
  ];

  test("parse(format(route)) gives the route back", () => {
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  test("format(parse(hash)) is stable", () => {
    for (const route of routes) {
      const hash = formatRoute(route);
      expect(formatRoute(parseRoute(hash))).toBe(hash);
    }
  });

  test("sameRoute compares by content", () => {
    expect(sameRoute(servicesRoute({ q: "a" }), parseRoute("#/services?q=a"))).toBe(true);
    expect(sameRoute(servicesRoute({ q: "a" }), servicesRoute({ q: "b" }))).toBe(false);
  });
});

describe("job references", () => {
  test("format and parse", () => {
    expect(formatJobRef({ category: "user-agents", label: "a.b" })).toBe("user-agents/a.b");
    expect(formatJobRef({ category: null, label: "a.b" })).toBe("a.b");
    expect(parseJobRef("user-agents/a/b")).toEqual({ category: "user-agents", label: "a/b" });
    expect(parseJobRef("")).toBeNull();
  });

  test("jobRefFromParts checks loose parts", () => {
    expect(jobRefFromParts("a.b", "global-daemons")).toEqual({ category: "global-daemons", label: "a.b" });
    expect(jobRefFromParts("user-agents/a.b", "bogus")).toEqual({ category: null, label: "user-agents/a.b" });
    expect(jobRefFromParts("a.b", undefined)).toEqual({ category: null, label: "a.b" });
    expect(jobRefFromParts("", "user-agents")).toBeNull();
    expect(jobRefFromParts(42, "user-agents")).toBeNull();
    expect(jobRefFromParts(null, null)).toBeNull();
  });
});

describe("page ids", () => {
  test("pageIdOf and routeForPage agree", () => {
    for (const page of ["dashboard", "services", "processes", "logs", "plugins", "plugin:network-info"]) {
      expect(pageIdOf(routeForPage(page))).toBe(page);
    }
    expect(routeForPage("services")).toEqual(DEFAULT_SERVICES_ROUTE);
    expect(routeForPage("nope")).toEqual({ page: "dashboard" });
    expect(routeForPage("plugin:../x")).toEqual({ page: "plugins" });
    expect(routeForPage("services?view=list")).toEqual({ page: "dashboard" });
  });
});

describe("window.history", () => {
  /** The calls that reached the fake history, e.g. "push #/logs". */
  let calls: string[];
  let listeners: Map<string, Set<() => void>>;
  const emit = (type: string) => listeners.get(type)?.forEach((fn) => fn());

  beforeEach(() => {
    calls = [];
    listeners = new Map();
    const location = { hash: "" };
    const write = (kind: string) => (_state: unknown, _title: string, url: string) => {
      calls.push(`${kind} ${url}`);
      location.hash = url;
    };
    (globalThis as { window?: unknown }).window = {
      location,
      history: { state: null, pushState: write("push"), replaceState: write("replace") },
      addEventListener: (type: string, fn: () => void) => listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("a push is written at once, and not again for the same route", () => {
    writeLocationRoute({ page: "logs", process: null }, "push");
    writeLocationRoute({ page: "logs", process: null }, "push");
    expect(calls).toEqual(["push #/logs"]);
    expect(readLocationRoute()).toEqual({ page: "logs", process: null });
  });

  test("a replace waits for a pause, and only the last one is written", async () => {
    writeLocationRoute(servicesRoute({ q: "a" }), "replace");
    writeLocationRoute(servicesRoute({ q: "ab" }), "replace");
    expect(calls).toEqual([]);
    await Bun.sleep(320);
    expect(calls).toEqual(["replace #/services?q=ab"]);
  });

  test("a push first writes the replace that still waits", () => {
    writeLocationRoute(servicesRoute({ q: "abc" }), "replace");
    writeLocationRoute(servicesRoute({ q: "abc", job: { category: "user-agents", label: "a.b" } }), "push");
    expect(calls).toEqual(["replace #/services?q=abc", "push #/services?q=abc&job=user-agents/a.b"]);
  });

  test("an immediate replace tidies a sloppy hash", () => {
    (globalThis as unknown as { window: { location: { hash: string } } }).window.location.hash = "#services?view=nope";
    writeLocationRoute(readLocationRoute(), "replace", { immediate: true });
    expect(calls).toEqual(["replace #/services"]);
  });

  test("a URL change reaches the listener and cancels the replace that waits", async () => {
    const seen: Route[] = [];
    const stop = onLocationRouteChange((route) => seen.push(route));
    writeLocationRoute(servicesRoute({ q: "typed" }), "replace");
    (globalThis as unknown as { window: { location: { hash: string } } }).window.location.hash = "#/processes?pid=7";
    emit("popstate");
    await Bun.sleep(320);
    expect(seen).toEqual([{ page: "processes", pid: 7 }]);
    expect(calls).toEqual([]);

    stop();
    emit("hashchange");
    expect(seen).toHaveLength(1);
  });

  test("a history that throws does not break navigation", () => {
    (globalThis as unknown as { window: { history: { pushState: () => void } } }).window.history.pushState = () => {
      throw new Error("SecurityError");
    };
    expect(() => writeLocationRoute({ page: "plugins" }, "push")).not.toThrow();
  });
});
