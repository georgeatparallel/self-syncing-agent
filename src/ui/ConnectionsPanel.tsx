import { useCallback, useState } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import {
  createFrontendClient,
  type ConnectError,
  type ConnectResult
} from "@pipedream/sdk/browser";
import { useConnections, type ConnectionSummary } from "./useConnections";

const APP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "github", label: "GitHub" },
  { value: "slack", label: "Slack" },
  { value: "notion", label: "Notion" },
  { value: "google_sheets", label: "Google Sheets" }
];

interface ConnectionsPanelProps {
  userId: string;
  syncChangeTick: number;
}

export function ConnectionsPanel({
  userId,
  syncChangeTick
}: ConnectionsPanelProps) {
  const { connections, error, refetch } = useConnections(userId, syncChangeTick);
  const [pending, setPending] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<string>(APP_OPTIONS[0].value);

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
        <select
          className="flex-1 text-xs bg-kumo-base border border-kumo-line rounded px-2 py-1 text-kumo-default"
          value={selectedApp}
          onChange={(e) => setSelectedApp(e.target.value)}
          disabled={pending !== null}
        >
          {APP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleConnect()}
          disabled={pending !== null}
        >
          {pending === selectedApp ? "Connecting…" : "Connect"}
        </Button>
      </div>
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
