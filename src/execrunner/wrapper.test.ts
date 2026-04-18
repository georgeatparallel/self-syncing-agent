import { describe, it, expect } from "vitest";
import { EXEC_WRAPPER_SOURCE } from "./wrapper";

describe("EXEC_WRAPPER_SOURCE", () => {
  it("imports WorkerEntrypoint from cloudflare:workers", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(
      /import \{ WorkerEntrypoint \} from "cloudflare:workers"/
    );
  });

  it("imports runInSync from ./exec.js", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(
      /import \{ runInSync \} from "\.\/exec\.js"/
    );
  });

  it("default-exports a class extending WorkerEntrypoint with an async run(facet) method", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(
      /export default class extends WorkerEntrypoint/
    );
    expect(EXEC_WRAPPER_SOURCE).toMatch(/async run\(facet\)/);
  });

  it("guards against a missing or non-function runInSync export", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/typeof runInSync !== "function"/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/no_export/);
  });

  it("wraps the runInSync call in try/catch and returns exec_failed with stack on throw", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/try\s*\{/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/exec_failed/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/e\.stack/);
  });

  it("installs a log capture that monkey-patches console.log/info/warn/error", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.log = capture/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.info = capture/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.warn = capture/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.error = capture/);
  });

  it("uses a ring-buffered log array with a 200-entry cap", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/LOG_ENTRY_CAP\s*=\s*200/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/logs\.shift\(\)/);
  });

  it("truncates each log message at 2048 bytes", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/LOG_MESSAGE_BYTES\s*=\s*2048/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/\.slice\(0, LOG_MESSAGE_BYTES\)/);
  });

  it("restores original console methods in finally", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/finally\s*\{/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/restore\(\)/);
  });

  it("returns logs on both success and failure paths", () => {
    // Both the ok:true and ok:false returns should include `logs`.
    const okMatch = EXEC_WRAPPER_SOURCE.match(
      /return \{\s*ok:\s*true,[^}]*logs[^}]*\}/
    );
    const failMatch = EXEC_WRAPPER_SOURCE.match(
      /return \{\s*ok:\s*false,[\s\S]*?logs[\s\S]*?\}/
    );
    expect(okMatch).not.toBeNull();
    expect(failMatch).not.toBeNull();
  });
});
