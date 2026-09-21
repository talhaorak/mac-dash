import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJobEventsStore, useJobMetaStore, useJobPlists, useJobPlistsStore, useNavStore, useServicesStore, type ServiceInfo } from "@/stores/app";
import { GlowCard } from "@/components/ui/GlowCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useConfirm } from "@/components/ui/ConfirmButton";
import { toast } from "@/components/ui/Toast";
import { JobEditor, type JobEditorTarget } from "@/components/jobs/JobEditor";
import { JobDetailDrawer } from "@/components/jobs/JobDetailDrawer";
import { JobEventsDrawer, JobTimeline } from "@/components/jobs/JobPanels";
import { JobGridView } from "@/components/jobs/GridView";
import { JobListView } from "@/components/jobs/ListView";
import { JobRowActions, serviceKey, type ArmedAction } from "@/components/jobs/ListJobRowActions";
import { SmartFolderBar } from "@/components/jobs/SmartFolderBar";
import { DEFAULT_FOLDERS, SMART_FOLDERS_KEY, folderNeedsPlists, folderTitle, isAppleService, loadUserFolders, matchesFolder } from "@/components/jobs/SmartFolders";
import { InlineError, StartupExtrasCard } from "@/components/jobs/StartupPanels";
import { PowerSchedulePanel } from "@/components/jobs/PowerSchedulePanel";
import { ViewOptionsMenu, loadViewOptions, saveViewOptions, type ViewOptions } from "@/components/jobs/ViewOptions";
import { backend, metaKey, type ServiceAction } from "@/lib/backend";
import { DEFAULT_SERVICES_ROUTE, OWNER_FILTERS, STATUS_FILTERS, parseJobRef, type OwnerFilter, type RouteJobRef, type StatusFilter } from "@/lib/router";
import { cn } from "@/lib/utils";
import { formatNumber, useT, type TKey } from "@/i18n";
import { localizeTriggers, scopeTitle, templateDescription, templateTitle } from "@/i18n/launchd";
import { JOB_SCOPES, JOB_TEMPLATES, type JobCategory } from "@shared/launchd";
import { Bell, CalendarClock, ChevronDown, ChevronRight, EyeOff, LayoutGrid, List, Plus, Search, ShieldAlert, Table2 } from "lucide-react";

const categoryOrder: JobCategory[] = JOB_SCOPES.map((s) => s.category);

const OWNER_TITLE_KEYS: Record<OwnerFilter, TKey> = { all: "common.all", apple: "list.owner.apple", "third-party": "list.owner.thirdParty" };
const STATUS_TITLE_KEYS: Record<StatusFilter, TKey> = {
  all: "common.all",
  running: "status.running",
  stopped: "status.stopped",
  error: "status.error",
  disabled: "status.disabled",
};
const STATUS_WORD_KEYS: Record<ServiceInfo["status"], TKey> = {
  running: "status.running",
  stopped: "status.stopped",
  error: "status.error",
  unknown: "status.unknown",
};
const ACTION_DONE_KEYS: Record<ServiceAction, TKey> = {
  start: "list.toast.started",
  stop: "list.toast.stopped",
  restart: "list.toast.restarted",
  load: "list.toast.loaded",
  unload: "list.toast.unloaded",
  enable: "list.toast.enabled",
  disable: "list.toast.disabled",
};

const VIEWS = [
  { id: "groups", icon: List, labelKey: "list.views.groups" },
  { id: "list", icon: Table2, labelKey: "list.views.list" },
  { id: "grid", icon: LayoutGrid, labelKey: "list.views.grid" },
  { id: "timeline", icon: CalendarClock, labelKey: "list.views.timeline" },
] as const satisfies { id: string; icon: unknown; labelKey: TKey }[];

const ROWS_PER_GROUP = 250;

const findJob = (services: ServiceInfo[], ref: RouteJobRef) => services.find((s) => s.label === ref.label && (!ref.category || s.category === ref.category)) ?? null;

/**
 * The launchd jobs. What the page shows lives in the URL hash (lib/router.ts): view, filters, search text,
 * the job in the drawer, the open editor and the change history. A reload or a copied link restores all of it.
 * Filter changes replace the history entry. A drawer, the editor and the change history add one, so Back closes them.
 */
