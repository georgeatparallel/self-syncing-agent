import { describe, it, expect, vi } from "vitest";
import { FacetAgentBridge } from "./facet-agent-bridge";

describe("FacetAgentBridge", () => {
  it("sqlExec returns rows, rowsWritten, rowsRead on SELECT success", async () => {
    const cursor = {
      toArray: vi.fn().mockReturnValue([{ id: 1, name: "a" }]),
      rowsWritten: 0,
      rowsRead: 1
    };
    const exec = vi.fn().mockReturnValue(cursor);
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({ sql, userId: "u" });
    const result = await bridge.sqlExec("SELECT * FROM t");
    expect(result).toEqual({
      ok: true,
      rows: [{ id: 1, name: "a" }],
      rowsWritten: 0,
      rowsRead: 1
    });
    expect(exec).toHaveBeenCalledWith("SELECT * FROM t");
  });

  it("sqlExec returns empty rows + rowsWritten on INSERT success", async () => {
    const cursor = {
      toArray: vi.fn().mockReturnValue([]),
      rowsWritten: 2,
      rowsRead: 0
    };
    const exec = vi.fn().mockReturnValue(cursor);
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({ sql, userId: "u" });
    const result = await bridge.sqlExec("INSERT INTO t VALUES (?)", 1);
    expect(result).toEqual({
      ok: true,
      rows: [],
      rowsWritten: 2,
      rowsRead: 0
    });
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
