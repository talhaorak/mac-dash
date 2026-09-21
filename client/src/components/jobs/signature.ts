import type { JobSignature } from "@/lib/backend";
import { t } from "@/i18n";

// One-line summary of a code signature for the detail drawer.
// Trust comes ONLY from `apple` and `trusted`: the backend verifies both with `codesign -v -R=...`.
// Authority names are display text. A self-signed certificate can be named "Software Signing".

export type SignatureTone = "ok" | "warning" | "muted";

export interface SignatureSummary {
  text: string;
  tone: SignatureTone;
}

const APP_STORE_AUTHORITY = "Apple Mac OS Application Signing";

export function describeSignature(sig: JobSignature): SignatureSummary {
  if (sig.error) return { text: sig.error, tone: "muted" };
  if (!sig.signed) return { text: t("detail.signature.notSigned"), tone: "warning" };
  if (sig.adhoc) return { text: t("detail.signature.adhoc"), tone: "warning" };
  if (sig.apple) return { text: t("detail.signature.appleVerified"), tone: "ok" };

  const team = sig.teamId ? ` (${sig.teamId})` : "";
  const leaf = sig.authorities[0] ?? null;
  if (sig.trusted) {
    // The App Store re-signs third-party apps with an Apple certificate. The team ID names the developer.
    if (leaf === APP_STORE_AUTHORITY) return { text: t("detail.signature.verified", { name: `Mac App Store${team}` }), tone: "ok" };
    // "Developer ID Application: Foo Inc (TEAMID)" already carries the team ID.
    const name = leaf ? (sig.teamId && !leaf.includes(sig.teamId) ? `${leaf}${team}` : leaf) : `${sig.identifier ?? t("detail.signature.signedFallback")}${team}`;
    return { text: t("detail.signature.verified", { name }), tone: "ok" };
  }
  // Signed, but the chain does not end at Apple's root: self-signed or an untrusted authority.
  return { text: t("detail.signature.untrusted", { name: leaf ?? sig.identifier ?? t("detail.signature.signedFallback") }), tone: "warning" };
}

/** Certificate chain for a tooltip, leaf first. */
export function authorityChain(sig: JobSignature): string {
  return sig.authorities.join(" → ");
}
