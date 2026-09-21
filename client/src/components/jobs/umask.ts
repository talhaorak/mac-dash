// umask(2) helpers for the job form. launchd stores Umask as a DECIMAL integer:
// octal 022 is decimal 18. A set bit MASKS (removes) that permission from new files.

export const UMASK_CLASSES = ["Owner", "Group", "Other"] as const;
export const UMASK_PERMISSIONS = ["Read", "Write", "Execute"] as const;

/** Conventional default: group and other cannot write. */
export const DEFAULT_UMASK = 0o022;

/** Bit of one grid cell. Row 0 is the owner, column 0 is read: owner-read is 0o400. */
export function umaskBit(classIndex: number, permissionIndex: number): number {
  return 1 << ((2 - classIndex) * 3 + (2 - permissionIndex));
}

/** umask(2) only uses the nine permission bits. */
export function normalizeUmask(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) & 0o777 : 0;
}

/** grid[class][permission] is true when the permission is masked. */
export function umaskToGrid(value: number): boolean[][] {
  const mask = normalizeUmask(value);
  return UMASK_CLASSES.map((_, c) => UMASK_PERMISSIONS.map((_, p) => (mask & umaskBit(c, p)) !== 0));
}

export function gridToUmask(grid: boolean[][]): number {
  let mask = 0;
  grid.forEach((row, c) => row.forEach((masked, p) => masked && (mask |= umaskBit(c, p))));
  return mask;
}

export function toggleUmaskBit(value: number, classIndex: number, permissionIndex: number): number {
  return normalizeUmask(value) ^ umaskBit(classIndex, permissionIndex);
}

/** "022": at least three octal digits, the way umask is usually written. */
export function formatOctal(value: number): string {
  return normalizeUmask(value).toString(8).padStart(3, "0");
}

/** "rw-r--r--" for a permission mode such as 0o644. */
export function formatMode(mode: number): string {
  return UMASK_CLASSES.map((_, c) => ["r", "w", "x"].map((ch, p) => (mode & umaskBit(c, p) ? ch : "-")).join("")).join("");
}

/** Mode of a new file (0666) or folder (0777) created under this umask. */
export function modeUnderUmask(value: number, kind: "file" | "folder"): number {
  return (kind === "file" ? 0o666 : 0o777) & ~normalizeUmask(value);
}

/**
 * launchd converts a string Umask with strtoul(3), base 0: "0x12" is hexadecimal,
 * a leading "0" means octal, anything else is decimal. Returns null when the string
 * does not convert cleanly.
 */
export function parseUmaskString(text: string): number | null {
  const t = text.trim().replace(/^\+/, "");
  let n: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) n = parseInt(t.slice(2), 16);
  else if (/^0[0-7]*$/.test(t)) n = parseInt(t, 8);
  else if (/^[1-9][0-9]*$/.test(t)) n = parseInt(t, 10);
  else return null;
  return Number.isSafeInteger(n) ? n : null;
}
