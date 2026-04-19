import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  upsertConnectedAccount,
  listConnectedAccounts,
  deleteConnectedAccount,
  getConnectedAccountBySlug
} from "./connected-accounts";
import type { NewConnectedAccount } from "./types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function sample(
  overrides: Partial<NewConnectedAccount> = {}
): NewConnectedAccount {
  return {
    user_id: overrides.user_id ?? "u-1",
    app_slug: overrides.app_slug ?? "github",
    account_id: overrides.account_id ?? "apn_abc",
    connected_at: overrides.connected_at ?? 1_000
  };
}

function getStub(userName: string) {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userName));
  return { stub, userName };
}

/**
 * Bind `sql` at the boundary so repo code stays a plain function over a
 * tagged-template callable. See supervisor-data-model.test.ts for the
 * background on why this is necessary.
 */
function bindSql<T extends { sql: (...args: never[]) => unknown }>(
  instance: T
): T["sql"] {
  return instance.sql.bind(instance) as T["sql"];
}

/**
 * `runInDurableObject` constructs the instance but does NOT fire the
 * Agents SDK lifecycle; we call `setName()` explicitly to drive
 * `onStart` → `applySchemaMigrations`, leaving the DO in the same state
 * it'd be in after a real fetch.
 */
async function ensureReady(instance: unknown, userName: string): Promise<void> {
  await (instance as { setName: (name: string) => Promise<void> }).setName(
    userName
  );
}

describe("connected_accounts repo", () => {
  it("upsert inserts a new row and list returns it", async () => {
    const { stub, userName } = getStub("ca-insert-user");
    const row = sample({ user_id: "u-insert", app_slug: "github" });

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const sql = bindSql(instance);

      upsertConnectedAccount(sql, row);

      const list = listConnectedAccounts(sql, "u-insert");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(row);
    });
  });

  it("upsert replaces on (user_id, app_slug) collision", async () => {
    const { stub, userName } = getStub("ca-replace-user");
    const first = sample({
      user_id: "u-rep",
      app_slug: "github",
      account_id: "apn_old",
      connected_at: 1_000
    });
    const second = sample({
      user_id: "u-rep",
      app_slug: "github",
      account_id: "apn_new",
      connected_at: 2_000
    });

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const sql = bindSql(instance);

      upsertConnectedAccount(sql, first);
      upsertConnectedAccount(sql, second);

      const list = listConnectedAccounts(sql, "u-rep");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(second);
    });
  });

  it("listConnectedAccounts scopes by user_id", async () => {
    const { stub, userName } = getStub("ca-scope-user");

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const sql = bindSql(instance);

      upsertConnectedAccount(
        sql,
        sample({ user_id: "u-a", app_slug: "github", account_id: "apn_a1" })
      );
      upsertConnectedAccount(
        sql,
        sample({ user_id: "u-a", app_slug: "slack", account_id: "apn_a2" })
      );
      upsertConnectedAccount(
        sql,
        sample({ user_id: "u-b", app_slug: "github", account_id: "apn_b1" })
      );

      const forA = listConnectedAccounts(sql, "u-a");
      expect(forA).toHaveLength(2);
      expect(forA.every((r) => r.user_id === "u-a")).toBe(true);

      const forB = listConnectedAccounts(sql, "u-b");
      expect(forB).toHaveLength(1);
      expect(forB[0].account_id).toBe("apn_b1");
    });
  });

  it("getConnectedAccountBySlug returns the matching row or null", async () => {
    const { stub, userName } = getStub("ca-by-slug-user");

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const sql = bindSql(instance);

      upsertConnectedAccount(
        sql,
        sample({
          user_id: "u-slug",
          app_slug: "github",
          account_id: "apn_gh"
        })
      );
      upsertConnectedAccount(
        sql,
        sample({
          user_id: "u-slug",
          app_slug: "slack",
          account_id: "apn_sl"
        })
      );
      // Different user — must not bleed into the u-slug lookup.
      upsertConnectedAccount(
        sql,
        sample({
          user_id: "u-other",
          app_slug: "github",
          account_id: "apn_other"
        })
      );

      const gh = getConnectedAccountBySlug(sql, "u-slug", "github");
      expect(gh).not.toBeNull();
      expect(gh?.account_id).toBe("apn_gh");

      const sl = getConnectedAccountBySlug(sql, "u-slug", "slack");
      expect(sl?.account_id).toBe("apn_sl");

      // Not connected.
      expect(getConnectedAccountBySlug(sql, "u-slug", "notion")).toBeNull();
      // Wrong user.
      expect(getConnectedAccountBySlug(sql, "u-nobody", "github")).toBeNull();
    });
  });

  it("deleteConnectedAccount removes the matching row", async () => {
    const { stub, userName } = getStub("ca-delete-user");
    const row = sample({ user_id: "u-del", app_slug: "github" });

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const sql = bindSql(instance);

      upsertConnectedAccount(sql, row);
      expect(listConnectedAccounts(sql, "u-del")).toHaveLength(1);

      deleteConnectedAccount(sql, "u-del", "github");
      expect(listConnectedAccounts(sql, "u-del")).toHaveLength(0);
    });
  });
});
