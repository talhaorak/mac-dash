import { useMemo, useRef } from "react";
import { escapeXml } from "@shared/plist";

// Expert mode: a textarea with a syntax-coloured mirror behind it.
// Both layers share font metrics and scroll position. The textarea text is transparent.

const LAYER = "absolute inset-0 m-0 p-3 font-mono text-xs leading-5 whitespace-pre overflow-auto [tab-size:2]";

function highlight(xml: string): string {
  return escapeXml(xml)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span style="color:#6b7280">$1</span>')
    .replace(/(&lt;key&gt;)([^&]*)(&lt;\/key&gt;)/g, '$1<span style="color:#67e8f9">$2</span>$3')
    .replace(/(&lt;(?:string|integer|real|date|data)&gt;)([^<]*?)(&lt;\/)/g, '$1<span style="color:#fcd34d">$2</span>$3')
    .replace(/(&lt;\/?(?:[A-Za-z?]|!DOCTYPE)[^&]*?&gt;)/g, '<span style="color:#a78bfa">$1</span>');
}

export function XmlEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  const mirror = useRef<HTMLPreElement>(null);
  const html = useMemo(() => highlight(value) + "\n", [value]);

  return (
    <div className="relative h-full min-h-[320px] rounded-xl bg-black/40 border border-white/[0.08] overflow-hidden">
      <pre ref={mirror} aria-hidden className={`${LAYER} text-gray-300 pointer-events-none`} dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
        aria-label="Property list XML"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (!mirror.current) return;
          mirror.current.scrollTop = e.currentTarget.scrollTop;
          mirror.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || readOnly) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: start, selectionEnd: end } = el;
          onChange(value.slice(0, start) + "\t" + value.slice(end));
          requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
        }}
        className={`${LAYER} w-full h-full resize-none bg-transparent text-transparent caret-white selection:bg-cyan-500/30 focus:outline-none`}
      />
    </div>
  );
}
