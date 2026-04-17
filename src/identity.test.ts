import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  USER_ID_KEY,
  getOrMintUserId,
  userIdFromPath,
  userPath
} from "./identity";

function mockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null
  };
}

describe("identity", () => {
  describe("USER_ID_KEY", () => {
    it("is a stable localStorage key", () => {
      expect(USER_ID_KEY).toBe("self-syncing-agent:user-id");
    });
  });

  describe("userIdFromPath", () => {
    it("extracts a userId from /user/:id paths", () => {
      expect(userIdFromPath("/user/abc-123")).toBe("abc-123");
      expect(userIdFromPath("/user/6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff")).toBe(
        "6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff"
      );
    });

    it("strips a trailing slash", () => {
      expect(userIdFromPath("/user/abc-123/")).toBe("abc-123");
    });

    it("returns null for unrelated paths", () => {
      expect(userIdFromPath("/")).toBeNull();
      expect(userIdFromPath("/about")).toBeNull();
      expect(userIdFromPath("/user")).toBeNull();
      expect(userIdFromPath("/user/")).toBeNull();
      expect(userIdFromPath("/user/abc/extra")).toBeNull();
    });
  });

  describe("userPath", () => {
    it("builds the canonical path for a userId", () => {
      expect(userPath("abc-123")).toBe("/user/abc-123");
    });
  });

  describe("getOrMintUserId", () => {
    let storage: ReturnType<typeof mockLocalStorage>;

    beforeEach(() => {
      storage = mockLocalStorage();
      vi.stubGlobal("localStorage", storage);
    });

    it("mints a new UUID when none is stored and returns it", () => {
      const id = getOrMintUserId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(storage.getItem(USER_ID_KEY)).toBe(id);
    });

    it("returns the stored UUID when one is already set", () => {
      const stored = "6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff";
      storage.setItem(USER_ID_KEY, stored);
      expect(getOrMintUserId()).toBe(stored);
    });

    it("does not touch storage when reading an existing id", () => {
      const stored = "6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff";
      storage.setItem(USER_ID_KEY, stored);
      getOrMintUserId();
      // Still the same, unchanged
      expect(storage.getItem(USER_ID_KEY)).toBe(stored);
    });
  });
});
