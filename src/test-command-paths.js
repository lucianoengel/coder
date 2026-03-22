import { existsSync } from "node:fs";
import path from "node:path";

const SCRIPT_EXT = /\.(sh|bash|js|cjs|mjs)$/i;

/**
 * Thrown when a test setup/test/teardown command references a repo-relative path
 * that does not exist under the declared repo root (test cwd).
 */
export class TestCommandPathError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "TestCommandPathError";
    this.code = "TEST_COMMAND_PATH";
    this.details = details;
  }
}

/** Strip one pair of surrounding ' or " from a shell token. */
export function stripOuterShellQuotes(s) {
  const t = String(s).trim();
  if (t.length < 2) return t;
  const a = t[0];
  const b = t[t.length - 1];
  if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Tokens that look like repo-relative script paths (not bare shell builtins like `bash echo`).
 * @param {string} token - Raw capture from regex (may include quotes)
 */
function isLikelyScriptPath(token) {
  const inner = stripOuterShellQuotes(token);
  if (!inner || inner.startsWith("-") || inner.startsWith("/")) return false;
  if (/[$`\\]/.test(inner)) return false;
  if (/["']/.test(inner)) return false;
  if (
    !inner.includes("/") &&
    !inner.startsWith("./") &&
    !SCRIPT_EXT.test(inner)
  ) {
    return false;
  }
  return true;
}

function normalizeRepoRel(p) {
  return stripOuterShellQuotes(p).replace(/^\.\//, "");
}

/**
 * If the whole segment is a lone `cd <dir>`, return { applied, cwd }.
 */
function applyCdSegment(segment, cwd) {
  const s = segment.trim();
  // Quoted targets before `\S+`, otherwise `cd ".."` is parsed as dir name `".."` (quotes included).
  const dq = s.match(/^\s*cd\s+"([^"]*)"\s*$/);
  if (dq) {
    return { applied: true, cwd: path.resolve(cwd, dq[1]) };
  }
  const sq = s.match(/^\s*cd\s+'([^']*)'\s*$/);
  if (sq) {
    return { applied: true, cwd: path.resolve(cwd, sq[1]) };
  }
  const unquoted = s.match(/^\s*cd\s+(\S+)\s*$/);
  if (unquoted) {
    return { applied: true, cwd: path.resolve(cwd, unquoted[1]) };
  }
  return { applied: false, cwd };
}

/**
 * Heuristic extraction of repo-relative file paths from shell command strings.
 * Conservative: avoids bare words (e.g. `bash echo`) and absolute paths.
 * @param {string} cmd
 * @returns {string[]} unique relative paths (no leading ./)
 */
export function collectRelativePathsFromShellCommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  const out = new Set();

  const reShell = /\b(?:bash|sh|dash)\s+([^\s;|&]+)/g;
  for (;;) {
    const m = reShell.exec(cmd);
    if (!m) break;
    const token = m[1];
    if (!isLikelyScriptPath(token)) continue;
    out.add(normalizeRepoRel(token));
  }

  // Use && / || / ; / | explicitly — \b fails before & (both sides non-word).
  const reDot = /(?:^|&&|\|\||[;|])\s*\.\/([^\s;|&]+)/g;
  for (;;) {
    const m = reDot.exec(cmd);
    if (!m) break;
    const t = stripOuterShellQuotes(m[1]);
    if (/[$`'"]/.test(t)) continue;
    out.add(t);
  }

  const reNode = /\bnode\s+([^\s;|&]+)/g;
  for (;;) {
    const m = reNode.exec(cmd);
    if (!m) break;
    const token = m[1];
    if (!isLikelyScriptPath(token)) continue;
    out.add(normalizeRepoRel(token));
  }

  return [...out];
}

/**
 * Split on `&&` only so `cd .. && bash scripts/x.sh` can be modeled (simulated cwd).
 */
function splitAndChainSegments(cmd) {
  return cmd
    .split(/\s*&&\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function throwMissingPath(fullCmd, rel, abs, root, effectiveCwd, meta) {
  const hint = [
    "Fix: set issue repo_path (or workflow state.repo_path) to the directory that contains these files,",
    "or change test.setup / test.command / test.teardown (or testCmd) so paths exist under that repo root,",
    "or prefix with cd (e.g. cd .. && bash scripts/test.sh).",
  ].join(" ");

  const lines = [
    "Test command references a path that does not exist under the effective directory for this command.",
    `  command: ${fullCmd.length > 500 ? `${fullCmd.slice(0, 500)}…` : fullCmd}`,
    `  missing path (relative to effective cwd): ${rel}`,
    `  expected absolute path: ${abs}`,
    `  repo root (repo_root, initial cwd): ${root}`,
  ];
  if (path.resolve(effectiveCwd) !== path.resolve(root)) {
    lines.push(
      `  effective cwd (after cd in command): ${path.resolve(effectiveCwd)}`,
    );
  }
  if (meta.testConfigPath) {
    lines.push(`  testConfigPath: ${meta.testConfigPath}`);
  }
  if (meta.repoPath != null && meta.repoPath !== "") {
    lines.push(`  repo_path: ${meta.repoPath}`);
  }

  throw new TestCommandPathError(`${lines.join("\n")}\n${hint}`, {
    repoRoot: root,
    command: fullCmd,
    missingRelative: rel,
    missingAbsolute: abs,
    effectiveCwd: path.resolve(effectiveCwd),
    testConfigPath: meta.testConfigPath,
    repoPath: meta.repoPath,
  });
}

/**
 * @param {string} repoDir - Absolute repo root (test cwd)
 * @param {string[]} commands - Shell command strings (setup / test / teardown / testCmd)
 * @param {object} [meta]
 * @param {string} [meta.testConfigPath]
 * @param {string} [meta.repoPath]
 */
export function assertTestCommandPathsExist(repoDir, commands, meta = {}) {
  const root = path.resolve(repoDir);
  if (!path.isAbsolute(root)) {
    throw new TestCommandPathError(
      `repoDir must resolve to an absolute path, got: ${repoDir}`,
      { repoRoot: repoDir, ...meta },
    );
  }

  for (const cmd of commands) {
    const s = typeof cmd === "string" ? cmd.trim() : String(cmd).trim();
    if (!s) continue;

    const segments = splitAndChainSegments(s);
    let cwd = root;

    for (const segment of segments) {
      const { applied, cwd: nextCwd } = applyCdSegment(segment, cwd);
      if (applied) {
        cwd = nextCwd;
        continue;
      }

      for (const rel of collectRelativePathsFromShellCommand(segment)) {
        const abs = path.resolve(cwd, rel);
        if (!existsSync(abs)) {
          throwMissingPath(s, rel, abs, root, cwd, meta);
        }
      }
    }
  }
}
