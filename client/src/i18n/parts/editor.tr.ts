import type { enEditor } from "./editor.en";

export const trEditor: Record<keyof typeof enEditor, string> = {
  // dialog
  "editor.dialog.ariaLabel": "launchd iş düzenleyicisi",
  "editor.dialog.closeAria": "Düzenleyiciyi kapat",

  // title
  "editor.title.new": "Yeni iş",
  "editor.title.duplicate": "İşi çoğalt",
  "editor.title.view": "İşi görüntüle",
  "editor.title.edit": "İşi düzenle",

  // field
  "editor.field.labelName": "Etiket (ad)",
  "editor.field.runsFor": "Çalışma kapsamı",
  "editor.field.file": "Dosya:",
  "editor.field.adminPasswordNote": "Kaydetme, yönetici parolası ister.",
  "editor.field.program": "Program",
  "editor.field.scriptPath": "Betik yolu",
  "editor.field.application": "Uygulama",
  "editor.field.scriptPathPlaceholder": "/Users/you/bin/backup.sh",
  "editor.field.shortcutName": "Kestirme adı",
  "editor.field.disabledKey": "Disabled anahtarı",
  "editor.field.disabledKeyHelp":
    "plist dosyasına Disabled=true yazar. Bunun yerine Etkinleştir/Devre dışı bırak eylemini kullanın: o, launchd'nin kendi geçersiz kılma veritabanını kullanır.",
  "editor.field.addDefaultPath": "Bu Mac'in varsayılan PATH değerini ekler; Homebrew ve /usr/local dahildir (launchd'nin kendi PATH'i /usr/bin:/bin:/usr/sbin:/sbin'dir)",

  // scope
  "editor.scope.me": "Ben",
  "editor.scope.allUsers": "Tüm kullanıcılar",
  "editor.scope.rootDaemon": "root (daemon)",

  // history
  "editor.history.groupAria": "Geçmiş",
  "editor.history.undoTitle": "Geri al (Cmd+Z). Bir metin alanının içindeyken Cmd+Z, o alandaki yazmayı geri alır.",
  "editor.history.redoTitle": "Yinele (Shift+Cmd+Z)",
  "editor.history.confirmDiscard": "Atmak için tekrar tıklayın",
  "editor.history.discardTitleEdit": "İşi diskteki haline geri döndür",
  "editor.history.discardTitleNew": "İşi düzenleyicinin açtığı haline geri döndür",
  "editor.history.discardChanges": "Değişiklikleri at",

  // tabs
  "editor.tabs.groupAria": "Düzenleyici modu",
  "editor.tabs.form": "Form",
  "editor.tabs.expert": "Uzman (XML)",
  "editor.tabs.revisions": "Sürümler",
  "editor.tabs.fixXmlFirst": "Önce XML hatasını düzeltin",

  // draft
  "editor.draft.bannerPrefix": "Kaydedilmemiş taslak:",
  "editor.draft.bannerNote": "Siz geri yükleyene veya atana kadar yeni değişiklikler taslak olarak tutulmaz.",
  "editor.draft.restore": "Geri yükle",
  "editor.draft.discard": "At",

  // body
  "editor.body.readingJob": "İş okunuyor…",
  "editor.body.coloursLabel": "Renkler",

  // theme names
  "editor.theme.default.name": "Varsayılan",
  "editor.theme.solarized.name": "Solarized",
  "editor.theme.monokai.name": "Monokai",
  "editor.theme.contrast.name": "Yüksek kontrast",

  // revisions
  "editor.revisions.empty": "Önceki sürüm yok. mac-dash, bu işin üzerine her yazdığında veya sildiğinde bir kopya tutar.",
  "editor.revisions.loadButton": "Düzenleyiciye yükle",

  // checks
  "editor.checks.title": "Kontroller",
  "editor.checks.errorCount.one": "{count} hata",
  "editor.checks.errorCount.other": "{count} hata",
  "editor.checks.warningCount.one": "{count} uyarı",
  "editor.checks.warningCount.other": "{count} uyarı",
  "editor.checks.noProblems": "Sorun bulunamadı.",

  // footer
  "editor.footer.readOnly": "Bu iş macOS'un bir parçasıdır ve salt okunurdur. Kendi sürümünüzü oluşturmak için çoğaltın.",
  "editor.footer.blocked": "Kaydetmek için engelleyici hataları düzeltin.",
  "editor.footer.hasErrors": "Hatalar var. Yine de kaydedebilirsiniz.",
  "editor.footer.autoPathTitle":
    "İş bir PATH belirtmediğinde, kaydetmeden önce bu Mac'in varsayılan PATH değeri EnvironmentVariables'a eklenir. launchd'nin kendi PATH'i /usr/bin:/bin:/usr/sbin:/sbin'dir. Yalnızca yeni ve çoğaltılan işler için geçerlidir.",
  "editor.footer.autoPathLabel": "PATH'i otomatik ekle",
  "editor.footer.saveOnlyTitle": "Dosyayı yaz ama launchd'ye yükleme",
  "editor.footer.saveOnly": "Yalnızca kaydet",
  "editor.footer.saveAndLoad": "Kaydet ve yükle",
  "editor.footer.manualRef": "Her alan kendi launchd anahtarını gösterir. Tam referans için Terminal'de {command} çalıştırın.",

  // confirm
  "editor.confirm.closeWithDraft":
    "Düzenleyici kaydetmeden kapatılsın mı?\n\nDeğişiklikleriniz bu Mac'te taslak olarak kalır. Düzenleyici, bu işi bir sonraki açışınızda onları geri yüklemeyi önerir.",
  "editor.confirm.closeNoChanges": "Düzenleyici kapatılsın mı? Bu işte değişiklik yapmadınız, bu yüzden taslak tutulmaz.",
  "editor.confirm.closeDraftLost": "Düzenleyici kapatılsın mı? Bu değişiklikler kaybolur.\n\n{when} tarihli önceki taslak kalır.",
  "editor.confirm.discardNoDraft":
    "Bu işteki değişiklikler atılsın mı?\n\nTaslak olarak tutulamazlar (200 KB üzeri, ya da tarayıcı depolaması kullanılamıyor).",

  // toast
  "editor.toast.discarded": "Değişiklikler atıldı. Geri al onları döndürür.",
  "editor.toast.draftRestored": "Taslak geri yüklendi. Uygulamak için kaydedin.",
  "editor.toast.revisionLoaded": "Sürüm düzenleyiciye yüklendi. Uygulamak için kaydedin.",
  "editor.toast.savedAndLoaded": "{label} kaydedildi ve yüklendi",
  "editor.toast.savedOnly": "{label} yüklenmeden kaydedildi",
  "editor.toast.pathAdded": "PATH eklendi.",

  // run
  "editor.run.label": "Çalıştır",
  "editor.run.kindGroupAria": "Çalıştırma türü",
  "editor.run.kind.command.title": "Komut",
  "editor.run.kind.command.hint": "Bir kabuk komut satırı. sh -c üzerinden çalışır; bu yüzden pipe'lar, && ve değişkenler çalışır.",
  "editor.run.kind.program.title": "Program",
  "editor.run.kind.program.hint": "Bir çalıştırılabilir dosya ve argümanları, launchd'ye oldukları gibi geçirilir.",
  "editor.run.kind.script.title": "Betik",
  "editor.run.kind.script.hint": "Seçtiğiniz yorumlayıcının çalıştırdığı bir betik dosyası.",
  "editor.run.kind.app.title": "Uygulama",
  "editor.run.kind.app.hint": "/usr/bin/open ile bir uygulama açar.",
  "editor.run.kind.shortcut.title": "Kestirme",
  "editor.run.kind.shortcut.hint": "Kestirmeler uygulamasından bir kestirme çalıştırır.",
  "editor.run.shellAria": "Shell",
  "editor.run.commandPlaceholder": 'örn. /usr/bin/rsync -a "$HOME/Documents" /Volumes/Backup',
  "editor.run.addArgument": "Argüman ekle",
  "editor.run.argumentPlaceholder": "argüman",
  "editor.run.programArgumentChoose": "Program argümanı",
  "editor.run.findFullPath": '"{name}" için tam yolu bul',
  "editor.run.resolvedTo": "{path} olarak çözümlendi",
  "editor.run.notFoundIn": '"{name}" şurada bulunamadı: {dirs}',
  "editor.run.interpreterAria": "Yorumlayıcı",
  "editor.run.appPlaceholder": "Safari  veya  /Applications/Safari.app",
  "editor.run.waitForQuit": "Uygulama kapanana kadar bekle ({flag}); böylece launchd yalnızca başlatıcıyı değil, uygulamayı izler",
  "editor.run.builtApp":
    "{path} oluşturuldu. Bu iş artık bu uygulamayı açıyor; çünkü macOS gizlilik izinlerini (Tam Disk Erişimi, Otomasyon) betiklere değil uygulamalara verir.",
  "editor.run.pickShortcut": "Bir kestirme seçin veya adını yazın",

  // wrap a script in an app
  "editor.wrapApp.button": "Bir uygulamaya sar…",
  "editor.wrapApp.description":
    "{path} oluşturur ve işi bu uygulamayı açacak şekilde değiştirir. Uygulama betik dosyasının kendisini çalıştırır: dosya çalıştırılabilir olmalı ve {shebang} satırıyla başlamalıdır.",
  "editor.wrapApp.nameLabel": "Uygulama adı",
  "editor.wrapApp.buildButton": "Uygulama oluştur",
  "editor.wrapApp.buildFailed": "Uygulama oluşturulamadı.",
  "editor.wrapApp.noPathReturned": "Arka uç, uygulamanın yolunu döndürmedi.",
  "editor.wrapApp.emptyName": "Uygulama için bir ad girin.",
  "editor.wrapApp.invalidName": "1 ila 64 harf, rakam, boşluk, nokta, tire veya alt çizgi kullanın. Bir harf veya rakamla başlayın.",

  // groups
  "editor.group.triggers": "Ne zaman",
  "editor.group.io": "Çıktı ve girdi",
  "editor.group.environment": "Ortam",
  "editor.group.identity": "Kullanıcı ve oturum",
  "editor.group.resources": "Kaynaklar ve sınırlar",
  "editor.group.advanced": "Gelişmiş",

  // sections
  "editor.section.countBadge": "{count} ayarlı",
  "editor.section.countBadgeTitle": "Bu bölümde ayarlanan anahtarlar",
  "editor.section.otherKeys": "Diğer anahtarlar",

  // key
  "editor.key.deprecated": "kullanımdan kaldırıldı",

  // add key
  "editor.addKey.label": "Anahtar ekle…",
  "editor.addKey.placeholder": "Anahtar adı, örneğin Sockets",
  "editor.addKey.typeAria": "Yeni anahtarın türü",
  "editor.addKey.typeFixedTitle": "Bu anahtarın türünü launchd belirler",
  "editor.addKey.undocumented": "Belgelenmiş bir launchd anahtarı değil. launchd bilmediği anahtarları yok sayar.",
  "editor.addKey.hint": "Liste, bu işin ayarlamadığı launchd anahtarlarını önerir. Başka bir ad olduğu gibi tutulur.",
  "editor.addKey.emptyName": "Anahtarın adını girin.",
  "editor.addKey.trimName": "Adın etrafındaki boşlukları kaldırın.",
  "editor.addKey.alreadyHasKey": 'İşte zaten "{name}" anahtarı var.',

  // path picker
  "editor.picker.kind.folder": "Klasör",
  "editor.picker.kind.app": "Uygulama",
  "editor.picker.kind.executable": "Çalıştırılabilir",
  "editor.picker.kind.file": "Dosya",
  "editor.picker.emptyFileName": "Bir dosya adı girin.",
  "editor.picker.slashInFileName": "Bir dosya adı eğik çizgi içeremez.",
  "editor.picker.invalidFileName": "Bu bir dosya adı değil.",
  "editor.picker.shortcut.home": "Giriş",
  "editor.picker.shortcut.applications": "Uygulamalar",
  "editor.picker.mode.file.title": "Bir dosya seç",
  "editor.picker.mode.folder.title": "Bir klasör seç",
  "editor.picker.mode.executable.title": "Bir çalıştırılabilir seç",
  "editor.picker.mode.app.title": "Bir uygulama seç",
  "editor.picker.mode.any.title": "Bir dosya veya klasör seç",
  "editor.picker.mode.file.hint": "Enter bir klasörü açar ya da bir dosya seçer.",
  "editor.picker.mode.folder.hint": 'Klasörü açın, ardından "Bu klasörü seç" düğmesine basın.',
  "editor.picker.mode.executable.hint": "Yalnızca çalıştırma izni olan dosyalar seçilebilir.",
  "editor.picker.mode.app.hint": "Enter bir klasörü açar ya da bir uygulama seçer.",
  "editor.picker.mode.any.hint": 'Enter bir dosya seçer. Bir klasör için: açın, ardından "Bu klasörü seç" düğmesine basın.',
  "editor.picker.badListing": "Arka uç, beklenmedik bir klasör listesi döndürdü.",
  "editor.picker.readError": "Klasör okunamadı.",
  "editor.picker.homeReadError": "Giriş klasörü okunamadı.",
  "editor.picker.backspaceHint": "Backspace üst klasörü açar.",
  "editor.picker.closeAria": "Dosya tarayıcısını kapat",
  "editor.picker.placesAria": "Konumlar",
  "editor.picker.pathAria": "Klasör yolu",
  "editor.picker.parentAria": "Üst klasörü aç",
  "editor.picker.parentTitle": "Üst klasör (Backspace)",
  "editor.picker.filterAria": "Bu klasörde filtrele",
  "editor.picker.showHidden": "Gizlileri göster",
  "editor.picker.contentsOf": "{path} içeriği",
  "editor.picker.folderContents": "Klasör içeriği",
  "editor.picker.reading": "Klasör okunuyor…",
  "editor.picker.noMatches": "Hiçbir şey eşleşmiyor. Filtreyi temizleyin veya gizli dosyaları gösterin.",
  "editor.picker.emptyFolder": "Bu klasör boş.",
  "editor.picker.hiddenSuffix": "gizli",
  "editor.picker.truncated": "Bu klasörde listenin gösterebileceğinden fazla öğe var. Öğe eksikse yolu elle yazın.",
  "editor.picker.newFilePlaceholder": "job.log",
  "editor.picker.newFileLabel": "Bu klasörde yeni dosya",
  "editor.picker.useFolderAndName": "Bu klasörü + dosya adını kullan",
  "editor.picker.chooseFolder": "Bu klasörü seç",
  "editor.picker.choose": "Seç",
  "editor.picker.chooseFieldAria": "Seç: {field}",
  "editor.picker.chooseEllipsis": "Seç…",

  // file drop
  "editor.drop.note.app": "Yeni iş: oturum açılışında bu uygulamayı aç.",
  "editor.drop.note.program": "Yeni iş: oturum açılışında bu programı çalıştır.",
  "editor.drop.note.script": "Yeni iş: oturum açılışında bu betiği çalıştır.",
  "editor.drop.note.watchFolder": "Yeni iş: bu klasör değiştiğinde bir komut çalıştır. Örnek komutu değiştirin.",
  "editor.drop.note.watchFile": "Bu dosya çalıştırılamaz. Yeni iş: dosya değiştiğinde bir komut çalıştır. Örnek komutu değiştirin.",
  "editor.drop.overlayTitleOne": "Bir iş oluşturmak için bırakın",
  "editor.drop.overlayTitleMany": "Bir kerede tek öğe bırakın",
  "editor.drop.overlayHintOne": "{name}: bir uygulama, program veya betik oturum açılışında çalışır. Bir klasör veya başka bir dosya değişiklikler için izlenir.",
  "editor.drop.overlayHintMany": "Tek bir uygulama, program, betik veya klasör için bir iş oluşturulur.",
  "editor.drop.cannotStart": "Bu öğe bir iş başlatamaz.",
  "editor.drop.inspectFailed": "Bırakılan öğe incelenemedi.",
  "editor.drop.oneAtATime": "Bir iş oluşturmak için bir kerede tek öğe bırakın.",
};
