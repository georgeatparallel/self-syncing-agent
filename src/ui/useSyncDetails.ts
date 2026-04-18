import { useCallback, useEffect, useState } from "react";

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
 * Fetches `/api/user/:userId/syncs/:syncId/details`. Fires only when
 * `syncId` is non-null (the card is expanded) — null short-circuits the
 * request so collapsed cards don't pay the facet-attach cost. While a
 * card stays expanded, any change to `syncChangeTick` auto-refetches so
 * per-table row counts stay live as webhooks land.
 */
export function useSyncDetails(
  userId: string,
  syncId: string | null,
  syncChangeTick: number
) {
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

  // Auto-refetch while expanded. Fires once when syncId flips from null
  // to a value (expand), and again on every tick change while syncId
  // stays non-null (live updates). Collapse zeroes syncId, short-
  // circuiting the next run.
  useEffect(() => {
    if (syncId) void refetch();
  }, [refetch, syncChangeTick]);

  return { details, loading, error, refetch };
}
