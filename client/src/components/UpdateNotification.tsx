import { useState, useEffect } from "react";
import { Download, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { backend } from "@/lib/backend";

interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
}

export function UpdateNotification() {
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Only run in desktop mode
    if (!backend.isDesktop()) return;

    // Check for updates on mount
    checkForUpdates();

    // Check again every 6 hours
    const interval = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const checkForUpdates = async () => {
    if (checking || !backend.isDesktop()) return;
    
    setChecking(true);
    try {
      const result = await (window as any).__TAURI__.core.invoke("check_for_updates");
      if (result) {
        setUpdateAvailable(result);
        setDismissed(false);
      }
    } catch (err) {
      console.warn("Update check failed:", err);
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    if (installing) return;
    
    setInstalling(true);
    try {
      await (window as any).__TAURI__.core.invoke("install_update");
      // App will restart automatically after update
    } catch (err) {
      console.error("Update installation failed:", err);
      alert(`Failed to install update: ${err}`);
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
        className="fixed top-4 right-4 z-50 w-96 backdrop-blur-xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                <Download className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Update Available</h3>
                <p className="text-xs text-gray-400">Version {updateAvailable.version}</p>
              </div>
            </div>
            <button
              onClick={() => setDismissed(true)}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              disabled={installing}
            >
              <X className="w-4 h-4" />
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
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  Install & Relaunch
                </>
              )}
            </button>
            <button
              onClick={() => setDismissed(true)}
              disabled={installing}
              className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-gray-300 text-xs font-semibold transition-all disabled:opacity-50"
            >
              Later
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
