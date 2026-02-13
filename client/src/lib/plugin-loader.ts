import { api } from "./api";

export interface ClientPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  enabled: boolean;
  hasClient: boolean;
  sidebar?: boolean;
  dashboardWidget?: boolean;
}

export async function loadPlugins(): Promise<ClientPlugin[]> {
  try {
    const res = await api.get<{ plugins: ClientPlugin[] }>("/plugins");
    return res.plugins;
  } catch {
    return [];
  }
}
