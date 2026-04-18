import { useCallback, useEffect, useState } from "react";

export interface ConnectionSummary {
  user_id: string;
  app_slug: string;
  account_id: string;
  connected_at: number;
}

/**
 * Fetches `/api/user/:userId/pipedream/accounts` on mount and whenever
 * the supervisor's `syncChangeTick` state field changes. Mirrors the
 * signal-driven refetch pattern used by useSyncsSummary — no polling.
 * `persistPipedreamAccount` bumps the same tick so the UI picks up
 * new connections without any extra plumbing.
 */
export function useConnections(userId: string, syncChangeTick: number) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/user/${userId}/pipedream/accounts`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { accounts: ConnectionSummary[] };
      setConnections(body.accounts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  useEffect(() => {
    void refetch();
  }, [refetch, syncChangeTick]);

  return { connections, error, refetch };
}
