import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOrbExportDbPath } from "../../packages/loopover-miner/lib/orb-export.js";
import { resolveDenyHookSynthesisDbPath } from "../../packages/loopover-miner/lib/deny-hook-synthesis.js";
import { resolveLaptopStateDbPath } from "../../packages/loopover-miner/lib/laptop-init.js";

// #8336: orb-export.ts, deny-hook-synthesis.ts, and laptop-init.ts previously hand-duplicated the same
// explicit-env / LOOPOVER_MINER_CONFIG_DIR / XDG_CONFIG_HOME / ~/.config precedence chain that
// prediction-ledger.ts already delegates to local-store.ts::resolveLocalStoreDbPath. These pin that each
// resolver now delegates while preserving the exact precedence, and that laptop-init gained the new
// LOOPOVER_MINER_LAPTOP_STATE_DB explicit override for parity with its sibling stores.

describe("miner local-store DB-path delegation (#8336)", () => {
  describe("resolveOrbExportDbPath", () => {
    const file = "orb-export.sqlite3";
    it("honors the explicit LOOPOVER_MINER_ORB_EXPORT_DB override first", () => {
      expect(resolveOrbExportDbPath({ LOOPOVER_MINER_ORB_EXPORT_DB: "/custom/orb.sqlite3" })).toBe(
        "/custom/orb.sqlite3",
      );
    });
    it("falls back to LOOPOVER_MINER_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
      expect(resolveOrbExportDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/state" })).toBe(join("/state", file));
      expect(resolveOrbExportDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "loopover-miner", file));
      expect(resolveOrbExportDbPath({})).toBe(join(homedir(), ".config", "loopover-miner", file));
    });
  });

  describe("resolveDenyHookSynthesisDbPath", () => {
    const file = "deny-hook-synthesis.sqlite3";
    it("honors the explicit LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB override first", () => {
      expect(
        resolveDenyHookSynthesisDbPath({ LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB: "/custom/deny.sqlite3" }),
      ).toBe("/custom/deny.sqlite3");
    });
    it("falls back to LOOPOVER_MINER_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
      expect(resolveDenyHookSynthesisDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/state" })).toBe(join("/state", file));
      expect(resolveDenyHookSynthesisDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
        join("/xdg", "loopover-miner", file),
      );
      expect(resolveDenyHookSynthesisDbPath({})).toBe(join(homedir(), ".config", "loopover-miner", file));
    });
  });

  describe("resolveLaptopStateDbPath", () => {
    const file = "laptop-state.sqlite3";
    it("honors the new explicit LOOPOVER_MINER_LAPTOP_STATE_DB override first", () => {
      expect(resolveLaptopStateDbPath({ LOOPOVER_MINER_LAPTOP_STATE_DB: "/custom/laptop.sqlite3" })).toBe(
        "/custom/laptop.sqlite3",
      );
    });
    it("falls back to LOOPOVER_MINER_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
      expect(resolveLaptopStateDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/state" })).toBe(join("/state", file));
      expect(resolveLaptopStateDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "loopover-miner", file));
      expect(resolveLaptopStateDbPath({})).toBe(join(homedir(), ".config", "loopover-miner", file));
    });
  });
});
