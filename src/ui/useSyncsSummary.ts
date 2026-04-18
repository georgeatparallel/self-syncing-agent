import { useCallback, useEffect, useState } from "react";

export interface SyncSummary {
  id: string;
  name: string;
  integration: string;
  version: number;
  error_count_1h: number;
  updated_at: number;
}

/**
 * Fetches `/api/user/:userId/syncs-summary` on mount and whenever the
 * supervisor's `syncChangeTick` state field changes. No polling. The
 * tick is dataless — receiving it means "refetch"; what specifically
 * changed isn't encoded in the signal.
 */
export function useSyncsSummary(
  userId: string,
  syncChangeTick: number | undefined
) {
  const [syncs, setSyncs] = useState<SyncSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/user/${userId}/syncs-summary`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { syncs: SyncSummary[] };
      setSyncs(body.syncs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  // Fires on mount (syncChangeTick is undefined, first run) AND on every
  // tick change (supervisor published a signal). Single effect covers
  // both paths because undefined → number is a dependency change.
  useEffect(() => {
    void refetch();
  }, [refetch, syncChangeTick]);

  return { syncs, error, refetch };
}
