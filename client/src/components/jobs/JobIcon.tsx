import { memo, useId, useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t, useT } from "@/i18n";

// ── Icon values ──────────────────────────────────────────────────────
// `JobMeta.icon` is an emoji or a small PNG/JPEG data URL. The value comes from the backend and from
// other clients, so it is checked before it reaches an `src` attribute.

/** Edge length of a stored image icon, in pixels. */
export const ICON_PIXELS = 64;
/** The picker rejects a data URL that is longer than this. */
export const MAX_ICON_LENGTH = 48 * 1024;
/** Longest data URL that `JobIcon` renders. Wider than the picker limit: another client can have other rules. */
const MAX_RENDER_LENGTH = 512 * 1024;
/** A family emoji with skin tones needs about 25 UTF-16 units. */
const MAX_EMOJI_LENGTH = 32;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

const DATA_URL_PATTERN = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** True for a base64 PNG or JPEG data URL. Every other URL scheme and media type is refused. */
export function isIconDataUrl(value: string): boolean {
  return value.length <= MAX_RENDER_LENGTH && DATA_URL_PATTERN.test(value);
}

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** The first visible character of a text icon, or null when the value is not a usable text icon. */
export function emojiIcon(value: string): string | null {
  const text = value.trim();
  if (text === "" || /^data:/i.test(text)) return null;
  const first = graphemes(text)[0];
  return first !== undefined && first.length <= MAX_EMOJI_LENGTH ? first : null;
}

export type ResolvedIcon = { kind: "image"; src: string } | { kind: "emoji"; text: string } | null;

/** What to draw for a stored icon value. Null means the letter avatar. */
export function resolveIcon(icon: string | undefined | null): ResolvedIcon {
  if (typeof icon !== "string" || icon === "") return null;
  if (isIconDataUrl(icon)) return { kind: "image", src: icon };
  const text = emojiIcon(icon);
  return text === null ? null : { kind: "emoji", text };
}

// ── Letter avatar ────────────────────────────────────────────────────

/**
 * Letter of the avatar. A reverse-DNS label shows the vendor: "com.docker.vmnetd" gives "D".
 * Every other label shows its first letter or digit.
 */
export function avatarLetter(label: string): string {
  const segments = label.split(".").filter((s) => s !== "");
  const source = segments.length >= 3 && segments[0].length <= 4 ? segments[1] : (segments[0] ?? "");
  const match = source.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "?";
}

/** Hue of the avatar, 0 to 359. The same label always gives the same hue. */
export function avatarHue(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return hash % 360;
}

// ── JobIcon ──────────────────────────────────────────────────────────

export interface JobIconProps {
  /** Job label. It selects the letter and the colour of the avatar. */
  label: string;
  /** `JobMeta.icon`. An unusable value gives the avatar. */
  icon?: string | null;
  /** Edge length in CSS pixels. Defaults to 32. */
  size?: number;
  className?: string;
}

/**
 * Icon of a job: the user's emoji or image, otherwise a coloured letter.
 * The icon is decorative. The job label is always next to it, so assistive technology skips the icon.
 */
export const JobIcon = memo(function JobIcon({ label, icon, size = 32, className }: JobIconProps) {
  const resolved = resolveIcon(icon);
  // An image that does not decode gives way to the avatar.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const box = { width: size, height: size };
  const shape = "inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-[22%] select-none";

  if (resolved?.kind === "image" && brokenSrc !== resolved.src) {
    return (
      <span aria-hidden className={cn(shape, "bg-white/[0.04]", className)} style={box}>
        <img src={resolved.src} alt="" width={size} height={size} draggable={false} onError={() => setBrokenSrc(resolved.src)} className="h-full w-full object-contain" />
      </span>
    );
  }

  if (resolved?.kind === "emoji") {
    return (
      <span aria-hidden className={cn(shape, "bg-white/[0.05] leading-none", className)} style={{ ...box, fontSize: Math.round(size * 0.6) }}>
        {resolved.text}
      </span>
    );
  }

  const hue = avatarHue(label);
  return (
    <span
      aria-hidden
      className={cn(shape, "font-semibold leading-none", className)}
      style={{
        ...box,
        fontSize: Math.round(size * 0.46),
        color: `hsl(${hue} 85% 82%)`,
        backgroundColor: `hsl(${hue} 45% 24%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 55% / 0.3)`,
      }}
    >
      {avatarLetter(label)}
    </span>
  );
});

// ── Image to icon ────────────────────────────────────────────────────

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t("list.icon.cannotRead")));
    };
    image.src = url;
  });
}

async function decodeImage(blob: Blob): Promise<{ source: Drawable; width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Some browsers decode SVG only through an image element.
    }
  }
  const image = await loadImageElement(blob);
  return { source: image, width: image.naturalWidth || ICON_PIXELS, height: image.naturalHeight || ICON_PIXELS };
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("list.icon.noCanvas"));
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/**
 * Downsize an image file to a 64×64 PNG data URL. The picture keeps its proportions on a transparent square.
 * Throws an `Error` with a user-facing message when the file is not an image or the result is over 48 KB.
 */
