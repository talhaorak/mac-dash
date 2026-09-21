/** English source strings. Flat dotted keys, grouped by area. */
export const enApp = {
  // nav (shared by Sidebar, the quick switcher, and the document title)
  "app.nav.main": "Main navigation",
  "app.nav.dashboard": "Dashboard",
  "app.nav.services": "Services",
  "app.nav.processes": "Processes",
  "app.nav.logs": "Logs",
  "app.nav.plugins": "Plugins",

  // toasts: launchd job changes
  "app.toast.jobFailed": "launchd job failed: {label}",
  "app.toast.jobFailedExit": "launchd job failed: {label} (exit {status})",
  "app.toast.jobAdded": "launchd job added: {label}",
  "app.toast.jobChanged": "launchd job changed: {label}",
  "app.toast.jobRemoved": "launchd job removed: {label}",

  // toaster (ui/Toast.tsx)
  "app.toast.notifications": "Notifications",
  "app.toast.dismiss": "Dismiss notification",
  "app.toast.success": "Success",

  // sidebar
  "app.sidebar.newJobChanges.one": "{label}, {count} new job change",
  "app.sidebar.newJobChanges.other": "{label}, {count} new job changes",
  "app.sidebar.liveWs": "Live (WS)",
  "app.sidebar.livePoll": "Live (Poll)",
  "app.sidebar.connected": "Connected",
  "app.sidebar.noData": "No data",
  "app.sidebar.connectionTitle": "Connection: {status}",
  "app.sidebar.toggle": "Toggle sidebar",
  "app.sidebar.expand": "Expand sidebar",
  "app.sidebar.collapse": "Collapse sidebar",
  "app.sidebar.systemManager": "system manager",

  // quick switcher ("Go to…")
  "app.switcher.placeholder": "Go to a page or a launchd job…",
  "app.switcher.pageBadge": "Page",
  "app.switcher.results.one": "{count} result",
  "app.switcher.results.other": "{count} results",
  "app.switcher.resultsLimited.one": "{count} result (first {max})",
  "app.switcher.resultsLimited.other": "{count} results (first {max})",
  "app.switcher.resultsGroup": "Results",
  "app.switcher.noMatches": "Nothing matches \"{query}\".",
  "app.switcher.pagesGroup": "Pages",
  "app.switcher.jobsGroup": "Jobs",
  "app.switcher.hintMove": "move",
  "app.switcher.hintOpen": "open",
  "app.switcher.hintClose": "close",

  // access token gate
  "app.authGate.connecting": "Connecting",
  "app.authGate.subtitle": "This server is open to the network and asks for its access token.",
  "app.authGate.tokenLabel": "Access token",
  "app.authGate.rejected": "The server rejected this token.",
  "app.authGate.hint": "The server prints the token when it starts. It is also in {path} on the Mac that runs it.",
  "app.authGate.checking": "Checking…",
  "app.authGate.unlock": "Unlock",

  // update notification
  "app.update.available": "Update Available",
  "app.update.version": "Version {version}",
  "app.update.dismiss": "Dismiss update notification",
  "app.update.dismissTitle": "Dismiss",
  "app.update.installing": "Installing...",
  "app.update.installAndRelaunch": "Install & Relaunch",
  "app.update.later": "Later",
  "app.update.installFailed": "Failed to install update: {message}",

  // plugin renderer
  "app.plugin.loading": "Loading plugin...",
  "app.plugin.loadFailed": "Failed to load plugin",

  // ui/ConfirmButton.tsx
  "app.confirmButton.clickAgain": "Click again to confirm",

  // ui/CopyButton.tsx
  "app.copyButton.copyToClipboard": "Copy to clipboard",

  // ui/MiniChart.tsx
  "app.miniChart.trendLabel": "Trend",
  "app.miniChart.noData": "{label}: no data yet",
  "app.miniChart.summary": "{label}: latest {value}%, scale 0 to 100%",
} as const;
