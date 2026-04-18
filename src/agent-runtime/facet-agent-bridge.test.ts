import { describe, it, expect, vi } from "vitest";
import { FacetAgentBridge } from "./facet-agent-bridge";

describe("FacetAgentBridge", () => {
  it("sqlQuery delegates to sql.exec().toArray()", async () => {
    const toArray = vi.fn().mockReturnValue([{ id: 1 }]);
    const exec = vi.fn().mockReturnValue({ toArray });
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({ sql, userId: "u" });
    const rows = await bridge.sqlQuery("SELECT 1");
    expect(rows).toEqual([{ id: 1 }]);
    expect(exec).toHaveBeenCalledWith("SELECT 1");
  });

  it("sqlExec delegates with bindings and returns rowsWritten", async () => {
    const cursor = {
      toArray: vi.fn().mockReturnValue([]),
      rowsWritten: 2,
      rowsRead: 0
    };
    const exec = vi.fn().mockReturnValue(cursor);
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({ sql, userId: "u" });
    const result = await bridge.sqlExec("INSERT INTO t VALUES (?)", 1);
    expect(result).toEqual({ ok: true, rowsWritten: 2, rowsRead: 0 });
    expect(exec).toHaveBeenCalledWith("INSERT INTO t VALUES (?)", 1);
  });

  it("sqlExec returns { ok: false, error } on SQLite error", async () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("no such table: t");
    });
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({ sql, userId: "u" });
    const result = await bridge.sqlExec("INSERT INTO t VALUES (1)");
    expect(result).toEqual({ ok: false, error: "no such table: t" });
  });

  it("exposes userId so the supervisor can stamp exec isolates", async () => {
    const bridge = new FacetAgentBridge({
      sql: { exec: vi.fn() } as unknown as SqlStorage,
      userId: "u-42"
    });
    expect(await bridge.getUserId()).toBe("u-42");
  });
});
