import type { enApp } from "./app.en";

export const trApp: Record<keyof typeof enApp, string> = {
  // nav (shared by Sidebar, the quick switcher, and the document title)
  "app.nav.main": "Ana gezinme",
  "app.nav.dashboard": "Panel",
  "app.nav.services": "Servisler",
  "app.nav.processes": "İşlemler",
  "app.nav.logs": "Günlükler",
  "app.nav.plugins": "Eklentiler",

  // toasts: launchd job changes
  "app.toast.jobFailed": "launchd işi başarısız oldu: {label}",
  "app.toast.jobFailedExit": "launchd işi başarısız oldu: {label} (çıkış {status})",
  "app.toast.jobAdded": "launchd işi eklendi: {label}",
  "app.toast.jobChanged": "launchd işi değişti: {label}",
  "app.toast.jobRemoved": "launchd işi kaldırıldı: {label}",

  // toaster (ui/Toast.tsx)
  "app.toast.notifications": "Bildirimler",
  "app.toast.dismiss": "Bildirimi kapat",
  "app.toast.success": "Başarılı",

  // sidebar
  "app.sidebar.newJobChanges.one": "{label}, {count} yeni iş değişikliği",
  "app.sidebar.newJobChanges.other": "{label}, {count} yeni iş değişikliği",
  "app.sidebar.liveWs": "Canlı (WS)",
  "app.sidebar.livePoll": "Canlı (Poll)",
  "app.sidebar.connected": "Bağlı",
  "app.sidebar.noData": "Veri yok",
  "app.sidebar.connectionTitle": "Bağlantı: {status}",
  "app.sidebar.toggle": "Kenar çubuğunu aç/kapat",
  "app.sidebar.expand": "Kenar çubuğunu genişlet",
  "app.sidebar.collapse": "Kenar çubuğunu daralt",
  "app.sidebar.systemManager": "sistem yöneticisi",

  // quick switcher ("Go to…")
  "app.switcher.placeholder": "Bir sayfaya veya launchd işine git…",
  "app.switcher.pageBadge": "Sayfa",
  "app.switcher.results.one": "{count} sonuç",
  "app.switcher.results.other": "{count} sonuç",
  "app.switcher.resultsLimited.one": "{count} sonuç (ilk {max})",
  "app.switcher.resultsLimited.other": "{count} sonuç (ilk {max})",
  "app.switcher.resultsGroup": "Sonuçlar",
  "app.switcher.noMatches": "\"{query}\" ile eşleşen bir şey yok.",
  "app.switcher.pagesGroup": "Sayfalar",
  "app.switcher.jobsGroup": "İşler",
  "app.switcher.hintMove": "taşı",
  "app.switcher.hintOpen": "aç",
  "app.switcher.hintClose": "kapat",

  // access token gate
  "app.authGate.connecting": "Bağlanıyor",
  "app.authGate.subtitle": "Bu sunucu ağa açık ve erişim jetonu istiyor.",
  "app.authGate.tokenLabel": "Erişim jetonu",
  "app.authGate.rejected": "Sunucu bu jetonu reddetti.",
  "app.authGate.hint": "Sunucu başladığında jetonu yazdırır. Jeton ayrıca sunucuyu çalıştıran Mac'te {path} konumunda bulunur.",
  "app.authGate.checking": "Kontrol ediliyor…",
  "app.authGate.unlock": "Kilidi aç",

  // update notification
  "app.update.available": "Güncelleme Var",
  "app.update.version": "Sürüm {version}",
  "app.update.dismiss": "Güncelleme bildirimini kapat",
  "app.update.dismissTitle": "Kapat",
  "app.update.installing": "Yükleniyor...",
  "app.update.installAndRelaunch": "Yükle ve Yeniden Başlat",
  "app.update.later": "Sonra",
  "app.update.installFailed": "Güncelleme yüklenemedi: {message}",

  // plugin renderer
  "app.plugin.loading": "Eklenti yükleniyor...",
  "app.plugin.loadFailed": "Eklenti yüklenemedi",

  // ui/ConfirmButton.tsx
  "app.confirmButton.clickAgain": "Onaylamak için tekrar tıkla",

  // ui/CopyButton.tsx
  "app.copyButton.copyToClipboard": "Panoya kopyala",

  // ui/MiniChart.tsx
  "app.miniChart.trendLabel": "Eğilim",
  "app.miniChart.noData": "{label}: henüz veri yok",
  "app.miniChart.summary": "{label}: son değer %{value}, ölçek 0 ile 100 arası",
};
