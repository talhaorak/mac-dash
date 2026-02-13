import { Hono } from "hono";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  author?: string;
  sidebar?: boolean;
  dashboardWidget?: boolean;
}

export interface ServerPlugin {
  register(app: Hono): void | Promise<void>;
  cleanup?(): void | Promise<void>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  path: string;
  serverModule?: ServerPlugin;
  hasClient: boolean;
}
