/** Turkish dictionary. `Record<keyof typeof en, string>` makes a missing key a compile error. */
import type { en } from "./en";
import { trCore } from "./parts/core.tr";
import { trLaunchd } from "./parts/launchd.tr";
import { trApp } from "./parts/app.tr";
import { trPages } from "./parts/pages.tr";
import { trEditor } from "./parts/editor.tr";
import { trFields } from "./parts/fields.tr";
import { trDetail } from "./parts/detail.tr";
import { trList } from "./parts/list.tr";

export const tr: Record<keyof typeof en, string> = { ...trCore, ...trLaunchd, ...trApp, ...trPages, ...trEditor, ...trFields, ...trDetail, ...trList };
