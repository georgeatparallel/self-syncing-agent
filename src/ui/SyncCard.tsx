import { useCallback, useEffect, useState } from "react";
import { Badge, Surface, Text, Button } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon, WarningIcon } from "@phosphor-icons/react";
import type { SyncSummary } from "./useSyncsSummary";
import { useSyncDetails } from "./useSyncDetails";

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

interface SyncCardProps {
  userId: string;
  sync: SyncSummary;
}

export function SyncCard({ userId, sync }: SyncCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { details, loading, error, refetch } = useSyncDetails(
    userId,
    expanded ? sync.id : null
  );

  // Fetch details the first time the card is expanded. Subsequent
  // expands reuse the cached details; the hook exposes `refetch` if
  // we ever need to bust the cache.
  useEffect(() => {
    if (expanded && !details && !loading && !error) {
      void refetch();
    }
  }, [expanded, details, loading, error, refetch]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <Surface className="rounded-lg ring ring-kumo-line p-3 space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-start justify-between text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Text size="sm" bold truncate>
              {sync.name}
            </Text>
            <Badge variant="secondary">v{sync.version}</Badge>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Text size="xs" variant="secondary">
              {sync.integration}
            </Text>
            <Text size="xs" variant="secondary">
              · {relativeTime(sync.updated_at)}
            </Text>
            {sync.error_count_1h > 0 ? (
              <Badge variant="destructive">
                <WarningIcon size={10} className="mr-0.5" />
                {sync.error_count_1h} err
              </Badge>
            ) : (
              <Text size="xs" variant="secondary">
                — no errors
              </Text>
            )}
          </div>
        </div>
        <div className="shrink-0 ml-2 pt-0.5">
          {expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
        </div>
      </button>

      {expanded && (
        <div className="pt-2 border-t border-kumo-line space-y-3">
          {loading && (
            <Text size="xs" variant="secondary">
              Loading…
            </Text>
          )}
          {error && (
            <Text size="xs" variant="secondary">
              Failed to load details: {error}
            </Text>
          )}
          {details && (
            <>
              <div>
                <div className="mb-1">
                  <Text size="xs" bold>
                    Row counts
                  </Text>
                </div>
                {Object.keys(details.row_counts).length === 0 ? (
                  <Text size="xs" variant="secondary">
                    No tables discovered in schema_ddl.
                  </Text>
                ) : (
                  <div className="space-y-0.5">
                    {Object.entries(details.row_counts).map(([t, c]) => (
                      <div
                        key={t}
                        className="flex justify-between text-xs font-mono"
                      >
                        <span>{t}</span>
                        <span className="text-kumo-subtle">{c}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <details>
                <summary className="text-xs font-medium cursor-pointer text-kumo-default">
                  Handler code
                </summary>
                <pre className="mt-1 p-2 text-xs font-mono bg-kumo-base rounded overflow-x-auto whitespace-pre-wrap max-h-64">
                  {details.sync.handler_code}
                </pre>
              </details>

              <details>
                <summary className="text-xs font-medium cursor-pointer text-kumo-default">
                  Schema DDL
                </summary>
                <pre className="mt-1 p-2 text-xs font-mono bg-kumo-base rounded overflow-x-auto whitespace-pre-wrap max-h-64">
                  {details.sync.schema_ddl}
                </pre>
              </details>

              {details.errors.length > 0 && (
                <details>
                  <summary className="text-xs font-medium cursor-pointer text-kumo-default">
                    Recent errors ({details.errors.length})
                  </summary>
                  <div className="mt-1 space-y-2">
                    {details.errors.map((err, i) => (
                      <div
                        key={i}
                        className="p-2 text-xs bg-kumo-base rounded ring ring-kumo-line"
                      >
                        <div className="flex justify-between mb-1">
                          <span className="font-mono text-kumo-subtle">
                            v{err.handler_version}
                          </span>
                          <span className="text-kumo-subtle">
                            {relativeTime(err.created_at)}
                          </span>
                        </div>
                        <div className="font-mono break-all mb-1">
                          {err.error_message}
                        </div>
                        {err.stack_trace && (
                          <details>
                            <summary className="cursor-pointer text-kumo-subtle text-xs">
                              Stack trace
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap text-[10px] font-mono">
                              {err.stack_trace}
                            </pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refetch()}
                  disabled={loading}
                >
                  Refresh details
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Surface>
  );
}
