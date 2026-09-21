import { useMemo, useState } from "react";
import { FolderSearch, Pencil, Plus } from "lucide-react";
import { toast } from "@/components/ui/Toast";
import { metaKey, type JobMeta } from "@/lib/backend";
import type { ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { SmartFolderEditor } from "./SmartFolderEditor";
import { DEFAULT_FOLDERS, loadUserFolders, matchesFolder, saveUserFolders, type SmartFolder } from "./SmartFolders";

export interface SmartFolderBarProps {
  /** All jobs, before any filter. The chips show how many jobs each folder holds. */
  services: ServiceInfo[];
  /** Notes and tags by `metaKey`. */
  meta: Record<string, JobMeta>;
  /** The selected folder, or null for "no folder". */
  active: SmartFolder | null;
  /** Called on select, on deselect (null), and with the new version after the active folder was edited. */
  onChange: (folder: SmartFolder | null) => void;
}

/**
 * Chip row of smart folders. Built-in folders come first and cannot be changed.
 * The user's folders live in localStorage (`macdash.smartFolders`). This component owns them and hosts the editor.
 */
export function SmartFolderBar({ services, meta, active, onChange }: SmartFolderBarProps) {
  const [userFolders, setUserFolders] = useState(loadUserFolders);
  const [editing, setEditing] = useState<{ folder: SmartFolder | null } | null>(null);

  const folders = useMemo(() => [...DEFAULT_FOLDERS, ...userFolders], [userFolders]);
  const tags = useMemo(() => [...new Set(Object.values(meta).flatMap((m) => m.tags))].sort(), [meta]);

  const counts = useMemo(() => {
    const now = new Date();
    return new Map(folders.map((f) => [f.id, services.reduce((n, s) => n + (matchesFolder(s, meta[metaKey(s)], f, now) ? 1 : 0), 0)]));
  }, [folders, services, meta]);

  const store = (next: SmartFolder[]) => {
    setUserFolders(next);
    saveUserFolders(next);
  };

  const save = (folder: SmartFolder) => {
    const exists = userFolders.some((f) => f.id === folder.id);
    store(exists ? userFolders.map((f) => (f.id === folder.id ? folder : f)) : [...userFolders, folder]);
    // A new folder becomes the selection, so the user sees its content at once.
    if (!exists || active?.id === folder.id) onChange(folder);
    setEditing(null);
    toast.success(`Smart folder "${folder.name}" saved`);
  };

  const remove = (id: string) => {
    const folder = userFolders.find((f) => f.id === id);
    store(userFolders.filter((f) => f.id !== id));
    if (active?.id === id) onChange(null);
    setEditing(null);
    if (folder) toast.success(`Smart folder "${folder.name}" deleted`);
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Smart folders">
      <span className="inline-flex items-center gap-1.5 pr-1 text-[11px] font-medium uppercase tracking-wide text-gray-600">
        <FolderSearch className="w-3.5 h-3.5" aria-hidden />
        Smart folders
      </span>

      {folders.map((folder) => {
        const selected = active?.id === folder.id;
        const count = counts.get(folder.id) ?? 0;
        return (
          <span
            key={folder.id}
            className={cn(
              "inline-flex items-center rounded-lg transition-all",
              selected ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30" : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
            )}
          >
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : folder)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
            >
              {folder.name}
              <span className="ml-1 opacity-60">
                {count}
                <span className="sr-only"> jobs</span>
              </span>
            </button>
            {!folder.builtin && (
              <button
                type="button"
                onClick={() => setEditing({ folder })}
                aria-label={`Edit smart folder ${folder.name}`}
                title="Edit or delete"
                className="p-1.5 -ml-1.5 rounded-lg opacity-60 hover:opacity-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cyan-500/50"
              >
                <Pencil className="w-3 h-3" aria-hidden />
              </button>
            )}
          </span>
        );
      })}

      <button
        type="button"
        onClick={() => setEditing({ folder: null })}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] border border-dashed border-white/[0.08] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
      >
        <Plus className="w-3 h-3" aria-hidden />
        New smart folder…
      </button>

      <SmartFolderEditor
        open={editing !== null}
        folder={editing?.folder ?? null}
        services={services}
        meta={meta}
        tags={tags}
        onSave={save}
        onDelete={remove}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
