// "Wrap in an app": pure pieces of the Run section. The backend builds the app (docs/backend-contract.md, "Build app").

/** The backend accepts exactly this pattern for an app name. */
export const APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** "/Users/me/bin/nightly backup.sh" → "nightly backup". Always matches APP_NAME_PATTERN. */
export function defaultAppName(scriptPath: string): string {
  const file = scriptPath.split("/").filter(Boolean).pop() ?? "";
  const stem = file.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const name = stem
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[^A-Za-z0-9]+$/, "");
  return name || "Script";
}

export function appNameProblem(name: string): string | null {
  if (name.trim() === "") return "Enter a name for the app.";
  if (!APP_NAME_PATTERN.test(name)) {
    return "Use 1 to 64 letters, digits, spaces, dots, dashes or underscores. Start with a letter or a digit.";
  }
  return null;
}

export interface OpenAppArgs {
  app: string;
  /** `-W`: open(1) stays alive until the app quits, so launchd can track the job. */
  wait: boolean;
  /** Arguments after the app, kept as they are. */
  rest: string[];
}

/** Read `/usr/bin/open [-W] -a <app> [...]`. Returns null for any other command. */
export function parseOpenArgs(args: string[]): OpenAppArgs | null {
  if (args[0] !== "/usr/bin/open") return null;
  const wait = args[1] === "-W";
  const at = wait ? 2 : 1;
  if (args[at] !== "-a") return null;
  return { app: args[at + 1] ?? "", wait, rest: args.slice(at + 2) };
}

export function buildOpenArgs({ app, wait, rest }: OpenAppArgs): string[] {
  return ["/usr/bin/open", ...(wait ? ["-W"] : []), "-a", app, ...rest];
}