export function ServicesPage() {
  const { t, tn } = useT();
  const services = useServicesStore((s) => s.services);
  const loading = useServicesStore((s) => s.loading);
  const setServices = useServicesStore((s) => s.setServices);
  const route = useNavStore((s) => s.route);
  const patchServices = useNavStore((s) => s.patchServices);
  const navigateToProcess = useNavStore((s) => s.navigateToProcess);
  const navigateToLogs = useNavStore((s) => s.navigateToLogs);
  const transientEditor = useNavStore((s) => s.transientEditor);
  const openEditor = useNavStore((s) => s.openEditor);
  const closeEditor = useNavStore((s) => s.closeEditor);
  const unseenEvents = useJobEventsStore((s) => s.unseen);
  const meta = useJobMetaStore((s) => s.meta);
  const metaError = useJobMetaStore((s) => s.error);
  const metaLoading = useJobMetaStore((s) => s.loading);
  const loadMeta = useJobMetaStore((s) => s.load);
  const setOneMeta = useJobMetaStore((s) => s.setOne);
  const removeOneMeta = useJobMetaStore((s) => s.removeOne);

  const sr = route.page === "services" ? route : DEFAULT_SERVICES_ROUTE;

  // A late answer (a save that ends after the user left the page) must not pull the user back to Services.
  const patch = useCallback<typeof patchServices>(
    (fields, mode) => {
      if (useNavStore.getState().route.page === "services") patchServices(fields, mode);
    },
    [patchServices]
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["system-agents", "system-daemons"]));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [templateMenu, setTemplateMenu] = useState(false);
  const [viewOptions, setViewOptions] = useState(loadViewOptions);
  const [userFolders, setUserFolders] = useState(loadUserFolders);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, isArmed } = useConfirm<string>();

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // Another tab or window saved its smart folders: read them again.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SMART_FOLDERS_KEY) setUserFolders(loadUserFolders());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // The job of the drawer follows live updates because it is looked up on every render.
  // A link can arrive before the job list: the drawer opens as soon as the job is there.
  const selected = useMemo(() => (sr.job ? findJob(services, sr.job) : null), [services, sr.job]);

  const reportedMissing = useRef<RouteJobRef | null>(null);
  useEffect(() => {
    if (!sr.job || loading || services.length === 0) return;
    if (!selected) {
      // React runs an effect twice in development. One toast per reference is enough.
      if (reportedMissing.current !== sr.job) toast.info(t("list.toast.jobNotFound", { label: sr.job.label }));
      reportedMissing.current = sr.job;
      patch({ job: null });
    } else if (!sr.job.category) {
      // The short form `job=<label>` becomes the full reference, so the link names one job.
      patch({ job: { label: selected.label, category: selected.category } });
    }
  }, [sr.job, selected, loading, services.length, patch, t]);

  const folder = useMemo(() => (sr.folder ? ([...DEFAULT_FOLDERS, ...userFolders].find((f) => f.id === sr.folder) ?? null) : null), [sr.folder, userFolders]);

  // A link to a folder that this browser does not have.
  useEffect(() => {
    if (sr.folder && !folder) patch({ folder: null });
  }, [sr.folder, folder, patch]);

  const folderNeeds = folder !== null && folderNeedsPlists(folder);
  const jobPlists = useJobPlists(folderNeeds);
  const plists = jobPlists.plists;
  const folderPending = folderNeeds && plists === null && !jobPlists.error;

  // The editor takes a complete job reference. The short form waits for the job list.
  const editorCategory = sr.editor && sr.editor.mode !== "new" ? (sr.editor.job.category ?? findJob(services, sr.editor.job)?.category ?? null) : null;
  const routeEditorTarget = useMemo<JobEditorTarget | null>(() => {
    if (!sr.editor) return null;
    if (sr.editor.mode === "new") return { mode: "new", templateId: sr.editor.templateId };
    return editorCategory ? { mode: sr.editor.mode, job: { label: sr.editor.job.label, category: editorCategory } } : null;
  }, [sr.editor, editorCategory]);
  // A target that the URL cannot hold (a job built from a dropped file) comes from the store.
  const editorTarget = transientEditor ?? routeEditorTarget;

  const openJob = useCallback(
    (key: string) => {
      const job = parseJobRef(key);
      if (job) patch({ job }, "push");
    },
    [patch]
  );

  const changeViewOptions = (next: ViewOptions) => {
    setViewOptions(next);
    saveViewOptions(next);
  };

  const refresh = useCallback(async () => {
    try {
      setServices((await backend.getServices()).services);
    } catch {
      // The next poll or WebSocket snapshot brings the list.
    }
  }, [setServices]);

  const handleAction = useCallback(
    async (action: ServiceAction, service: ServiceInfo) => {
      const key = `${action}:${serviceKey(service)}`;
      setBusy(key);
      try {
        await backend.manageService({ label: service.label, category: service.category }, action);
        toast.success(t(ACTION_DONE_KEYS[action], { label: service.label }));
      } catch (e) {
        toast.error(t("list.toast.actionError", { label: service.label, message: (e as Error).message }));
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh, t]
  );

  const requestAction = useCallback(
    (action: ServiceAction, service: ServiceInfo) => {
      // Stopping or disabling can take a daemon away from the system: ask twice.
      const destructive = action === "stop" || action === "disable" || action === "unload";
      if (destructive) confirm(`${action}:${serviceKey(service)}`, () => handleAction(action, service));
      else handleAction(action, service);
    },
    [confirm, handleAction]
  );

  const deleteJob = async (service: ServiceInfo) => {
    try {
      await backend.deleteJob({ label: service.label, category: service.category });
      toast.success(t("list.toast.movedToTrash", { label: service.label }));
      // Replace: Back must not return to a job that is gone.
      patch({ job: null });
      removeOneMeta(serviceKey(service));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      refresh();
    }
  };

  const allTags = useMemo(() => [...new Set(Object.values(meta).flatMap((m) => m.tags))].sort(), [meta]);
  // A linked tag stays visible as a chip while the notes are still loading, so the user can switch it off.
  const tagChips = sr.tag && !allTags.includes(sr.tag) ? [...allTags, sr.tag] : allTags;

  const filtered = useMemo(() => {
    const q = sr.q.trim().toLowerCase();
    const now = new Date();
    return services.filter((s) => {
      const m = meta[metaKey(s)];
      if (
        q &&
        !s.label.toLowerCase().includes(q) &&
        !s.program?.toLowerCase().includes(q) &&
        !s.plistPath?.toLowerCase().includes(q) &&
        !m?.notes.toLowerCase().includes(q) &&
        !m?.tags.some((tag) => tag.toLowerCase().includes(q))
      )
        return false;
      if (sr.status === "disabled" ? !s.disabled : sr.status !== "all" && s.status !== sr.status) return false;
      if (sr.owner === "apple" && !isAppleService(s)) return false;
      if (sr.owner === "third-party" && isAppleService(s)) return false;
      if (sr.tag && !m?.tags.includes(sr.tag)) return false;
      if (folder && !matchesFolder(s, m, folder, now, folderNeeds && plists ? (plists[metaKey(s)] ?? null) : undefined)) return false;
      return true;
    });
  }, [services, sr.q, sr.status, sr.owner, sr.tag, folder, folderNeeds, plists, meta]);

  const grouped = useMemo(() => {
    const groups: Partial<Record<JobCategory, ServiceInfo[]>> = {};
    for (const s of filtered) (groups[s.category] ??= []).push(s);
    return groups;
  }, [filtered]);

  const statusCounts = useMemo(() => {
    const c = { running: 0, stopped: 0, error: 0, unknown: 0, disabled: 0 };
    for (const s of services) {
      c[s.status]++;
      if (s.disabled) c.disabled++;
    }
    return c;
  }, [services]);

  const toggle = (set: Set<string>, update: (next: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  // A link or an earlier choice can set a filter whose control is hidden. The user must see it and be able to clear it.
  const hiddenFilters = [
    !viewOptions.statusFilter && sr.status !== "all" && t("list.filters.hiddenStatus", { value: t(STATUS_TITLE_KEYS[sr.status]) }),
    !viewOptions.ownerFilter && sr.owner !== "all" && t("list.filters.hiddenOwner", { value: t(OWNER_TITLE_KEYS[sr.owner]) }),
    !viewOptions.tagFilter && sr.tag && t("list.filters.hiddenTag", { value: sr.tag }),
    !viewOptions.smartFolders && folder && t("list.filters.hiddenSmartFolder", { value: folderTitle(folder) }),
  ].filter((text): text is string => typeof text === "string");

  const clearHiddenFilters = () =>
    patch({
      ...(!viewOptions.statusFilter && { status: "all" as const }),
      ...(!viewOptions.ownerFilter && { owner: "all" as const }),
      ...(!viewOptions.tagFilter && { tag: null }),
      ...(!viewOptions.smartFolders && { folder: null }),
    });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("list.header.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("list.header.summary", {
              total: tn("list.count.jobs", services.length),
              running: t("list.count.running", { count: formatNumber(statusCounts.running) }),
              failed: t("list.count.failed", { count: formatNumber(statusCounts.error) }),
            })}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div role="radiogroup" aria-label={t("list.header.viewLabel")} className="inline-flex rounded-xl bg-white/[0.04] p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={sr.view === v.id}
                onClick={() => patch({ view: v.id })}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
                  sr.view === v.id ? "bg-white/[0.08] text-gray-100" : "text-gray-500 hover:text-gray-300"
                )}
              >
                <v.icon className="w-3.5 h-3.5" aria-hidden />
                {t(v.labelKey)}
              </button>
            ))}
          </div>

          <ViewOptionsMenu value={viewOptions} onChange={changeViewOptions} />

          <button
            type="button"
            onClick={() => patch({ panel: "changes" }, "push")}
            className="relative inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06]"
          >
            <Bell className="w-3.5 h-3.5" aria-hidden />
            {t("list.header.changesButton")}
            {unseenEvents > 0 && (
              <span className="ml-1 min-w-4 h-4 px-1 rounded-full bg-amber-400 text-[10px] font-bold text-amber-950 inline-flex items-center justify-center">
                <span aria-hidden>{formatNumber(unseenEvents)}</span>
                <span className="sr-only">{tn("list.header.unseenChanges", unseenEvents)}</span>
              </span>
            )}
          </button>

          <div className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={templateMenu}
              onClick={() => setTemplateMenu(!templateMenu)}
              onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget) && setTemplateMenu(false)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-cyan-950 bg-cyan-400 hover:bg-cyan-300"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              {t("list.header.newJob")}
              <ChevronDown className="w-3 h-3" aria-hidden />
            </button>
            {templateMenu && (
              <div role="menu" className="absolute right-0 mt-1 w-72 z-40 glass rounded-xl border border-white/[0.08] p-1 shadow-2xl">
                {JOB_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setTemplateMenu(false);
                      openEditor({ mode: "new", templateId: tpl.id });
                    }}
                    onBlur={(e) => !e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget) && setTemplateMenu(false)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/[0.06]"
                  >
                    <div className="text-xs font-medium text-gray-200">{templateTitle(tpl)}</div>
                    <div className="text-[11px] text-gray-500">{templateDescription(tpl)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-52 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" aria-hidden />
          <input
            type="search"
            aria-label={t("list.header.searchAria")}
            placeholder={t("list.header.searchPlaceholder")}
            value={sr.q}
            maxLength={200}
            onChange={(e) => patch({ q: e.target.value })}
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all"
          />
        </div>

        {viewOptions.statusFilter && (
          <div className="flex gap-1" role="group" aria-label={t("list.filters.statusLabel")}>
            {STATUS_FILTERS.map((s) => (
              <FilterButton key={s} active={sr.status === s} tone="cyan" onClick={() => patch({ status: s })}>
                {t(STATUS_TITLE_KEYS[s])}
                {s !== "all" && <span className="ml-1 opacity-60">{formatNumber(statusCounts[s])}</span>}
              </FilterButton>
            ))}
          </div>
        )}

        {viewOptions.ownerFilter && (
          <div className="flex gap-1 border-l border-white/[0.06] pl-3" role="group" aria-label={t("list.filters.ownerLabel")}>
            {OWNER_FILTERS.map((value) => (
              <FilterButton key={value} active={sr.owner === value} tone="purple" onClick={() => patch({ owner: value })}>
                {t(OWNER_TITLE_KEYS[value])}
              </FilterButton>
            ))}
          </div>
        )}

        {viewOptions.tagFilter && tagChips.length > 0 && (
          <div className="flex gap-1 border-l border-white/[0.06] pl-3 flex-wrap" role="group" aria-label={t("list.filters.tagLabel")}>
            {tagChips.map((tag) => (
              <FilterButton key={tag} active={sr.tag === tag} tone="amber" onClick={() => patch({ tag: sr.tag === tag ? null : tag })}>
                #{tag}
              </FilterButton>
            ))}
          </div>
        )}
      </div>

      {hiddenFilters.length > 0 && (
        <div role="status" className="flex items-center gap-2 flex-wrap rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/90">
          <EyeOff className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" aria-hidden />
          <span className="flex-1 min-w-0">{t("list.filters.hiddenBanner", { list: hiddenFilters.join(", ") })}</span>
          <button
            type="button"
            onClick={clearHiddenFilters}
            className="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
          >
            {t("common.clear")}
          </button>
        </div>
      )}

      {metaError && <InlineError title={t("list.errors.metaReadFailed")} message={metaError} onRetry={loadMeta} retrying={metaLoading} />}

      {viewOptions.smartFolders ? (
        <SmartFolderBar
          services={services}
          meta={meta}
          userFolders={userFolders}
          onUserFoldersChange={setUserFolders}
          activeId={folder?.id ?? null}
          onChange={(id) => patch({ folder: id })}
        />
      ) : (
        // The bar shows this error itself. Without the bar the page must.
        folderNeeds &&
        jobPlists.error && (
          <InlineError
            title={plists ? t("list.errors.plistsRereadFailed") : t("list.errors.plistsReadFailed")}
            message={jobPlists.error}
            onRetry={jobPlists.retry}
            retrying={jobPlists.loading}
          />
        )
      )}

      {folderPending ? (
        <p className="text-sm text-gray-500 text-center py-10" aria-live="polite">
          {t("list.status.readingPlists")}
        </p>
      ) : sr.view === "timeline" ? (
        <JobTimeline services={filtered} onSelect={(s) => openJob(serviceKey(s))} />
      ) : sr.view === "list" ? (
        <JobListView
          services={filtered}
          meta={meta}
          loading={loading}
          busyKey={busy}
          isArmed={isArmed}
          onAction={requestAction}
          onSelect={openJob}
          onEdit={openEditor}
        />
      ) : sr.view === "grid" ? (
        <JobGridView services={filtered} meta={meta} loading={loading} onSelect={openJob} />
      ) : (
        <div className="space-y-3">
          {loading && services.length === 0 && <p className="text-sm text-gray-500 text-center py-10">{t("list.status.readingLaunchd")}</p>}
          {!loading && filtered.length === 0 && <p className="text-sm text-gray-500 text-center py-10">{t("list.status.noMatch")}</p>}

          {categoryOrder.map((category) => {
            const items = grouped[category];
            if (!items || items.length === 0) return null;
            const isCollapsed = collapsed.has(category);
            const showAll = expandedGroups.has(category);
            const visible = showAll ? items : items.slice(0, ROWS_PER_GROUP);

            return (
              <GlowCard key={category} padding="sm">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(collapsed, setCollapsed, category)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-white/[0.03] rounded-lg transition-colors"
                >
                  {isCollapsed ? <ChevronRight className="w-4 h-4 text-gray-500" aria-hidden /> : <ChevronDown className="w-4 h-4 text-gray-400" aria-hidden />}
                  <span className="text-sm font-semibold text-gray-300">{scopeTitle(category)}</span>
                  <span className="text-xs text-gray-600 ml-1">({formatNumber(items.length)})</span>
                  <span className="ml-auto text-xs text-green-400/70">
                    {t("list.count.running", { count: formatNumber(items.filter((s) => s.status === "running").length) })}
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    {visible.map((service) => {
                      const key = serviceKey(service);
                      return (
                        <ServiceRow
                          key={key}
                          service={service}
                          tags={meta[key]?.tags}
                          busy={busy !== null && busy.endsWith(`:${key}`)}
                          armedAction={(["stop", "disable"] as const).find((a) => isArmed(`${a}:${key}`)) ?? null}
                          onAction={requestAction}
                          onSelect={openJob}
                          onEdit={openEditor}
                        />
                      );
                    })}
                    {items.length > visible.length && (
                      <button
                        type="button"
                        onClick={() => toggle(expandedGroups, setExpandedGroups, category)}
                        className="w-full py-2 text-xs text-cyan-400 hover:bg-white/[0.03] rounded-lg"
                      >
                        {tn("list.count.showMore", items.length - visible.length)}
                      </button>
                    )}
                  </div>
                )}
              </GlowCard>
            );
          })}
        </div>
      )}

      {/* One instance for all job views, so an expanded card stays expanded when the view changes. */}
      {sr.view !== "timeline" && (viewOptions.startupCard || viewOptions.powerCard) && (
        <div className="space-y-3">
          {viewOptions.startupCard && <StartupExtrasCard />}
          {viewOptions.powerCard && <PowerSchedulePanel />}
        </div>
      )}

      <JobDetailDrawer
        service={selected}
        meta={selected ? meta[serviceKey(selected)] : undefined}
        onClose={() => patch({ job: null }, "push")}
        onEdit={() => selected && openEditor({ mode: "edit", job: { label: selected.label, category: selected.category } })}
        onDuplicate={() => selected && openEditor({ mode: "duplicate", job: { label: selected.label, category: selected.category } })}
        onDelete={() => selected && deleteJob(selected)}
        onMetaSaved={(m) => selected && setOneMeta(serviceKey(selected), m)}
        onNavigateToProcess={navigateToProcess}
        onViewLogs={(name) => navigateToLogs(name)}
      />

      <JobEventsDrawer
        open={sr.panel === "changes"}
        onClose={() => patch({ panel: null }, "push")}
        onOpenJob={(event) => patch({ panel: null, job: { label: event.label, category: event.category } }, "push")}
      />

      <JobEditor
        target={editorTarget}
        onClose={() => {
          closeEditor();
          refresh();
          // A saved job can have other keys now: the launchd-key folders must not wait for the cache to expire.
          const plistsStore = useJobPlistsStore.getState();
          if (plistsStore.plists !== null) plistsStore.ensure(services.length, { force: true });
        }}
      />
    </div>
  );
}

function FilterButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "cyan" | "purple" | "amber";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tones = {
    cyan: "bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30",
    purple: "bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30",
    amber: "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30",
  };
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
        active ? tones[tone] : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
      )}
    >
      {children}
    </button>
  );
}

const ServiceRow = memo(function ServiceRow({
  service,
  tags,
  busy,
  armedAction,
  onAction,
  onSelect,
  onEdit,
}: {
  service: ServiceInfo;
  tags: string[] | undefined;
  busy: boolean;
  armedAction: ArmedAction | null;
  onAction: (action: ServiceAction, service: ServiceInfo) => void;
  onSelect: (key: string) => void;
  onEdit: (target: JobEditorTarget) => void;
}) {
  const { t } = useT();
  const stateWord = service.disabled ? t("status.disabled") : t(STATUS_WORD_KEYS[service.status]);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("list.actions.openDetailsAria", { text: `${service.label}, ${stateWord}` })}
      onClick={() => onSelect(serviceKey(service))}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(serviceKey(service));
        }
      }}
      className={cn(
        "flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/[0.03] transition-colors group text-xs cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
        service.disabled && "opacity-50"
      )}
    >
      <StatusBadge status={service.status} label="" size="sm" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-200 font-medium truncate font-mono text-[12px]">{service.label}</span>
          {service.disabled && <Badge tone="amber">{t("status.disabled")}</Badge>}
          {(service.unreadable || service.quarantined) && (
            <span title={service.unreadable ? t("list.badge.unreadableTitle") : t("list.badge.quarantinedTitle")} className="text-red-400 flex-shrink-0">
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
              <span className="sr-only">{service.unreadable ? t("list.badge.unreadableShort") : t("list.badge.quarantinedShort")}</span>
            </span>
          )}
          {tags?.map((tag) => (
            <Badge key={tag} tone="gray">
              #{tag}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-600 min-w-0">
          {service.program && (
            <span className="truncate" title={service.program}>
              {service.program}
            </span>
          )}
          {service.triggers.length > 0 && <span className="flex-shrink-0 text-cyan-500/60">{localizeTriggers(service.triggers).join(" · ")}</span>}
        </div>
      </div>

      {service.pid !== null && <span className="text-gray-600 font-mono text-[10px] flex-shrink-0">PID {service.pid}</span>}

      <JobRowActions
        service={service}
        busy={busy}
        armedAction={armedAction}
        onAction={onAction}
        onEdit={onEdit}
        className={cn("transition-opacity", armedAction ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}
      />
    </div>
  );
});

function Badge({ tone, children }: { tone: "amber" | "gray"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex-shrink-0 px-1.5 py-px rounded text-[9px] font-medium",
        tone === "amber" ? "bg-amber-500/15 text-amber-400" : "bg-white/[0.06] text-gray-400"
      )}
    >
      {children}
    </span>
  );
}
