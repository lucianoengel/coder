import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";

import { resolveConfig } from "./config.js";
import { resolvePassEnv } from "./helpers.js";

/**
 * Workspace directory for config resolution: same rules as `coder-mcp` CLI
 * (`--workspace`, `--workspace=`), else cwd. Used before full CLI parsing so
 * env hydration loads the same merged coder.json as the rest of the server.
 */
export function earlyWorkspaceDirForMcp() {
  try {
    const { values } = nodeParseArgs({
      args: process.argv.slice(2),
      strict: false,
      options: {
        workspace: { type: "string", default: process.cwd() },
      },
    });
    return path.resolve(values.workspace || process.cwd());
  } catch {
    return process.cwd();
  }
}

/**
 * MCP hosts often start Node without ~/.bashrc exports. Merge PATH-adjacent: pull
 * values for the same env var names {@link resolvePassEnv} would forward (from
 * merged coder.json + login-shell `env`), so custom models.*.apiKeyEnv,
 * sandbox.passEnv, passEnvPatterns, and defaults stay aligned with the agent pipeline.
 */
export function hydrateMcpEnvFromLoginShell(workspaceDir) {
  let raw;
  try {
    raw = execSync("bash -ilc 'env'", {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return;
  }

  const loginEnv = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    loginEnv[key] = line.slice(eq + 1);
  }

  const mergedScan = { ...process.env, ...loginEnv };

  let config;
  try {
    config = resolveConfig(workspaceDir);
  } catch {
    return;
  }

  const names = resolvePassEnv(config, mergedScan);
  for (const key of names) {
    if (process.env[key]) continue;
    const v = mergedScan[key];
    if (v) process.env[key] = v;
  }
}
