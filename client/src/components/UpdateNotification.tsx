import { useState, useEffect, useRef, useCallback } from "react";
import { Download, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { backend } from "@/lib/backend";
import { toast } from "@/components/ui/Toast";
import { useT } from "@/i18n";

interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
}

/**
 * Call a desktop command. `withGlobalTauri` is off, so `window.__TAURI__` does
 * not exist. The module loads on demand, and only in the desktop build.
 */
async function desktopInvoke<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

export function UpdateNotification() {
  const { t } = useT();
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const checkingRef = useRef(false);

  const checkForUpdates = useCallback(async () => {
    if (checkingRef.current || !backend.isDesktop()) return;

    checkingRef.current = true;
    try {
      const result = await desktopInvoke<UpdateInfo | null>("check_for_updates");
      if (result) {
        setUpdateAvailable(result);
        setDismissed(false);
      }
    } catch {
      // The updater is unavailable (dev build, no network, no release feed).
      // That is an expected state, so it stays silent.
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Only run in desktop mode
    if (!backend.isDesktop()) return;

    // Check for updates on mount
    void checkForUpdates();

    // Check again every 6 hours
    const interval = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkForUpdates]);

  const installUpdate = async () => {
    if (installing) return;

    setInstalling(true);
    try {
      await desktopInvoke<void>("install_update");
      // App will restart automatically after update
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t("app.update.installFailed", { message }));
      setInstalling(false);
    }
  };

  if (!updateAvailable || dismissed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        role="status"
        aria-live="polite"
        className="fixed top-4 right-4 z-50 w-96 backdrop-blur-xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                <Download className="w-4 h-4 text-cyan-400" aria-hidden="true" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">{t("app.update.available")}</h3>
                <p className="text-xs text-gray-400">{t("app.update.version", { version: updateAvailable.version })}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label={t("app.update.dismiss")}
              title={t("app.update.dismissTitle")}
              className="text-gray-500 hover:text-gray-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
              disabled={installing}
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          {updateAvailable.body && (
            <p className="text-xs text-gray-400 mb-3 line-clamp-2">
              {updateAvailable.body}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={installUpdate}
              disabled={installing}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white text-xs font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  {t("app.update.installing")}
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  {t("app.update.installAndRelaunch")}
                </>
              )}
            </button>
            <button
              onClick={() => setDismissed(true)}
              disabled={installing}
              className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-gray-300 text-xs font-semibold transition-all disabled:opacity-50"
            >
              {t("app.update.later")}
            </button>
          </div>
        </div>

        {/* Progress indicator */}
        {installing && (
          <div className="h-1 bg-gradient-to-r from-cyan-500 to-blue-500 animate-pulse" />
        )}
      </motion.div>
    </AnimatePresence>
  );
}
