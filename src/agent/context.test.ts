import { describe, it, expect } from "vitest";
import { formatActiveSyncs, formatSyncErrors } from "./context";
import type { Sync, SyncErrorStat } from "../db/types";

function sampleSync(overrides: Partial<Sync> = {}): Sync {
  return {
    id: "sync-abc-123",
    name: "linear_bugs",
    integration: "linear",
    handler_code: "export default {};",
    schema_ddl: "CREATE TABLE issues (id TEXT PRIMARY KEY)",
    filter_description: null,
    webhook_secret: "secret",
    upstream_webhook_id: null,
    code_id: "code-v1",
    version: 1,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides
  };
}

describe("formatActiveSyncs", () => {
  it("formats empty list with a clear stub message", () => {
    const output = formatActiveSyncs([]);
    expect(output).toContain("<active_syncs>");
    expect(output).toContain("</active_syncs>");
    expect(output.toLowerCase()).toContain("no syncs");
  });

  it("formats a populated list as a markdown table with id/name/integration", () => {
    const output = formatActiveSyncs([
      sampleSync({ id: "s-1", name: "linear_bugs", integration: "linear" }),
      sampleSync({ id: "s-2", name: "linear_cycles", integration: "linear" })
    ]);
    expect(output).toContain("<active_syncs>");
    expect(output).toContain("| sync_id | name | integration |");
    expect(output).toContain("s-1");
    expect(output).toContain("linear_bugs");
    expect(output).toContain("s-2");
    expect(output).toContain("linear_cycles");
  });
});

describe("formatSyncErrors", () => {
  it("formats empty list with a clear stub message", () => {
    const output = formatSyncErrors([]);
    expect(output).toContain("<sync_errors>");
    expect(output).toContain("</sync_errors>");
    expect(output.toLowerCase()).toContain("no recent errors");
  });

  it("formats a populated list as a markdown table with sync_id/count/last_error", () => {
    const stats: SyncErrorStat[] = [
      {
        sync_id: "s-1",
        error_count: 7,
        last_error_message:
          "TypeError: Cannot read property 'team' of undefined",
        last_occurred_at: 1_700_000_000
      }
    ];
    const output = formatSyncErrors(stats);
    expect(output).toContain("<sync_errors>");
    expect(output).toContain("s-1");
    expect(output).toContain("7");
    expect(output).toContain("TypeError");
  });

  it("truncates very long error messages in the table", () => {
    const longMessage = "x".repeat(500);
    const output = formatSyncErrors([
      {
        sync_id: "s-1",
        error_count: 1,
        last_error_message: longMessage,
        last_occurred_at: 1_700_000_000
      }
    ]);
    // We don't need an exact cap; just confirm the formatter doesn't
    // pipe 500 literal chars into the table. Anywhere between 100-300
    // is a reasonable truncation threshold.
    const tableLine = output.split("\n").find((l) => l.includes("s-1"))!;
    expect(tableLine.length).toBeLessThan(400);
  });
});
