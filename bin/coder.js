#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";

import { loadConfig, resolveConfig } from "../src/config.js";
import { logsDir } from "../src/logging.js";
import { runPpcommitAll, runPpcommitBranch } from "../src/ppcommit.js";
import { loadLoopState, loadState } from "../src/state/workflow-state.js";

function usage() {
  return `coder — management CLI for the coder MCP server

Subcommands:
  coder status [--workspace <path>] [--watch] [--json]
        Show current workflow state and progress.
        --watch  Refresh every 3 s until interrupted.
        --json   Output raw JSON.

  coder events [--workspace <path>] [--log <name>] [-n <count>]
               [--follow] [--run <runId>] [--json]
        Stream formatted log events from .coder/logs/<name>.jsonl.
        --log     Log file name without extension (default: develop).
                  Also accepts: machines, claude, gemini, codex, or any name.
        -n        Number of recent lines to show (default: 20).
        --follow  Follow the log file as new events are appended (like tail -f).
        --run     Filter by runId.
        --json    Output raw JSONL.

  coder config [--workspace <path>]
        Show resolved configuration.

  coder ppcommit [--base <branch>]
        Run ppcommit checks on the repository.
        Without --base: checks all files in the repo.
        With --base: checks only files changed since the given branch.

  coder serve [--transport stdio|http] [--port <port>]
        Start the MCP server (delegates to coder-mcp).

Workflows are orchestrated through the MCP server tools:
  - coder_workflow { action: "start", workflow: "develop|research|design" }
  - Individual machine tools: coder_develop_*, coder_research_*, coder_design_*
  - Status: coder_status, coder_workflow { action: "status" }
`;
}

// --- coder status ---

function formatStatusHuman(status) {
  const lines = [];
  lines.push("Coder Status");
  lines.push("============\n");

  if (status.selected) {
    lines.push(`Issue: ${status.selected.title}`);
    lines.push(
      `  Source: ${status.selected.source}  ID: ${status.selected.id}`,
    );
  } else {
    lines.push("Issue: (none selected)");
  }

  lines.push(`Repo: ${status.repoPath || "(not set)"}`);
  lines.push(`Branch: ${status.branch || "(not set)"}\n`);

  lines.push("Workflow:");
  lines.push(`  Run ID: ${status.workflow.runId || "(none)"}`);
  lines.push(`  Status: ${status.workflow.status}`);
  if (status.workflow.currentStage) {
    lines.push(`  Stage:  ${status.workflow.currentStage}`);
  }
  if (status.workflow.activeAgent) {
    lines.push(`  Agent:  ${status.workflow.activeAgent}`);
  }
  if (status.workflow.lastHeartbeatAt) {
    const ago = Math.round(
      (Date.now() - new Date(status.workflow.lastHeartbeatAt)) / 1000,
    );
    lines.push(
      `  Last heartbeat: ${ago}s ago (${status.workflow.lastHeartbeatAt.slice(11, 19)} UTC)`,
    );
  }

  if (status.workflow.issueQueue.length > 0) {
    lines.push(`  Queue: ${status.workflow.issueQueue.length} issues`);
    for (const e of status.workflow.issueQueue) {
      const statusIcon =
        { completed: "✓", failed: "✗", in_progress: "→", skipped: "~" }[
          e.status
        ] || " ";
      let detail = `    [${statusIcon}] ${e.source}:${e.id} — ${e.title}`;
      if (e.branch) detail += `\n         branch: ${e.branch}`;
      if (e.prUrl) detail += `\n         pr:     ${e.prUrl}`;
      if (e.error)
        detail += `\n         error:  ${String(e.error).slice(0, 100)}`;
      lines.push(detail);
    }
  }

  lines.push("\nArtifacts:");
  lines.push(
    `  ISSUE.md:      ${status.artifacts.issueExists ? "exists" : "missing"}`,
  );
  lines.push(
    `  PLAN.md:       ${status.artifacts.planExists ? "exists" : "missing"}`,
  );
  lines.push(
    `  PLANREVIEW.md: ${status.artifacts.critiqueExists ? "exists" : "missing"}`,
  );

  const steps = Object.entries(status.steps);
  if (steps.length > 0) {
    lines.push("\nSteps:");
    for (const [step, done] of steps) {
      lines.push(`  ${done ? "[x]" : "[ ]"} ${step}`);
    }
  }

  return lines.join("\n");
}

