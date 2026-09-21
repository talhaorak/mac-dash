/** Job editor: JobEditor, JobForm, PathPicker, FileDrop, script-app wrapping, editor themes. */
export const enEditor = {
  // dialog
  "editor.dialog.ariaLabel": "launchd job editor",
  "editor.dialog.closeAria": "Close editor",

  // title
  "editor.title.new": "New job",
  "editor.title.duplicate": "Duplicate job",
  "editor.title.view": "View job",
  "editor.title.edit": "Edit job",

  // field
  "editor.field.labelName": "Label (name)",
  "editor.field.runsFor": "Runs for",
  "editor.field.file": "File:",
  "editor.field.adminPasswordNote": "Saving asks for an administrator password.",
  "editor.field.program": "Program",
  "editor.field.scriptPath": "Script path",
  "editor.field.application": "Application",
  "editor.field.scriptPathPlaceholder": "/Users/you/bin/backup.sh",
  "editor.field.shortcutName": "Shortcut name",
  "editor.field.disabledKey": "Disabled key",
  "editor.field.disabledKeyHelp": "Writes Disabled=true into the plist. Prefer the Enable/Disable action: it uses launchd's own override database.",
  "editor.field.addDefaultPath": "Add the default PATH of this Mac, with Homebrew and /usr/local (launchd's own PATH is /usr/bin:/bin:/usr/sbin:/sbin)",

  // scope
  "editor.scope.me": "Me",
  "editor.scope.allUsers": "All users",
  "editor.scope.rootDaemon": "root (daemon)",

  // history
  "editor.history.groupAria": "History",
  "editor.history.undoTitle": "Undo (Cmd+Z). Inside a text field, Cmd+Z undoes the typing in that field.",
  "editor.history.redoTitle": "Redo (Shift+Cmd+Z)",
  "editor.history.confirmDiscard": "Click again to discard",
  "editor.history.discardTitleEdit": "Go back to the job as it is on disk",
  "editor.history.discardTitleNew": "Go back to the job as the editor opened it",
  "editor.history.discardChanges": "Discard changes",

  // tabs
  "editor.tabs.groupAria": "Editor mode",
  "editor.tabs.form": "Form",
  "editor.tabs.expert": "Expert (XML)",
  "editor.tabs.revisions": "Revisions",
  "editor.tabs.fixXmlFirst": "Fix the XML error first",

  // draft
  "editor.draft.bannerPrefix": "Unsaved draft from",
  "editor.draft.bannerNote": "New edits are not kept as a draft until you restore or discard it.",
  "editor.draft.restore": "Restore",
  "editor.draft.discard": "Discard",

  // body
  "editor.body.readingJob": "Reading the job…",
  "editor.body.coloursLabel": "Colours",

  // theme names (rendered with a fallback to the literal English name; see editorThemes.ts)
  "editor.theme.default.name": "Default",
  "editor.theme.solarized.name": "Solarized",
  "editor.theme.monokai.name": "Monokai",
  "editor.theme.contrast.name": "High contrast",

  // revisions
  "editor.revisions.empty": "No earlier versions. mac-dash keeps a copy every time it overwrites or deletes this job.",
  "editor.revisions.loadButton": "Load into editor",

  // checks
  "editor.checks.title": "Checks",
  "editor.checks.errorCount.one": "{count} error",
  "editor.checks.errorCount.other": "{count} errors",
  "editor.checks.warningCount.one": "{count} warning",
  "editor.checks.warningCount.other": "{count} warnings",
  "editor.checks.noProblems": "No problems found.",

  // footer
  "editor.footer.readOnly": "This job is part of macOS and is read-only. Duplicate it to make your own version.",
  "editor.footer.blocked": "Fix the blocking errors to save.",
  "editor.footer.hasErrors": "There are errors. You can still save.",
  "editor.footer.autoPathTitle":
    "When the job sets no PATH, the default PATH of this Mac is added to EnvironmentVariables before the save. launchd's own PATH is /usr/bin:/bin:/usr/sbin:/sbin. Only new and duplicated jobs.",
  "editor.footer.autoPathLabel": "Add PATH automatically",
  "editor.footer.saveOnlyTitle": "Write the file but do not load it into launchd",
  "editor.footer.saveOnly": "Save only",
  "editor.footer.saveAndLoad": "Save and load",
  "editor.footer.manualRef": "Every field shows its launchd key. Full reference: run {command} in Terminal.",

  // confirm (window.confirm)
  "editor.confirm.closeWithDraft":
    "Close the editor without saving?\n\nYour changes stay on this Mac as a draft. The editor offers to restore them the next time you open this job.",
  "editor.confirm.closeNoChanges": "Close the editor? You did not change this job, so no draft is kept.",
  "editor.confirm.closeDraftLost": "Close the editor? These changes are lost.\n\nThe earlier draft from {when} stays.",
  "editor.confirm.discardNoDraft":
    "Discard the changes to this job?\n\nThey cannot be kept as a draft (over 200 KB, or the browser storage is not available).",

  // toast
  "editor.toast.discarded": "Changes discarded. Undo brings them back.",
  "editor.toast.draftRestored": "Draft restored. Save to apply it.",
  "editor.toast.revisionLoaded": "Revision loaded into the editor. Save to apply it.",
  "editor.toast.savedAndLoaded": "Saved and loaded {label}",
  "editor.toast.savedOnly": "Saved {label} without loading",
  "editor.toast.pathAdded": "PATH was added.",

  // run (JobForm RunSection)
  "editor.run.label": "Run",
  "editor.run.kindGroupAria": "Run kind",
  "editor.run.kind.command.title": "Command",
  "editor.run.kind.command.hint": "A shell command line. Runs through sh -c, so pipes, && and variables work.",
  "editor.run.kind.program.title": "Program",
  "editor.run.kind.program.hint": "An executable and its arguments, passed to launchd as they are.",
  "editor.run.kind.script.title": "Script",
  "editor.run.kind.script.hint": "A script file, run by the interpreter you choose.",
  "editor.run.kind.app.title": "App",
  "editor.run.kind.app.hint": "Opens an application with /usr/bin/open.",
  "editor.run.kind.shortcut.title": "Shortcut",
  "editor.run.kind.shortcut.hint": "Runs a shortcut from the Shortcuts app.",
  "editor.run.shellAria": "Shell",
  "editor.run.commandPlaceholder": 'e.g. /usr/bin/rsync -a "$HOME/Documents" /Volumes/Backup',
  "editor.run.addArgument": "Add argument",
  "editor.run.argumentPlaceholder": "argument",
  "editor.run.programArgumentChoose": "Program argument",
  "editor.run.findFullPath": 'Find the full path of "{name}"',
  "editor.run.resolvedTo": "Resolved to {path}",
  "editor.run.notFoundIn": '"{name}" was not found in {dirs}',
  "editor.run.interpreterAria": "Interpreter",
  "editor.run.appPlaceholder": "Safari  or  /Applications/Safari.app",
  "editor.run.waitForQuit": "Wait until the app quits ({flag}), so launchd tracks the app and not only the launcher",
  "editor.run.builtApp":
    "Built {path}. The job now opens this app, because macOS grants privacy permissions (Full Disk Access, Automation) to apps, not to scripts.",
  "editor.run.pickShortcut": "Pick or type a shortcut name",

  // wrap a script in an app
  "editor.wrapApp.button": "Wrap in an app…",
  "editor.wrapApp.description":
    "Creates {path} and changes the job to open it. The app runs the script file itself: the file must be executable and start with a {shebang} line.",
  "editor.wrapApp.nameLabel": "App name",
  "editor.wrapApp.buildButton": "Build app",
  "editor.wrapApp.buildFailed": "The app could not be built.",
  "editor.wrapApp.noPathReturned": "The backend did not return the path of the app.",
  "editor.wrapApp.emptyName": "Enter a name for the app.",
  "editor.wrapApp.invalidName": "Use 1 to 64 letters, digits, spaces, dots, dashes or underscores. Start with a letter or a digit.",

  // groups (JobForm sections)
  "editor.group.triggers": "When",
  "editor.group.io": "Output and input",
  "editor.group.environment": "Environment",
  "editor.group.identity": "User and session",
  "editor.group.resources": "Resources and limits",
  "editor.group.advanced": "Advanced",

  // sections
  "editor.section.countBadge": "{count} set",
  "editor.section.countBadgeTitle": "Keys set in this section",
  "editor.section.otherKeys": "Other keys",

  // key
  "editor.key.deprecated": "deprecated",

  // add key
  "editor.addKey.label": "Add key…",
  "editor.addKey.placeholder": "Key name, for example Sockets",
  "editor.addKey.typeAria": "Type of the new key",
  "editor.addKey.typeFixedTitle": "launchd defines the type of this key",
  "editor.addKey.undocumented": "Not a documented launchd key. launchd ignores keys it does not know.",
  "editor.addKey.hint": "The list suggests the launchd keys this job does not set. Any other name is kept as it is.",
  "editor.addKey.emptyName": "Enter the name of the key.",
  "editor.addKey.trimName": "Remove the spaces around the name.",
  "editor.addKey.alreadyHasKey": 'The job already has the key "{name}".',

  // path picker
  "editor.picker.kind.folder": "Folder",
  "editor.picker.kind.app": "App",
  "editor.picker.kind.executable": "Executable",
  "editor.picker.kind.file": "File",
  "editor.picker.emptyFileName": "Enter a file name.",
  "editor.picker.slashInFileName": "A file name cannot contain a slash.",
  "editor.picker.invalidFileName": "This is not a file name.",
  "editor.picker.shortcut.home": "Home",
  "editor.picker.shortcut.applications": "Applications",
  "editor.picker.mode.file.title": "Choose a file",
  "editor.picker.mode.folder.title": "Choose a folder",
  "editor.picker.mode.executable.title": "Choose an executable",
  "editor.picker.mode.app.title": "Choose an app",
  "editor.picker.mode.any.title": "Choose a file or a folder",
  "editor.picker.mode.file.hint": "Enter opens a folder or chooses a file.",
  "editor.picker.mode.folder.hint": 'Open the folder, then press "Choose this folder".',
  "editor.picker.mode.executable.hint": "Only files with an execute permission can be chosen.",
  "editor.picker.mode.app.hint": "Enter opens a folder or chooses an app.",
  "editor.picker.mode.any.hint": 'Enter chooses a file. For a folder: open it, then press "Choose this folder".',
  "editor.picker.badListing": "The backend returned an unexpected folder listing.",
  "editor.picker.readError": "The folder could not be read.",
  "editor.picker.homeReadError": "The home folder could not be read.",
  "editor.picker.backspaceHint": "Backspace opens the parent folder.",
  "editor.picker.closeAria": "Close the file browser",
  "editor.picker.placesAria": "Places",
  "editor.picker.pathAria": "Folder path",
  "editor.picker.parentAria": "Open the parent folder",
  "editor.picker.parentTitle": "Parent folder (Backspace)",
  "editor.picker.filterAria": "Filter this folder",
  "editor.picker.showHidden": "Show hidden",
  "editor.picker.contentsOf": "Contents of {path}",
  "editor.picker.folderContents": "Folder contents",
  "editor.picker.reading": "Reading the folder…",
  "editor.picker.noMatches": "Nothing matches. Clear the filter, or show hidden files.",
  "editor.picker.emptyFolder": "This folder is empty.",
  "editor.picker.hiddenSuffix": "hidden",
  "editor.picker.truncated": "This folder has more entries than the list can show. Type the path by hand when the entry is missing.",
  "editor.picker.newFilePlaceholder": "job.log",
  "editor.picker.newFileLabel": "New file in this folder",
  "editor.picker.useFolderAndName": "Use this folder + file name",
  "editor.picker.chooseFolder": "Choose this folder",
  "editor.picker.choose": "Choose",
  "editor.picker.chooseFieldAria": "Choose: {field}",
  "editor.picker.chooseEllipsis": "Choose…",

  // file drop
  "editor.drop.note.app": "New job: open this app at login.",
  "editor.drop.note.program": "New job: run this program at login.",
  "editor.drop.note.script": "New job: run this script at login.",
  "editor.drop.note.watchFolder": "New job: run a command when this folder changes. Replace the example command.",
  "editor.drop.note.watchFile": "This file cannot run. New job: run a command when the file changes. Replace the example command.",
  "editor.drop.overlayTitleOne": "Drop to create a job",
  "editor.drop.overlayTitleMany": "Drop one item at a time",
  "editor.drop.overlayHintOne": "{name}: an app, a program or a script runs at login. A folder or another file is watched for changes.",
  "editor.drop.overlayHintMany": "A job is created for one app, program, script or folder.",
  "editor.drop.cannotStart": "This item cannot start a job.",
  "editor.drop.inspectFailed": "The dropped item could not be inspected.",
  "editor.drop.oneAtATime": "Drop one item at a time to create a job.",
} as const;
