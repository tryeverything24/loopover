export type MinerDriverStatus = {
    provider: string | null;
    modelEnvVar: string | null;
    cliPresent: boolean | null;
};
export type MinerStatus = {
    package: {
        name: string;
        version: string | null;
    };
    engine: {
        name: string;
        version: string | null;
    };
    node: string;
    stateDir: string;
    configFile: string | null;
    driver: MinerDriverStatus;
};
export type DoctorCheck = {
    name: string;
    ok: boolean;
    detail: string;
};
type FsDeps = {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: "utf8") => string;
};
/** The miner's local-state directory (holds the run-state / queue / ledger SQLite files). */
export declare function resolveMinerStateDir(env?: Record<string, string | undefined>): string;
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
export declare function buildEngineVersionDisplay(readInstalled?: () => string | null): string | null;
/** The declared `@loopover/engine` dependency RANGE from this package's own package.json (e.g. "^3.2.1") --
 *  `buildEngineVersionDisplay`'s fallback when real resolution comes up empty. Split out (rather than inlined
 *  in `buildEngineVersionDisplay`) so its own require/parse failure path is independently testable via an
 *  injected `readPackageJson`, the same FsDeps-style seam the rest of this file already uses. */
export declare function readDeclaredEngineDependencyRange(readPackageJson?: () => {
    dependencies?: Record<string, string>;
}): string | null;
export declare function readInstalledEnginePackageVersionFromPaths(resolvedEntry: string, workspacePkg: string, deps?: FsDeps): string | null;
/** Installed @loopover/engine semver from node_modules (not the declared dependency range). `resolveEnginePackageEntry`
 *  is injectable (mirrors the rest of this file's FsDeps-style seams) so the "real resolution failed" fallback is
 *  independently testable without needing the actual install to be broken. */
export declare function readInstalledEnginePackageVersion(resolveEnginePackageEntry?: () => string): string | null;
/** Expected minimum engine semver: monorepo engine package.json when present, else the shipped pin file. */
export declare function readExpectedEnginePackageVersionFromPaths(monorepoEnginePkg: string, pinFile: string, deps?: FsDeps): string | null;
export declare function readExpectedEnginePackageVersion(): string | null;
/** Returns -1 when installed is behind expected, 0 when equal, 1 when ahead. */
export declare function compareInstalledEngineVersion(installed: string, expected: string): -1 | 0 | 1;
export declare function buildEngineVersionSkewCheck(readInstalled?: () => string | null, readExpected?: () => string | null): DoctorCheck;
/** The `engine-resolves` doctor check (#2288). Extracted + injectable to match `buildEngineVersionSkewCheck`'s
 *  own shape -- the "genuinely unresolvable" (`ok: false`) branch can't be reached in a real working monorepo
 *  install, so it needs the same seam to be independently testable. */
export declare function buildEngineResolvesCheck(readEngineVersionImpl?: () => string | null): DoctorCheck;
/** The minimum Node major version from the package's `engines.node` floor (e.g. ">=22.13.0" → 22). `readEngines`
 *  is injectable so the "missing/malformed engines.node" fallback (0) is independently testable. */
export declare function requiredNodeMajor(readEngines?: () => {
    node?: string;
} | undefined): number;
/** Gather the read-only status snapshot. Pure w.r.t. its (env, cwd) inputs — no writes, no network. */
export declare function collectStatus(env?: Record<string, string | undefined>, cwd?: string): MinerStatus;
export declare function renderDriverLine(driver: MinerDriverStatus): string;
export declare function renderStatusText(status: MinerStatus): string;
export declare function runStatus(args?: string[], env?: Record<string, string | undefined>, cwd?: string): number;
type StateDirWritableDeps = {
    mkdirSync: (path: string, options: {
        recursive: boolean;
        mode: number;
    }) => unknown;
    writeFileSync: (path: string, data: string) => unknown;
    rmSync: (path: string, options: {
        force: boolean;
    }) => unknown;
};
/** `deps` is injectable (FsDeps-style) so the "non-Error thrown value" defensive fallback in the detail message
 *  is independently testable -- real fs errors are always Error instances, so that branch can't be reached
 *  through a real mkdir/write/rm failure alone. */
export declare function checkStateDirWritable(stateDir: string, deps?: StateDirWritableDeps): DoctorCheck;
/** Validate the discovered `.loopover-miner` config's CONTENT (#4873), not just its path: parse it with the
 *  tolerant goal-spec parser and surface its warnings, so a malformed config is flagged by `doctor` rather than
 *  silently degrading to defaults. No config file is fine (defaults apply); a read failure is reported. `readImpl`
 *  is injectable for tests. */
export declare function checkConfigContent(cwd: string, readImpl?: (path: string, encoding: "utf8") => string): DoctorCheck;
/** GitHub token presence (#5170, extended by #6116). A purely offline check — `doctor` never calls GitHub — but
 *  a missing token fails every real attempt the moment it tries to push a branch or open a PR, so surface it up
 *  front rather than mid-run. Checks BOTH a GITHUB_TOKEN env override AND a recorded `loopover-mcp login`
 *  session (hasGitHubTokenSource, offline: reads the local config file, makes no network call) -- otherwise a
 *  user who only ran `loopover-mcp login` (the new primary flow) would see a spurious "not set" warning even
 *  though AMS would resolve a live token from that session at attempt time. A session recorded here is not
 *  re-verified as still valid/unexpired -- only an actual attempt (or resolveGitHubToken itself) discovers
 *  that. Reports presence only; no token value is ever included in the detail. */
export declare function checkGitHubTokenPresent(env?: Record<string, string | undefined>): DoctorCheck;
/** Credential presence for the CONFIGURED coding-agent provider (#5170). Distinct from the CLI-present checks,
 *  which by design keep `ok: true` when only the credential is missing (#5165): this FAILS `doctor` when the
 *  resolved provider's credential is absent, so an operator learns before an attempt fails partway through.
 *  Fully offline — an env-var string check for the Claude backends, a file-readability check for codex — and it
 *  never prints the credential value, only the env-var names / file path. `resolveAuthPath` is injectable for
 *  tests, mirroring `checkCodexCliPresent`. */
export declare function checkCodingAgentCredential(env?: Record<string, string | undefined>, resolveAuthPath?: (env: Record<string, string | undefined>) => string): DoctorCheck;
/** Run the doctor checks. Returns an array of { name, ok, detail }; only writes a transient probe in the state dir,
 *  never touches the network. */
export declare function runDoctorChecks(env?: Record<string, string | undefined>, cwd?: string): DoctorCheck[];
export declare function runDoctor(args?: string[], env?: Record<string, string | undefined>, cwd?: string): number;
export {};