function buildStatus(workspaceDir) {
  const state = loadState(workspaceDir);
  const loopState = loadLoopState(workspaceDir);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");

  return {
    workspace: workspaceDir,
    selected: state.selected || null,
    repoPath: state.repoPath || null,
    branch: state.branch || null,
    steps: state.steps || {},
    workflow: {
      runId: loopState.runId || null,
      status: loopState.status || "idle",
      goal: loopState.goal || null,
      currentStage: loopState.currentStage || null,
      activeAgent: loopState.activeAgent || null,
      lastHeartbeatAt: loopState.lastHeartbeatAt || null,
      issueQueue: (loopState.issueQueue || []).map((e) => ({
        source: e.source,
        id: e.id,
        title: e.title,
        status: e.status,
        branch: e.branch || null,
        prUrl: e.prUrl || null,
        error: e.error || null,
      })),
    },
    artifacts: {
      issueExists: existsSync(path.join(artifactsDir, "ISSUE.md")),
      planExists: existsSync(path.join(artifactsDir, "PLAN.md")),
      critiqueExists: existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
    },
  };
}

function runStatusCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      json: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const printStatus = () => {
    const status = buildStatus(workspaceDir);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatStatusHuman(status)}\n`);
    }
  };

  if (values.watch) {
    // Clear screen and redraw every 3s
    const redraw = () => {
      process.stdout.write("\x1b[2J\x1b[H"); // clear screen, move cursor to top
      printStatus();
      process.stdout.write("\n\x1b[2m[watch mode — Ctrl+C to stop]\x1b[0m\n");
    };
    redraw();
    const timer = setInterval(redraw, 3000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.stdout.write("\n");
      process.exit(0);
    });
  } else {
    printStatus();
  }
}

// --- coder events ---

/** Detect whether a log name is an agent output log (stream+data fields). */
function isAgentLog(logName) {
  return ["claude", "gemini", "codex", "openai"].includes(logName);
}

/** Format a single develop/machines JSONL event as a human-readable line. */
function formatEventLine(d) {
  const ts = (d.ts || "").slice(11, 19); // HH:MM:SS
  const event = String(d.event || "?").padEnd(26);
  const runId = d.runId ? `[${String(d.runId).slice(0, 8)}] ` : "";

  // Build a compact details string from interesting fields
  const parts = [];
  if (d.stage) parts.push(d.stage);
  if (d.machine) parts.push(d.machine);
  const issueId =
    d.issue && typeof d.issue === "object"
      ? d.issue.id
      : (d.issueId ?? d.issue);
  if (issueId) parts.push(String(issueId));
  if (d.verdict) parts.push(`verdict=${d.verdict}`);
  if (d.count != null && d.event !== "develop_stage")
    parts.push(`count=${d.count}`);
  if (d.branch) parts.push(`branch=${d.branch}`);
  if (d.prUrl) parts.push(`pr=${d.prUrl}`);
  if (d.message) parts.push(String(d.message).slice(0, 80));
  if (d.error) parts.push(`ERROR: ${String(d.error).slice(0, 80)}`);

  const details = parts.join("  ") || "";
  return `${ts}  ${event}  ${runId}${details}`;
}

/** Format a single agent log line (stream + data fields). */
function formatAgentLine(d) {
  const ts = (d.ts || "").slice(11, 19);
  if (d.stream) {
    const tag = d.stream === "stderr" ? "[stderr]" : "[stdout]";
    const text = String(d.data || "").replace(/\n$/, "");
    // Indent continuation lines
    const indent = `${ts}          `;
    return text
      .split("\n")
      .map((line, i) =>
        i === 0 ? `${ts}  ${tag}  ${line}` : `${indent}${line}`,
      )
      .join("\n");
  }
  // Fallback: event-style
  return formatEventLine(d);
}

/** Read the last N JSONL lines from a file, filtered optionally by runId. */
function readLastLines(filePath, n, runIdFilter) {
  if (!existsSync(filePath)) return [];

  // Read the whole file — for typical log sizes this is fine
  const size = statSync(filePath).size;
  if (size === 0) return [];

  // Read up to 512KB from the tail to avoid loading huge files entirely
  const maxRead = Math.min(size, 512 * 1024);
  const buf = Buffer.allocUnsafe(maxRead);
  const fd = openSync(filePath, "r");
  readSync(fd, buf, 0, maxRead, size - maxRead);
  closeSync(fd);

  const text = buf.toString("utf8");
  const rawLines = text.split("\n").filter((l) => l.trim());

  const parsed = [];
  for (const line of rawLines) {
    try {
      const d = JSON.parse(line);
      if (!runIdFilter || d.runId === runIdFilter) parsed.push(d);
    } catch {
      // skip malformed lines
    }
  }

  return parsed.slice(-n);
}

async function runEventsCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      log: { type: "string", default: "develop" },
      n: { type: "string", default: "20" },
      follow: { type: "boolean", default: false },
      f: { type: "boolean", default: false },
      run: { type: "string", default: "" },
      json: { type: "boolean", default: false },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const logName = values.log;
  const count = Math.max(1, Number.parseInt(values.n, 10) || 20);
  const doFollow = values.follow || values.f;
  const runIdFilter = values.run || "";
  const logDir = logsDir(workspaceDir);

  // If no specific log given, list available logs when run with --log ''
  if (logName === "" || logName === "list") {
    if (existsSync(logDir)) {
      const files = readdirSync(logDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""));
      process.stdout.write(`Available logs: ${files.join(", ")}\n`);
    } else {
      process.stdout.write("No logs directory found.\n");
    }
    return;
  }

  const logFile = path.join(logDir, `${logName}.jsonl`);
  const agentLog = isAgentLog(logName);
  const formatLine = agentLog ? formatAgentLine : formatEventLine;

  const printLines = (lines) => {
    if (values.json) {
      for (const d of lines) process.stdout.write(`${JSON.stringify(d)}\n`);
    } else {
      for (const d of lines) process.stdout.write(`${formatLine(d)}\n`);
    }
  };

  // Initial display
  const initial = readLastLines(logFile, count, runIdFilter);
  if (initial.length === 0 && !doFollow) {
    process.stdout.write(
      `(no events${runIdFilter ? ` for run ${runIdFilter}` : ""} in ${logName}.jsonl)\n`,
    );
    return;
  }
  printLines(initial);

  if (!doFollow) return;

  // Follow mode: watch for new lines
  process.stdout.write(
    `\x1b[2m--- following ${logName}.jsonl (Ctrl+C to stop) ---\x1b[0m\n`,
  );

  // Track byte position to only read new content
  let position = existsSync(logFile) ? statSync(logFile).size : 0;
  let partial = ""; // incomplete line buffer

  const readNew = () => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size <= position) return;

    const toRead = size - position;
    const buf = Buffer.allocUnsafe(toRead);
    const fd = openSync(logFile, "r");
    const bytesRead = readSync(fd, buf, 0, toRead, position);
    closeSync(fd);
    position += bytesRead;

    const text = partial + buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    // Last element may be incomplete
    partial = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (!runIdFilter || d.runId === runIdFilter) {
          printLines([d]);
        }
      } catch {
        // skip malformed
      }
    }
  };

  // Watch the logs directory (file may not exist yet)
  const watchTarget = existsSync(logFile) ? logFile : logDir;
  const watcher = watch(watchTarget, { persistent: true }, (eventType) => {
    if (eventType === "change" || eventType === "rename") readNew();
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.stdout.write("\n");
    process.exit(0);
  });
}

// --- coder config ---

function runConfigCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const config = resolveConfig(workspaceDir);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

// --- coder ppcommit ---

async function runPpcommitCli() {
  const args = process.argv.slice(3);
  let baseBranch = "";
  let hasBase = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && i + 1 < args.length) {
      baseBranch = args[i + 1];
      hasBase = true;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
  }

  const repoDir = process.cwd();
  const isGit = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (isGit.status !== 0) {
    process.stderr.write("ERROR: Not a git repository.\n");
    process.exit(1);
  }

  const ppConfig = loadConfig(repoDir).ppcommit;

  let result;
  if (hasBase) {
    result = await runPpcommitBranch(repoDir, baseBranch, ppConfig);
  } else {
    result = await runPpcommitAll(repoDir, ppConfig);
  }
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// --- coder serve ---

function runServeCli() {
  const args = process.argv.slice(3);
  const binDir = new URL(".", import.meta.url).pathname;
  const mcpPath = path.join(binDir, "coder-mcp.js");
  const result = spawnSync(process.execPath, [mcpPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

// --- Subcommand dispatch ---

const subcommand = process.argv[2];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  process.stdout.write(usage());
  process.exit(0);
}

switch (subcommand) {
  case "status":
    runStatusCli();
    break;
  case "events":
    runEventsCli().catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "config":
    runConfigCli();
    break;
  case "ppcommit":
    runPpcommitCli().catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "serve":
    runServeCli();
    break;
  default:
    process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
    process.stdout.write(usage());
    process.exit(1);
}
