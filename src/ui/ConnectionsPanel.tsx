import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import {
  createFrontendClient,
  type ConnectError,
  type ConnectResult
} from "@pipedream/sdk/browser";
import type { AppEntry } from "../pipedream/app-types";
import { useConnections, type ConnectionSummary } from "./useConnections";

interface ConnectionsPanelProps {
  userId: string;
  syncChangeTick: number;
}

export function ConnectionsPanel({
  userId,
  syncChangeTick
}: ConnectionsPanelProps) {
  const { connections, error, refetch } = useConnections(
    userId,
    syncChangeTick
  );
  const [pending, setPending] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<string>("");
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [query, setQuery] = useState("");

  // Kumo's Combobox.List renders every item in `items` to the DOM (no
  // virtualization). Passing ~3000 Pipedream apps causes the browser to
  // choke/truncate the list. Filter client-side + cap at 50 so the DOM
  // stays small regardless of catalog size.
  const filteredApps = useMemo(() => {
    if (apps.length === 0) return [];
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      // Empty query: show the first 50 alphabetically so the dropdown
      // isn't empty but also doesn't render thousands of DOM nodes.
      // The JSON snapshot is already name-sorted; slice without
      // re-sorting.
      return apps.slice(0, 50);
    }
    return apps
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.name_slug.toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [apps, query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/pipedream-apps.json");
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { apps: AppEntry[] };
        if (!cancelled) {
          setApps(body.apps);
          setCatalogLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setCatalogError(e instanceof Error ? e.message : String(e));
          setCatalogLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnect = useCallback(async () => {
    setConnectError(null);
    setPending(selectedApp);
    try {
      const client = createFrontendClient({
        externalUserId: userId,
        tokenCallback: async () => {
          const res = await fetch(`/api/user/${userId}/pipedream/token`, {
            method: "POST"
          });
          if (!res.ok) throw new Error(`token mint failed: ${res.status}`);
          const body = (await res.json()) as {
            token: string;
            connectLinkUrl: string;
            expiresAt?: string;
          };
          // SDK's CreateTokenResponse shape expects { token, connectLinkUrl,
          // expiresAt: Date }. Our backend currently returns just token +
          // connectLinkUrl, so synthesize an expiry one hour out to match
          // the SDK's type. If/when the backend plumbs real expiry, this
          // passthrough picks it up.
          return {
            token: body.token,
            connectLinkUrl: body.connectLinkUrl,
            expiresAt: body.expiresAt
              ? new Date(body.expiresAt)
              : new Date(Date.now() + 60 * 60 * 1000)
          };
        }
      });

      await new Promise<void>((resolve, reject) => {
        client.connectAccount({
          app: selectedApp,
          onSuccess: (account: ConnectResult) => {
            void (async () => {
              try {
                const persistRes = await fetch(
                  `/api/user/${userId}/pipedream/account`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      app_slug: selectedApp,
                      account_id: account.id
                    })
                  }
                );
                if (!persistRes.ok) {
                  throw new Error(`persist failed: ${persistRes.status}`);
                }
                // #bumpChangeTick on the server triggers useConnections to
                // refetch via syncChangeTick, but call refetch() explicitly
                // in case the signal is racy with the popup close.
                await refetch();
                resolve();
              } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
              }
            })();
          },
          onError: (err: ConnectError) => {
            reject(new Error(err.message || "unknown connect error"));
          }
        });
      });
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [userId, selectedApp, refetch]);

  return (
    <div className="px-4 py-3 border-t border-kumo-line">
      <div className="mb-2">
        <Text size="sm" bold>
          Connections
        </Text>
      </div>
      {error && (
        <Surface className="rounded-lg p-2 ring ring-kumo-danger mb-2">
          <Text size="xs" variant="secondary">
            Failed to load connections: {error}
          </Text>
        </Surface>
      )}
      <ul className="space-y-1 mb-3">
        {connections === null && !error ? (
          <li>
            <Text size="xs" variant="secondary">
              Loading…
            </Text>
          </li>
        ) : (connections ?? []).length === 0 ? (
          <li>
            <Text size="xs" variant="secondary">
              No connections yet.
            </Text>
          </li>
        ) : (
          (connections ?? []).map((c: ConnectionSummary) => (
            <li
              key={`${c.app_slug}:${c.account_id}`}
              className="flex items-center justify-between text-xs"
            >
              <span className="text-kumo-default">{c.app_slug}</span>
              <span className="font-mono text-kumo-subtle truncate ml-2">
                {c.account_id}
              </span>
            </li>
          ))
        )}
      </ul>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Combobox
            items={filteredApps}
            value={selectedApp}
            onValueChange={(v) => {
              if (typeof v === "string") setSelectedApp(v);
            }}
            onInputValueChange={(v) => setQuery(v)}
            disabled={pending !== null || catalogLoading}
          >
            <Combobox.TriggerInput
              placeholder={catalogLoading ? "Loading apps…" : "Search apps…"}
            />
            <Combobox.Content>
              <Combobox.List>
                {(app: AppEntry) => (
                  <Combobox.Item value={app.name_slug}>
                    {app.name}
                  </Combobox.Item>
                )}
              </Combobox.List>
              <Combobox.Empty>No apps match.</Combobox.Empty>
            </Combobox.Content>
          </Combobox>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleConnect()}
          disabled={pending !== null || selectedApp === ""}
        >
          {pending === selectedApp ? "Connecting…" : "Connect"}
        </Button>
      </div>
      {catalogError && (
        <div className="mt-2">
          <Text size="xs" variant="secondary">
            Failed to load app catalog: {catalogError}
          </Text>
        </div>
      )}
      {connectError && (
        <div className="mt-2">
          <Text size="xs" variant="secondary">
            Connect failed: {connectError}
          </Text>
        </div>
      )}
    </div>
  );
}
