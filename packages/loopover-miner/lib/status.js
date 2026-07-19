import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, parseMinerGoalSpecContent, resolveFirstConfiguredCodingAgentDriverName, } from "@loopover/engine";
import { checkClaudeCliPresent, checkCodexCliPresent, checkDockerPresent, checkLaptopStateSqlite, findExecutableOnPath, resolveCodexAuthPath, } from "./laptop-init.js";
import { resolveMinerVersion } from "./version.js";
import { checkStoreIntegrity, describeError } from "./store-maintenance.js";
import { resolveEventLedgerDbPath } from "./event-ledger.js";
import { resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { hasGitHubTokenSource } from "./github-token-resolution.js";
import { resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { resolveRunStateDbPath } from "./run-state.js";
import { resolvePlanStoreDbPath } from "./plan-store.js";
import { resolveGovernorStateDbPath } from "./governor-state.js";
import { resolveAttemptLogDbPath } from "./attempt-log.js";
import { resolveReplaySnapshotDbPath } from "./replay-snapshot.js";
import { resolveWorktreeAllocatorDbPath } from "./worktree-allocator.js";
import { resolveContributionProfileCacheDbPath } from "./contribution-profile-cache.js";
import { resolvePolicyVerdictCacheDbPath } from "./policy-verdict-cache.js";
import { resolvePolicyDocCacheDbPath } from "./policy-doc-cache.js";
// Lazy, not module-scope: mirrors the loopover-engine repo-map.ts fix -- this file is CLI-only today, but
// an eager createRequire(import.meta.url)/import.meta.dirname at module scope would crash on import in any
// bundler context where import.meta is unavailable (e.g. if a future import chain pulls this into a Worker
// bundle, the way repo-map.ts was). Deferring construction to first real use keeps this import-safe.
let cachedRequire = null;
function requireFromHere() {
    return (cachedRequire ??= createRequire(import.meta.url));
}
let cachedModuleDir = null;
function moduleDir() {
    return (cachedModuleDir ??= import.meta.dirname);
}
const PACKAGE_NAME = "@loopover/miner";
const ENGINE_PACKAGE = "@loopover/engine";
// Config-file discovery order (mirrors the `.loopover-miner.yml` precedence the goal-spec parser documents).
const CONFIG_FILE_CANDIDATES = Object.freeze([
    ".loopover-miner.yml",
    ".github/loopover-miner.yml",
    ".loopover-miner.json",
    ".github/loopover-miner.json",
]);
/** The miner's local-state directory (holds the run-state / queue / ledger SQLite files). */
export function resolveMinerStateDir(env = process.env) {
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return explicitConfigDir;
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner");
}
/**
 * The REAL installed @loopover/engine version, for `status`'s own display. Prefers `readInstalled`
 * (the actually-resolved semver from node_modules/the monorepo workspace, the same real resolution `doctor`'s
 * engine-version-skew check already relies on) -- a self-hoster asking "what's installed" wants the real
 * answer, not the declared dependency RANGE ("*" in this monorepo, which tells them nothing). Falls back to
 * the declared range only if real resolution genuinely comes up empty (the engine package's `exports` map
 * blocks `require("<pkg>/package.json")` in some resolution orders, and its built `dist` may be absent
 * depending on build order) -- still better than reporting nothing at all.
 *
 * Exported + injectable (mirrors `buildEngineVersionSkewCheck`'s own `readInstalled` param): real resolution
 * succeeding is the only realistic case in a working install, so the fallback path needs a way to force it.
 */
export function buildEngineVersionDisplay(readInstalled = readInstalledEnginePackageVersion) {
    const installed = readInstalled();
    if (installed)
        return installed;
    return readDeclaredEngineDependencyRange();
}
/** The declared `@loopover/engine` dependency RANGE from this package's own package.json (e.g. "^3.2.1") --
 *  `buildEngineVersionDisplay`'s fallback when real resolution comes up empty. Split out (rather than inlined
 *  in `buildEngineVersionDisplay`) so its own require/parse failure path is independently testable via an
 *  injected `readPackageJson`, the same FsDeps-style seam the rest of this file already uses. */
export function readDeclaredEngineDependencyRange(readPackageJson = () => requireFromHere()("../package.json")) {
    try {
        const pkg = readPackageJson();
        return pkg.dependencies?.[ENGINE_PACKAGE] ?? null;
    }
    catch {
        return null;
    }
}
function readEngineVersion() {
    return buildEngineVersionDisplay();
}
export function readInstalledEnginePackageVersionFromPaths(resolvedEntry, workspacePkg, deps = { existsSync, readFileSync }) {
    try {
        for (const pkgJson of [join(resolvedEntry, "..", "package.json"), join(resolvedEntry, "..", "..", "package.json")]) {
            if (deps.existsSync(pkgJson)) {
                const version = JSON.parse(deps.readFileSync(pkgJson, "utf8")).version;
                if (version)
                    return version;
            }
        }
    }
    catch {
        // fall through to monorepo workspace fallback
    }
    if (deps.existsSync(workspacePkg)) {
        try {
            return JSON.parse(deps.readFileSync(workspacePkg, "utf8")).version ?? null;
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Installed @loopover/engine semver from node_modules (not the declared dependency range). `resolveEnginePackageEntry`
 *  is injectable (mirrors the rest of this file's FsDeps-style seams) so the "real resolution failed" fallback is
 *  independently testable without needing the actual install to be broken. */
export function readInstalledEnginePackageVersion(resolveEnginePackageEntry = () => requireFromHere().resolve(ENGINE_PACKAGE)) {
    const workspacePkg = join(moduleDir(), "../../loopover-engine/package.json");
    let resolvedEntry;
    try {
        resolvedEntry = resolveEnginePackageEntry();
    }
    catch {
        // Real resolution failed (the engine package's `exports` map blocks it, or its built `dist` is absent
        // depending on build order -- see buildEngineVersionDisplay's doc). There's no real entry path to derive
        // package.json candidates from; readInstalledEnginePackageVersionFromPaths's own workspace fallback already
        // handles "no candidate exists" (existsSync is simply false for a made-up path), so reuse it with a sentinel
        // here instead of hand-duplicating that same fallback a second time.
        resolvedEntry = join(moduleDir(), "__engine_resolve_failed__", "index.js");
    }
    return readInstalledEnginePackageVersionFromPaths(resolvedEntry, workspacePkg);
}
/** Expected minimum engine semver: monorepo engine package.json when present, else the shipped pin file. */
export function readExpectedEnginePackageVersionFromPaths(monorepoEnginePkg, pinFile, deps = { existsSync, readFileSync }) {
    if (deps.existsSync(monorepoEnginePkg)) {
        try {
            return JSON.parse(deps.readFileSync(monorepoEnginePkg, "utf8")).version ?? null;
        }
        catch {
            return null;
        }
    }
    try {
        const pinned = deps.readFileSync(pinFile, "utf8").trim();
        return pinned || null;
    }
    catch {
        return null;
    }
}
export function readExpectedEnginePackageVersion() {
    return readExpectedEnginePackageVersionFromPaths(join(moduleDir(), "../../loopover-engine/package.json"), join(moduleDir(), "../expected-engine.version"));
}
function parseSemverCore(version) {
    const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
/** Returns -1 when installed is behind expected, 0 when equal, 1 when ahead. */
export function compareInstalledEngineVersion(installed, expected) {
    const installedCore = parseSemverCore(installed);
    const expectedCore = parseSemverCore(expected);
    if (!installedCore || !expectedCore)
        return -1;
    for (let index = 0; index < 3; index += 1) {
        if (installedCore[index] < expectedCore[index])
            return -1;
        if (installedCore[index] > expectedCore[index])
            return 1;
    }
    return 0;
}
export function buildEngineVersionSkewCheck(readInstalled = readInstalledEnginePackageVersion, readExpected = readExpectedEnginePackageVersion) {
    const installed = readInstalled();
    const expected = readExpected();
    if (!expected) {
        return { name: "engine-version-skew", ok: true, detail: "expected engine version unavailable (skipped)" };
    }
    if (!installed) {
        return {
            name: "engine-version-skew",
            ok: false,
            detail: `${ENGINE_PACKAGE} not installed (cannot verify version skew)`,
        };
    }
    const comparison = compareInstalledEngineVersion(installed, expected);
    return {
        name: "engine-version-skew",
        ok: comparison >= 0,
        detail: comparison < 0
            ? `installed ${installed} is behind expected ${expected}`
            : `installed ${installed} (${comparison === 0 ? "matches" : "ahead of"} expected ${expected})`,
    };
}
function checkEngineVersionSkew() {
    return buildEngineVersionSkewCheck();
}
/** The `engine-resolves` doctor check (#2288). Extracted + injectable to match `buildEngineVersionSkewCheck`'s
 *  own shape -- the "genuinely unresolvable" (`ok: false`) branch can't be reached in a real working monorepo
 *  install, so it needs the same seam to be independently testable. */
export function buildEngineResolvesCheck(readEngineVersionImpl = readEngineVersion) {
    const engineVersion = readEngineVersionImpl();
    return {
        name: "engine-resolves",
        ok: engineVersion !== null,
        detail: engineVersion ? `${ENGINE_PACKAGE} ${engineVersion}` : `${ENGINE_PACKAGE} not resolvable`,
    };
}
/** The minimum Node major version from the package's `engines.node` floor (e.g. ">=22.13.0" → 22). `readEngines`
 *  is injectable so the "missing/malformed engines.node" fallback (0) is independently testable. */
export function requiredNodeMajor(readEngines = () => requireFromHere()("../package.json").engines) {
    const engines = readEngines();
    const match = typeof engines?.node === "string" ? engines.node.match(/(\d+)/) : null;
    return match ? Number(match[1]) : 0;
}
function discoverConfigFile(cwd) {
    for (const candidate of CONFIG_FILE_CANDIDATES) {
        const path = join(cwd, candidate);
        if (existsSync(path))
            return path;
    }
    return null;
}
// CLI names driver-factory.ts's resolved provider values that actually spawn a local subprocess -- "noop" and
// "agent-sdk" have no separate CLI binary to check presence for, so cliPresent is null (not applicable) for them.
const PROVIDER_CLI_BINARY = Object.freeze({ "claude-cli": "claude", "codex-cli": "codex" });
/** The `driver` section of `status`/`status --json` (#5164): which coding-agent provider is configured, the
 *  NAME (never the value) of its model env var, and whether its CLI binary is on PATH. Reuses
 *  `resolveFirstConfiguredCodingAgentDriverName`/`CODING_AGENT_DRIVER_CONFIG_ENV` (the same resolution
 *  driver-factory.ts uses) and `findExecutableOnPath` (the same PATH scan the doctor CLI-presence checks use)
 *  rather than duplicating either. Never reads or returns an env var's actual value. */
function resolveDriverStatus(env) {
    const provider = resolveFirstConfiguredCodingAgentDriverName(env) ?? null;
    const modelEnvVar = provider ? (CODING_AGENT_DRIVER_CONFIG_ENV[provider]?.model ?? null) : null;
    const cliBinary = provider ? (PROVIDER_CLI_BINARY[provider] ?? null) : null;
    const cliPresent = cliBinary ? Boolean(findExecutableOnPath(cliBinary, env)) : null;
    return { provider, modelEnvVar, cliPresent };
}
/** Gather the read-only status snapshot. Pure w.r.t. its (env, cwd) inputs — no writes, no network. */
export function collectStatus(env = process.env, cwd = process.cwd()) {
    const stateDir = resolveMinerStateDir(env);
    return {
        package: { name: PACKAGE_NAME, version: resolveMinerVersion(env) },
        engine: { name: ENGINE_PACKAGE, version: readEngineVersion() },
        node: process.version,
        stateDir,
        configFile: discoverConfigFile(cwd),
        driver: resolveDriverStatus(env),
    };
}
export function renderDriverLine(driver) {
    if (!driver.provider)
        return "driver: none configured";
    const cliText = driver.cliPresent === null ? "n/a" : driver.cliPresent ? "yes" : "no";
    const modelText = driver.modelEnvVar ? `, model env: ${driver.modelEnvVar}` : "";
    return `driver: ${driver.provider} (CLI present: ${cliText}${modelText})`;
}
export function renderStatusText(status) {
    return [
        `${status.package.name} ${status.package.version ?? "unknown"} (node ${status.node})`,
        `engine: ${status.engine.name} ${status.engine.version ?? "unresolved"}`,
        `state dir: ${status.stateDir}`,
        `config file: ${status.configFile ?? "none found"}`,
        renderDriverLine(status.driver),
    ].join("\n");
}
export function runStatus(args = [], env = process.env, cwd = process.cwd()) {
    const status = collectStatus(env, cwd);
    console.log(args.includes("--json") ? JSON.stringify(status, null, 2) : renderStatusText(status));
    return 0;
}
/** `deps` is injectable (FsDeps-style) so the "non-Error thrown value" defensive fallback in the detail message
 *  is independently testable -- real fs errors are always Error instances, so that branch can't be reached
 *  through a real mkdir/write/rm failure alone. */
export function checkStateDirWritable(stateDir, deps = { mkdirSync, writeFileSync, rmSync }) {
    const probe = join(stateDir, ".loopover-miner-write-probe");
    try {
        // Creating the dir and writing (then removing) a probe file proves it is writable — the state dir must be
        // creatable/writable for the local SQLite stores to work.
        deps.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        deps.writeFileSync(probe, "");
        deps.rmSync(probe, { force: true });
        return { name: "state-dir-writable", ok: true, detail: stateDir };
    }
    catch (error) {
        return {
            name: "state-dir-writable",
            ok: false,
            detail: `${stateDir}: ${error instanceof Error ? error.message : "not writable"}`,
        };
    }
}
/** Per-store `PRAGMA integrity_check` sweep for `doctor` (#4834) — flags a corrupted store instead of probing
 *  only one with `SELECT 1`. A store file that does not exist yet is healthy by absence. Keep in sync with
 *  migrate-cli.js's `STORES` list (#6768): every durable local SQLite store using resolveLocalStoreDbPath. */
function storeIntegrityChecks(env) {
    const stores = [
        ["event-ledger", resolveEventLedgerDbPath(env)],
        ["governor-ledger", resolveGovernorLedgerDbPath(env)],
        ["prediction-ledger", resolvePredictionLedgerDbPath(env)],
        ["portfolio-queue", resolvePortfolioQueueDbPath(env)],
        ["claim-ledger", resolveClaimLedgerDbPath(env)],
        ["run-state", resolveRunStateDbPath(env)],
        ["plan-store", resolvePlanStoreDbPath(env)],
        ["governor-state", resolveGovernorStateDbPath(env)],
        ["attempt-log", resolveAttemptLogDbPath(env)],
        ["replay-snapshot", resolveReplaySnapshotDbPath(env)],
        ["worktree-allocator", resolveWorktreeAllocatorDbPath(env)],
        ["contribution-profile", resolveContributionProfileCacheDbPath(env)],
        ["policy-verdict-cache", resolvePolicyVerdictCacheDbPath(env)],
        ["policy-doc-cache", resolvePolicyDocCacheDbPath(env)],
    ];
    return stores.map(([name, dbPath]) => checkStoreIntegrity(`store-integrity:${name}`, dbPath));
}
/** Validate the discovered `.loopover-miner` config's CONTENT (#4873), not just its path: parse it with the
 *  tolerant goal-spec parser and surface its warnings, so a malformed config is flagged by `doctor` rather than
 *  silently degrading to defaults. No config file is fine (defaults apply); a read failure is reported. `readImpl`
 *  is injectable for tests. */
export function checkConfigContent(cwd, readImpl = readFileSync) {
    const configPath = discoverConfigFile(cwd);
    if (!configPath) {
        return { name: "config-content", ok: true, detail: "no .loopover-miner config found (using defaults)" };
    }
    let warnings;
    try {
        warnings = parseMinerGoalSpecContent(readImpl(configPath, "utf8")).warnings;
    }
    catch (error) {
        return { name: "config-content", ok: false, detail: `${configPath}: ${describeError(error)}` };
    }
    return warnings.length === 0
        ? { name: "config-content", ok: true, detail: `${configPath}: valid` }
        : { name: "config-content", ok: false, detail: `${configPath}: ${warnings.join("; ")}` };
}
function nonEmptyEnv(value) {
    return typeof value === "string" && value.length > 0;
}
/** GitHub token presence (#5170, extended by #6116). A purely offline check — `doctor` never calls GitHub — but
 *  a missing token fails every real attempt the moment it tries to push a branch or open a PR, so surface it up
 *  front rather than mid-run. Checks BOTH a GITHUB_TOKEN env override AND a recorded `loopover-mcp login`
 *  session (hasGitHubTokenSource, offline: reads the local config file, makes no network call) -- otherwise a
 *  user who only ran `loopover-mcp login` (the new primary flow) would see a spurious "not set" warning even
 *  though AMS would resolve a live token from that session at attempt time. A session recorded here is not
 *  re-verified as still valid/unexpired -- only an actual attempt (or resolveGitHubToken itself) discovers
 *  that. Reports presence only; no token value is ever included in the detail. */
export function checkGitHubTokenPresent(env = process.env) {
    const present = hasGitHubTokenSource(env);
    return {
        name: "github-token",
        ok: present,
        detail: present
            ? "A GitHub token is available (GITHUB_TOKEN or a loopover-mcp login session)"
            : "No GitHub token available — run `loopover-mcp login`, or set GITHUB_TOKEN, before attempts that push a branch or open a PR",
    };
}
/** Credential presence for the CONFIGURED coding-agent provider (#5170). Distinct from the CLI-present checks,
 *  which by design keep `ok: true` when only the credential is missing (#5165): this FAILS `doctor` when the
 *  resolved provider's credential is absent, so an operator learns before an attempt fails partway through.
 *  Fully offline — an env-var string check for the Claude backends, a file-readability check for codex — and it
 *  never prints the credential value, only the env-var names / file path. `resolveAuthPath` is injectable for
 *  tests, mirroring `checkCodexCliPresent`. */
export function checkCodingAgentCredential(env = process.env, resolveAuthPath = resolveCodexAuthPath) {
    const provider = resolveFirstConfiguredCodingAgentDriverName(env) ?? null;
    if (provider === null || provider === "noop") {
        return {
            name: "coding-agent-credential",
            ok: true,
            detail: provider === "noop"
                ? "noop driver needs no credential"
                : "no coding-agent provider configured (skipped)",
        };
    }
    if (provider === "claude-cli" || provider === "agent-sdk") {
        // Both run the Claude backend (a `claude` subprocess vs the in-process Agent SDK) off the same subscription
        // OAuth token the rest of the tree reads (CLAUDE_CODE_OAUTH_TOKEN; see createClaudeCodeAi in
        // src/selfhost/ai.ts). The SDK additionally accepts a raw ANTHROPIC_API_KEY, so either satisfies the credential.
        const present = nonEmptyEnv(env.CLAUDE_CODE_OAUTH_TOKEN) || nonEmptyEnv(env.ANTHROPIC_API_KEY);
        return {
            name: "coding-agent-credential",
            ok: present,
            detail: present
                ? `${provider}: Claude credential is set`
                : `${provider}: no Claude credential — set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)`,
        };
    }
    // codex-cli: the only remaining configured provider — its credential is a readable auth.json, the same
    // read-only condition checkCodexCliPresent probes (reusing resolveCodexAuthPath so the location never drifts).
    const authPath = resolveAuthPath(env);
    let readable = false;
    try {
        accessSync(authPath, constants.R_OK);
        readable = true;
    }
    catch {
        // missing or unreadable — codex would fail for lack of credentials at attempt time.
    }
    return {
        name: "coding-agent-credential",
        ok: readable,
        detail: readable
            ? `codex-cli: auth.json is readable at ${authPath}`
            : `codex-cli: auth.json missing or unreadable at ${authPath} — run \`codex auth\``,
    };
}
/** Run the doctor checks. Returns an array of { name, ok, detail }; only writes a transient probe in the state dir,
 *  never touches the network. */
export function runDoctorChecks(env = process.env, cwd = process.cwd()) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const requiredMajor = requiredNodeMajor();
    return [
        {
            name: "node-version",
            ok: nodeMajor >= requiredMajor,
            detail: `node ${process.version} (requires >= ${requiredMajor})`,
        },
        buildEngineResolvesCheck(),
        checkEngineVersionSkew(),
        checkStateDirWritable(resolveMinerStateDir(env)),
        checkLaptopStateSqlite(env),
        checkDockerPresent(),
        checkClaudeCliPresent({ env }),
        checkCodexCliPresent({ env }),
        checkGitHubTokenPresent(env),
        checkCodingAgentCredential(env),
        checkConfigContent(cwd),
        ...storeIntegrityChecks(env),
    ];
}
export function runDoctor(args = [], env = process.env, cwd = process.cwd()) {
    const checks = runDoctorChecks(env, cwd);
    const failed = checks.filter((check) => !check.ok);
    if (args.includes("--json")) {
        console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
    }
    else {
        for (const check of checks)
            console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
        if (failed.length > 0)
            console.error(`doctor: ${failed.length} check(s) failed`);
    }
    return failed.length === 0 ? 0 : 1;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3RhdHVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDNUcsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUM1QyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDakMsT0FBTyxFQUNMLDhCQUE4QixFQUM5Qix5QkFBeUIsRUFDekIsMkNBQTJDLEdBRTVDLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUNMLHFCQUFxQixFQUNyQixvQkFBb0IsRUFDcEIsa0JBQWtCLEVBQ2xCLHNCQUFzQixFQUN0QixvQkFBb0IsRUFDcEIsb0JBQW9CLEdBQ3JCLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sY0FBYyxDQUFDO0FBQ25ELE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxhQUFhLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUM1RSxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUM3RCxPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNuRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSw4QkFBOEIsQ0FBQztBQUNwRSxPQUFPLEVBQUUsNkJBQTZCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUN2RSxPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNuRSxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUM3RCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFB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