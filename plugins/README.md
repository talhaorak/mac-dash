# mac-dash Plugins

Create plugins to extend mac-dash with new functionality.

## Plugin Structure

```
plugins/
  my-plugin/
    manifest.json    # Required: plugin metadata
    server.ts        # Optional: backend API routes
    client.tsx       # Optional: frontend UI component (dynamically loaded)
```

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A brief description",
  "icon": "wrench",
  "author": "Your Name",
  "sidebar": true,
  "dashboardWidget": false
}
```

## server.ts

Export a `register` function that receives a Hono app instance:

```typescript
import { Hono } from "hono";

export function register(app: Hono) {
  app.get("/api/plugins/my-plugin/data", (c) => {
    return c.json({ hello: "world" });
  });
}

export function cleanup() {
  // Called when plugin is disabled
}
```

## client.tsx

Export a default React component and optional metadata. The component is
**dynamically loaded at runtime** — no need to touch any host app files.

You can use the host app's shared modules directly:

```tsx
import { useState, useEffect } from "react";
import { GlowCard } from "@/components/ui/GlowCard";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Wrench, RefreshCw } from "lucide-react";

export default function MyPluginPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get("/plugins/my-plugin/data").then(setData);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">My Plugin</h1>
      <GlowCard>
        <pre className="text-xs text-gray-400">
          {JSON.stringify(data, null, 2)}
        </pre>
      </GlowCard>
    </div>
  );
}

export const metadata = {
  title: "My Plugin",
  icon: "wrench",
};
```

### Available shared modules

Plugins can import these modules — they are provided by the host app at
runtime (not bundled into the plugin):

| Import path                    | What it provides                |
| ------------------------------ | ------------------------------- |
| `react`                        | React hooks & core API          |
| `lucide-react`                 | Icon components                 |
| `framer-motion`                | Animation library               |
| `@/components/ui/GlowCard`    | Styled card component           |
| `@/lib/api`                    | `api.get()` / `api.post()` helpers |
| `@/lib/utils`                  | `cn()` class name utility       |

## How it works

1. **Server startup** — `plugins/` directory is scanned, `manifest.json` read, `server.ts` dynamically imported and `register(app)` called
2. **Client click** — when user navigates to a plugin page, `client.tsx` is bundled on-the-fly by the server (via `Bun.build`), served as ESM JS at `/api/plugins/:id/client.js`, and dynamically loaded in the browser
3. **Shared deps** — imports like `react`, `lucide-react`, and `@/` paths are not bundled into the plugin; they resolve to the same instances the host app uses
