import { useMemo, useState } from "react";
import { FolderSearch, Pencil, Plus } from "lucide-react";
import { toast } from "@/components/ui/Toast";
import { metaKey, type JobMeta } from "@/lib/backend";
import { useJobPlists, type ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { formatNumber, useT } from "@/i18n";
import { SmartFolderEditor } from "./SmartFolderEditor";
import { DEFAULT_FOLDERS, folderNeedsPlists, folderTitle, matchesFolder, saveUserFolders, type SmartFolder } from "./SmartFolders";
import { InlineError } from "./StartupPanels";

export interface SmartFolderBarProps {
  /** All jobs, before any filter. The chips show how many jobs each folder holds. */
  services: ServiceInfo[];
  /** Notes and tags by `metaKey`. */
  meta: Record<string, JobMeta>;
  /** The user's folders. The owner keeps them in state, so it can find the active folder by id. */
  userFolders: SmartFolder[];
  /** Called after a save or a delete. The bar has already written the new list to localStorage. */
  onUserFoldersChange: (folders: SmartFolder[]) => void;
  /** Id of the selected folder (built-in or user), or null for "no folder". */
  activeId: string | null;
  /** Called with the folder id on select and with null on deselect. */
  onChange: (id: string | null) => void;
}

/**
 * Chip row of smart folders. Built-in folders come first and cannot be changed.
 * The user's folders live in localStorage (`macdash.smartFolders`). This component writes them and hosts the editor.
 * The plists of the jobs are loaded only when a folder has a rule over a launchd key.
 */
export function SmartFolderBar({ services, meta, userFolders, onUserFoldersChange, activeId, onChange }: SmartFolderBarProps) {
  const { t, tn } = useT();
  const [editing, setEditing] = useState<{ folder: SmartFolder | null } | null>(null);

  const folders = useMemo(() => [...DEFAULT_FOLDERS, ...userFolders], [userFolders]);
  const tags = useMemo(() => [...new Set(Object.values(meta).flatMap((m) => m.tags))].sort(), [meta]);
  const jobPlists = useJobPlists(folders.some(folderNeedsPlists));
  const plists = jobPlists.plists;

  /** Number of jobs per folder. Null while the plists that the folder needs are not here. */
  const counts = useMemo(() => {
    const now = new Date();
    return new Map(
      folders.map((f): [string, number | null] => {
        const needsPlists = folderNeedsPlists(f);
        if (needsPlists && !plists) return [f.id, null];
        const plistOf = (s: ServiceInfo) => (needsPlists ? (plists![metaKey(s)] ?? null) : undefined);
        return [f.id, services.reduce((n, s) => n + (matchesFolder(s, meta[metaKey(s)], f, now, plistOf(s)) ? 1 : 0), 0)];
      })
    );
  }, [folders, services, meta, plists]);

  const store = (next: SmartFolder[]) => {
    saveUserFolders(next);
    onUserFoldersChange(next);
  };

  const save = (folder: SmartFolder) => {
    const exists = userFolders.some((f) => f.id === folder.id);
    store(exists ? userFolders.map((f) => (f.id === folder.id ? folder : f)) : [...userFolders, folder]);
    // A new folder becomes the selection, so the user sees its content at once.
    if (!exists) onChange(folder.id);
    setEditing(null);
    toast.success(t("list.smartFolders.savedToast", { name: folder.name }));
  };

  const remove = (id: string) => {
    const folder = userFolders.find((f) => f.id === id);
    store(userFolders.filter((f) => f.id !== id));
    if (activeId === id) onChange(null);
    setEditing(null);
    if (folder) toast.success(t("list.smartFolders.deletedToast", { name: folder.name }));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={t("list.smartFolders.groupLabel")}>
        <span className="inline-flex items-center gap-1.5 pr-1 text-[11px] font-medium uppercase tracking-wide text-gray-600">
          <FolderSearch className="w-3.5 h-3.5" aria-hidden />
          {t("list.smartFolders.groupLabel")}
        </span>

        {folders.map((folder) => {
          const selected = activeId === folder.id;
          const count = counts.get(folder.id) ?? null;
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
                onClick={() => onChange(selected ? null : folder.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
              >
                {folderTitle(folder)}
                <span className="ml-1 opacity-60">
                  {count !== null ? (
                    <>
                      <span aria-hidden>{formatNumber(count)}</span>
                      <span className="sr-only">{tn("list.count.jobs", count)}</span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden>{jobPlists.error ? "–" : "…"}</span>
                      <span className="sr-only">{jobPlists.error ? t("list.smartFolders.countUnknown") : t("list.smartFolders.counting")}</span>
                    </>
                  )}
                </span>
              </button>
              {!folder.builtin && (
                <button
                  type="button"
                  onClick={() => setEditing({ folder })}
                  aria-label={t("list.smartFolders.editAria", { name: folderTitle(folder) })}
                  title={t("list.smartFolders.editOrDelete")}
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
          {t("list.smartFolders.newFolder")}
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
      {jobPlists.error && (
        <InlineError
          title={plists ? t("list.errors.plistsRereadFailedKeyFolders") : t("list.errors.plistsReadFailedKeyFolders")}
          message={jobPlists.error}
          onRetry={jobPlists.retry}
          retrying={jobPlists.loading}
        />
      )}
    </div>
  );
}
