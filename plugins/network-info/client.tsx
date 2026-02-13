import { useState, useEffect } from "react";
import { GlowCard } from "@/components/ui/GlowCard";
import { api } from "@/lib/api";
import {
  Globe,
  Wifi,
  WifiOff,
  Network,
  ArrowUpDown,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NetworkInterface {
  name: string;
  ip4: string | null;
  ip6: string | null;
  mac: string | null;
  status: "active" | "inactive";
  type: string;
}

interface ConnectionStats {
  established: number;
  listening: number;
  timeWait: number;
  closeWait: number;
  total: number;
}

interface NetworkSummary {
  interfaces: NetworkInterface[];
  connections: ConnectionStats;
  externalIp: string | null;
}

export default function NetworkInfoPanel() {
  const [data, setData] = useState<NetworkSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<NetworkSummary>("/plugins/network-info/summary");
      setData(res);
    } catch (e: any) {
      setError(e.message || "Failed to load network info");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <GlowCard className="text-center py-12">
        <p className="text-red-400 text-sm">{error}</p>
        <button onClick={fetchData} className="mt-3 text-xs text-cyan-400 hover:underline">
          Retry
        </button>
      </GlowCard>
    );
  }

  const activeInterfaces = data?.interfaces.filter((i) => i.status === "active") || [];
  const inactiveInterfaces = data?.interfaces.filter((i) => i.status === "inactive") || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Network Info</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Interfaces, connections, and external IP
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] transition-all"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlowCard glow="accent">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
              <Globe className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">External IP</div>
              <div className="text-lg font-mono font-bold text-white">
                {data?.externalIp || "N/A"}
              </div>
            </div>
          </div>
        </GlowCard>

        <GlowCard>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
              <ArrowUpDown className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">TCP Connections</div>
              <div className="text-lg font-mono font-bold text-white">
                {data?.connections.total || 0}
              </div>
            </div>
          </div>
        </GlowCard>

        <GlowCard>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <Network className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Active Interfaces</div>
              <div className="text-lg font-mono font-bold text-white">
                {activeInterfaces.length}
              </div>
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Connection breakdown */}
      {data?.connections && (
        <GlowCard padding="sm">
          <h3 className="text-sm font-semibold text-gray-300 px-2 pb-2">Connection States</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-2">
            {[
              { label: "Established", value: data.connections.established, color: "text-green-400" },
              { label: "Listening", value: data.connections.listening, color: "text-cyan-400" },
              { label: "Time Wait", value: data.connections.timeWait, color: "text-amber-400" },
              { label: "Close Wait", value: data.connections.closeWait, color: "text-red-400" },
            ].map(({ label, value, color }) => (
              <div key={label} className="glass rounded-xl p-3 text-center">
                <div className="text-[10px] text-gray-500">{label}</div>
                <div className={cn("text-xl font-mono font-bold mt-1", color)}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </GlowCard>
      )}

      {/* Active interfaces */}
      {activeInterfaces.length > 0 && (
        <GlowCard padding="sm">
          <h3 className="text-sm font-semibold text-gray-300 px-2 pb-2">Active Interfaces</h3>
          <div className="space-y-1">
            {activeInterfaces.map((iface) => (
              <div
                key={iface.name}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.03] transition-colors"
              >
                <Wifi className="w-4 h-4 text-green-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-medium text-white">{iface.name}</span>
                    <span className="text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                      {iface.type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {iface.ip4 && (
                      <span className="text-xs font-mono text-cyan-400/80">{iface.ip4}</span>
                    )}
                    {iface.mac && (
                      <span className="text-xs font-mono text-gray-600">{iface.mac}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </GlowCard>
      )}

      {/* Inactive interfaces */}
      {inactiveInterfaces.length > 0 && (
        <GlowCard padding="sm">
          <h3 className="text-sm font-semibold text-gray-500 px-2 pb-2">
            Inactive Interfaces ({inactiveInterfaces.length})
          </h3>
          <div className="space-y-0.5">
            {inactiveInterfaces.map((iface) => (
              <div
                key={iface.name}
                className="flex items-center gap-3 px-3 py-1.5 rounded-lg text-gray-600"
              >
                <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs font-mono">{iface.name}</span>
                <span className="text-[10px]">{iface.type}</span>
              </div>
            ))}
          </div>
        </GlowCard>
      )}
    </div>
  );
}

export const metadata = {
  title: "Network Info",
  icon: "globe",
};
