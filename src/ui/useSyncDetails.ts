import { useCallback, useState } from "react";

export interface SyncDetails {
  sync: {
    id: string;
    name: string;
    integration: string;
    version: number;
    handler_code: string;
    schema_ddl: string;
    updated_at: number;
  };
  row_counts: Record<string, number>;
  errors: Array<{
    created_at: number;
    error_message: string;
    stack_trace: string | null;
    payload_preview: string | null;
    handler_version: number;
  }>;
}

/**
 * Lazy-fetches `/api/user/:userId/syncs/:syncId/details`. Called by
 * SyncCard when a user expands a card; NOT driven by the change-tick
 * (too expensive — the details endpoint hits the facet for per-table
 * row counts). The card's expanded view manually refetches via the
 * returned `refetch` after actions that would invalidate it.
 */
export function useSyncDetails(userId: string, syncId: string | null) {
  const [details, setDetails] = useState<SyncDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!syncId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/user/${userId}/syncs/${syncId}/details`);
      if (res.status === 404) {
        setError("not_found");
        setDetails(null);
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as SyncDetails;
      setDetails(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId, syncId]);

  return { details, loading, error, refetch };
}
