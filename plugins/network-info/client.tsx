/**
 * Network Info Plugin - Client Component
 *
 * This component would be dynamically loaded by the plugin system.
 * For now it serves as an example of how to build plugin UIs.
 *
 * Usage: The plugin system will import this component and render it
 * when the user navigates to the plugin's page in the sidebar.
 */

export default function NetworkInfoPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white">Network Info</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Network interfaces, connections, and statistics
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Network interfaces card */}
        <div className="glass rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">Interfaces</h3>
          <p className="text-xs text-gray-500">
            Fetched from /api/plugins/network-info/interfaces
          </p>
        </div>

        {/* Connection stats card */}
        <div className="glass rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">Connections</h3>
          <p className="text-xs text-gray-500">
            Fetched from /api/plugins/network-info/connections
          </p>
        </div>
      </div>
    </div>
  );
}

export const metadata = {
  title: "Network Info",
  icon: "globe",
};
