import { Surface, Text } from "@cloudflare/kumo";
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import { useSyncsSummary } from "./useSyncsSummary";
import { SyncCard } from "./SyncCard";

interface SyncPanelProps {
  userId: string;
  syncChangeTick: number | undefined;
}

export function SyncPanel({ userId, syncChangeTick }: SyncPanelProps) {
  const { syncs, error } = useSyncsSummary(userId, syncChangeTick);

  return (
    <aside className="w-80 shrink-0 border-r border-kumo-line bg-kumo-base flex flex-col h-screen">
      <div className="px-4 py-3 border-b border-kumo-line">
        <div className="flex items-center gap-2">
          <PlugsConnectedIcon size={16} className="text-kumo-accent" />
          <Text size="sm" bold>
            Syncs
          </Text>
          {syncs && syncs.length > 0 && (
            <Text size="xs" variant="secondary">
              ({syncs.length})
            </Text>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <Surface className="rounded-lg p-3 ring ring-kumo-danger">
            <Text size="xs" variant="secondary">
              Failed to load syncs: {error}
            </Text>
          </Surface>
        )}
        {!syncs && !error && (
          <Text size="xs" variant="secondary">
            Loading…
          </Text>
        )}
        {syncs && syncs.length === 0 && (
          <div className="text-center py-8">
            <Text size="xs" variant="secondary">
              No syncs yet. Ask the agent to create one — e.g., "create a sync
              for Linear issues".
            </Text>
          </div>
        )}
        {syncs &&
          syncs.map((s) => <SyncCard key={s.id} userId={userId} sync={s} />)}
      </div>
    </aside>
  );
}
