# mac-dash Plugins

Create plugins to extend mac-dash with new functionality.

## Plugin Structure

```
plugins/
  my-plugin/
    manifest.json    # Required: plugin metadata
    server.ts        # Optional: backend API routes
    client.tsx       # Optional: frontend UI component
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

Export a React component and metadata:

```tsx
export default function MyPluginPanel() {
  return <div>My Plugin UI</div>;
}

export const metadata = {
  title: "My Plugin",
  icon: "wrench",
};
```
