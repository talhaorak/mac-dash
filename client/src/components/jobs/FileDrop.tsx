import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/Toast";
import { backend } from "@/lib/backend";
import { useServicesStore } from "@/stores/app";
import { LABEL_PATTERN, type PathFacts } from "@shared/launchd";
import type { PlistDict } from "@shared/plist";
import type { JobEditorTarget } from "./JobEditor";
import { buildOpenArgs } from "./scriptApp";

// Desktop only: drop a file from Finder on the window to start a new job for it.
// A browser never gives a web page the real path of a dropped file, so the web build has no such feature.
// The first half of this file is pure and unit-tested (helpers.test.ts).

/** Interpreter by file extension. Every value is in the interpreter list of the form, so the form shows "Script". */
export const SCRIPT_INTERPRETERS: Record<string, string> = {
  sh: "/bin/sh",
  bash: "/bin/bash",
  zsh: "/bin/zsh",
  py: "/usr/bin/python3",
  rb: "/usr/bin/ruby",
  pl: "/usr/bin/perl",
  scpt: "/usr/bin/osascript",
  applescript: "/usr/bin/osascript",
  swift: "/usr/bin/swift",
};

export type DropKind = "app" | "program" | "script" | "watch-folder" | "watch-file";

function cleanPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** "/Applications/Visual Studio Code.app" → "local.visual-studio-code". Always a valid, unused label. */
export function dropLabel(path: string, taken: Iterable<string>): string {
  const name = cleanPath(path).split("/").pop() ?? "";
  const stem = extensionOf(name) ? name.slice(0, name.lastIndexOf(".")) : name;
  const slug = stem
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // "é" is "e" plus a combining accent after NFKD
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 60)
    .replace(/[^a-z0-9]+$/, "");
  const base = `local.${slug || "job"}`;
  const used = new Set(taken);
  let label = base;
  for (let i = 2; used.has(label); i++) label = `${base}-${i}`;
  return LABEL_PATTERN.test(label) ? label : "local.job";
}

/**
 * The job for one dropped path, or null when the path cannot start a job.
 * `facts` comes from `backend.checkPaths`. It can be missing for an app bundle: the name is enough there.
 */
export function buildDropJob(
  path: string,
  facts: Pick<PathFacts, "exists" | "isFile" | "isDirectory" | "executable"> | null,
  taken: Iterable<string>
): { kind: DropKind; job: PlistDict } | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const target = cleanPath(path);
  if (target === "/") return null;
  const Label = dropLabel(target, taken);

  if (target.toLowerCase().endsWith(".app")) {
    return { kind: "app", job: { Label, ProgramArguments: buildOpenArgs({ app: target, wait: false, rest: [] }), RunAtLoad: true } };
  }
  if (!facts || !facts.exists) return null;
  if (facts.isDirectory) {
    return { kind: "watch-folder", job: { Label, ProgramArguments: ["/bin/sh", "-c", "echo changed"], WatchPaths: [target] } };
  }
  if (!facts.isFile) return null;
  // An executable file runs as it is: a script then uses its own #! line.
  if (facts.executable) return { kind: "program", job: { Label, ProgramArguments: [target], RunAtLoad: true } };
  const interpreter = SCRIPT_INTERPRETERS[extensionOf(target.split("/").pop() ?? "")];
  if (interpreter) return { kind: "script", job: { Label, ProgramArguments: [interpreter, target], RunAtLoad: true } };
  return { kind: "watch-file", job: { Label, ProgramArguments: ["/bin/sh", "-c", "echo changed"], WatchPaths: [target] } };
}

export const DROP_KIND_NOTES: Record<DropKind, string> = {
  app: "New job: open this app at login.",
  program: "New job: run this program at login.",
  script: "New job: run this script at login.",
  "watch-folder": "New job: run a command when this folder changes. Replace the example command.",
  "watch-file": "This file cannot run. New job: run a command when the file changes. Replace the example command.",
};

// ── Overlay ──────────────────────────────────────────────────────────

/** The hook has no place in the React tree to render into, so the overlay is a plain element on <body>. */
function createDropOverlay() {
  const root = document.createElement("div");
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.className = "fixed inset-0 z-[90] hidden items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none";
  const card = document.createElement("div");
  card.className = "glass rounded-2xl border-2 border-dashed border-cyan-400/60 px-10 py-8 text-center shadow-2xl";
  const title = document.createElement("p");
  title.className = "text-lg font-bold text-white";
  const hint = document.createElement("p");
  hint.className = "mt-1 text-xs text-gray-400";
  card.append(title, hint);
  root.append(card);
  document.body.append(root);

  return {
    show(paths: string[]) {
      const one = paths.length === 1;
      title.textContent = one ? "Drop to create a job" : "Drop one item at a time";
      hint.textContent = one
        ? `${cleanPath(paths[0]).split("/").pop()}: an app, a program or a script runs at login. A folder or another file is watched for changes.`
        : "A job is created for one app, program, script or folder.";
      root.classList.remove("hidden");
      root.classList.add("flex");
    },
    hide() {
      root.classList.add("hidden");
      root.classList.remove("flex");
    },
    destroy() {
      root.remove();
    },
  };
}

/** An open dialog (the editor, a confirmation) owns the window: a drop must not replace it. */
const dialogIsOpen = () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

/**
 * Desktop build only: while a file is dragged over the window a full-window overlay shows. A drop of ONE path calls
 * `onCreate` with a "new" editor target that carries the prepared job (`initialJob`). Does nothing in a browser.
 *
 * Mount it once, in the page that owns the job editor: `useFileDropToCreate(setEditor)`.
 */
export function useFileDropToCreate(onCreate: (target: JobEditorTarget) => void): void {
  const handler = useRef(onCreate);
  handler.current = onCreate;

  useEffect(() => {
    if (!backend.isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const overlay = createDropOverlay();

    const create = async (path: string) => {
      const isApp = cleanPath(path).toLowerCase().endsWith(".app");
      const facts = isApp
        ? null
        : await backend
            .checkPaths([path])
            .then((all) => all.find((f) => f.path === path) ?? null)
            .catch(() => null);
      if (disposed) return;
      const built = buildDropJob(path, facts, useServicesStore.getState().services.map((s) => s.label));
      if (!built) return toast.error(facts ? "This item cannot start a job." : "The dropped item could not be inspected.");
      toast.info(DROP_KIND_NOTES[built.kind]);
      handler.current({ mode: "new", initialJob: built.job });
    };

    import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter") {
            if (!dialogIsOpen() && payload.paths.length > 0) overlay.show(payload.paths);
          } else if (payload.type === "leave") {
            overlay.hide();
          } else if (payload.type === "drop") {
            overlay.hide();
            if (dialogIsOpen() || payload.paths.length === 0) return;
            if (payload.paths.length > 1) return void toast.info("Drop one item at a time to create a job.");
            void create(payload.paths[0]);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Not a Tauri webview, or the shell does not allow the event: the feature is simply off.
      });

    return () => {
      disposed = true;
      unlisten?.();
      overlay.destroy();
    };
  }, []);
}
