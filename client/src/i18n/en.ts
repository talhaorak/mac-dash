/** English dictionary: the source of truth. Every other language is typed against its keys. */
import { enCore } from "./parts/core.en";
import { enLaunchd } from "./parts/launchd.en";
import { enApp } from "./parts/app.en";
import { enPages } from "./parts/pages.en";
import { enEditor } from "./parts/editor.en";
import { enFields } from "./parts/fields.en";
import { enDetail } from "./parts/detail.en";
import { enList } from "./parts/list.en";

export const en = { ...enCore, ...enLaunchd, ...enApp, ...enPages, ...enEditor, ...enFields, ...enDetail, ...enList } as const;