export async function imageToIcon(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(t("list.icon.notImage"));
  if (file.size > MAX_SOURCE_BYTES) throw new Error(t("list.icon.tooLargeSource"));

  let { source, width, height } = await decodeImage(file);
  if (width <= 0 || height <= 0) throw new Error(t("list.icon.empty"));

  // One big step from a photo to 64 pixels looks jagged. Halve until the last step is less than a factor of two.
  while (Math.max(width, height) > ICON_PIXELS * 2) {
    const half = canvasOf(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    half.context.drawImage(source, 0, 0, half.canvas.width, half.canvas.height);
    if ("close" in source) source.close();
    source = half.canvas;
    width = half.canvas.width;
    height = half.canvas.height;
  }

  const scale = Math.min(ICON_PIXELS / width, ICON_PIXELS / height);
  const drawWidth = Math.max(1, Math.round(width * scale));
  const drawHeight = Math.max(1, Math.round(height * scale));
  const icon = canvasOf(ICON_PIXELS, ICON_PIXELS);
  icon.context.drawImage(source, (ICON_PIXELS - drawWidth) / 2, (ICON_PIXELS - drawHeight) / 2, drawWidth, drawHeight);
  if ("close" in source) source.close();

  let dataUrl: string;
  try {
    dataUrl = icon.canvas.toDataURL("image/png");
  } catch {
    throw new Error(t("list.icon.canvasBlocked"));
  }
  if (!isIconDataUrl(dataUrl)) throw new Error(t("list.icon.pngFailed"));
  if (dataUrl.length > MAX_ICON_LENGTH) throw new Error(t("list.icon.tooLargeResult"));
  return dataUrl;
}

function firstImageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files)) if (file.type.startsWith("image/")) return file;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

// ── JobIconPicker ────────────────────────────────────────────────────

export interface JobIconPickerProps {
  /** `JobMeta.icon`: an emoji, a PNG or JPEG data URL, or undefined for the letter avatar. */
  value: string | undefined;
  /** Receives an emoji, a 64×64 PNG data URL of at most 48 KB, or undefined after "Remove". */
  onChange: (icon: string | undefined) => void;
  /** Job label, for the avatar in the preview. */
  label?: string;
  disabled?: boolean;
}

/** Editor of a job icon: an emoji field, a zone that takes a pasted, dropped or chosen image, and a Remove button. */
export function JobIconPicker({ value, onChange, label = "", disabled = false }: JobIconPickerProps) {
  const { t } = useT();
  const emojiId = useId();
  const hintId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const resolved = resolveIcon(value);
  const emoji = resolved?.kind === "emoji" ? resolved.text : "";

  const takeImage = async (file: File | null) => {
    if (!file || disabled) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await imageToIcon(file));
    } catch (e) {
      setError((e as Error).message || t("list.icon.readFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const file = firstImageFile(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    void takeImage(file);
  };

  const ring = "focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50";

  return (
    <fieldset disabled={disabled} className="space-y-2 min-w-0">
      <legend className="text-xs font-medium text-gray-400">{t("list.icon.legend")}</legend>

      <div className="flex items-stretch gap-3 flex-wrap">
        <JobIcon label={label} icon={value} size={48} />

        <div className="space-y-1">
          <label htmlFor={emojiId} className="block text-[11px] text-gray-500">
            {t("list.icon.emojiLabel")}
          </label>
          <input
            id={emojiId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={emoji}
            placeholder="🚀"
            aria-describedby={hintId}
            // The last character wins, so a new emoji replaces the old one without a delete.
            onChange={(e) => {
              const typed = graphemes(e.target.value.trim());
              const next = typed.length > 0 ? emojiIcon(typed[typed.length - 1]) : null;
              setError(null);
              onChange(next ?? undefined);
            }}
            onPaste={onPaste}
            className={cn(
              "w-16 px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-center text-lg text-gray-200 placeholder-gray-700 disabled:opacity-50",
              "focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            )}
          />
        </div>

        <div
          role="group"
          aria-label={t("list.icon.dropZoneAria")}
          tabIndex={disabled ? -1 : 0}
          onPaste={onPaste}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = firstImageFile(e.dataTransfer);
            if (file) void takeImage(file);
            else setError(t("list.icon.dropNoImage"));
          }}
          className={cn(
            "flex-1 min-w-48 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[11px] text-gray-500 transition-colors",
            dragOver ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-200" : "border-white/[0.12] bg-black/20",
            ring
          )}
        >
          <ImagePlus className="w-4 h-4 flex-shrink-0" aria-hidden />
          <span className="flex-1">{busy ? t("list.icon.resizing") : t("list.icon.pasteOrDrop")}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className={cn("flex-shrink-0 px-2.5 py-1 rounded-lg text-xs text-gray-300 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40", ring)}
          >
            {t("list.icon.chooseImage")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              e.target.value = "";
              void takeImage(file);
            }}
          />
        </div>

        <button
          type="button"
          disabled={resolved === null || busy}
          onClick={() => {
            setError(null);
            onChange(undefined);
          }}
          className={cn(
            "self-center inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400",
            ring
          )}
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden />
          {t("common.remove")}
        </button>
      </div>

      <p id={hintId} className="text-[11px] text-gray-600">
        {t("list.icon.hint", { pixels: ICON_PIXELS })}
      </p>
      {error && (
        <p role="alert" className="text-[11px] text-red-400">
          {error}
        </p>
      )}
    </fieldset>
  );
}
