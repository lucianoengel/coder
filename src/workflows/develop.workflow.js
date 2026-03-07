import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { buildDependencyGraph } from "../github/dependencies.js";
import { detectDefaultBranch, detectRemoteType } from "../helpers.js";
import { registerMachine } from "../machines/_registry.js";
import {
  artifactPaths,
  normalizeRepoPath,
  resolveRepoRoot,
} from "../machines/develop/_shared.js";
import implementationMachine from "../machines/develop/implementation.machine.js";
import issueDraftMachine from "../machines/develop/issue-draft.machine.js";
import issueListMachine from "../machines/develop/issue-list.machine.js";
import planReviewMachine from "../machines/develop/plan-review.machine.js";
import planningMachine from "../machines/develop/planning.machine.js";
import prCreationMachine from "../machines/develop/pr-creation.machine.js";
import qualityReviewMachine from "../machines/develop/quality-review.machine.js";
import {
  loadLoopState,
  loadState,
  saveLoopState,
  saveState,
  statePathFor,
} from "../state/workflow-state.js";
import { buildIssueBranchName } from "../worktrees.js";
import { runHooks, WorkflowRunner } from "./_base.js";

/**
 * Update the loop state heartbeat timestamp.
 */
async function updateHeartbeat(ctx) {
  try {
    const ls = await loadLoopState(ctx.workspaceDir);
    ls.lastHeartbeatAt = new Date().toISOString();
    await saveLoopState(ctx.workspaceDir, ls, { guardRunId: ls.runId });
  } catch {
    // Best-effort — don't fail the pipeline over a heartbeat update
  }
}

// Re-export machines for direct use
export {
  issueListMachine,
  issueDraftMachine,
  planningMachine,
  planReviewMachine,
  implementationMachine,
  qualityReviewMachine,
  prCreationMachine,
};

export const developMachines = [
  issueListMachine,
  issueDraftMachine,
  planningMachine,
  planReviewMachine,
  implementationMachine,
  qualityReviewMachine,
  prCreationMachine,
];

/**
 * Register all develop machines in the global registry.
 */
export function registerDevelopMachines() {
  for (const m of developMachines) {
    registerMachine(m);
  }
}

/**
 * Run the planning + plan-review loop (up to maxRounds) using an existing WorkflowRunner.
 * Between revision rounds, stale PLAN.md and PLANREVIEW.md are deleted so agents cannot
 * silently reuse old artifacts via file-existence fallback paths.
 *
 * @param {import("./_base.js").WorkflowRunner} runner
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 * @param {{ planningMachine: object, planReviewMachine: object, maxRounds?: number, activeBranches?: Array }} opts
 */
export async function runPlanLoop(
  runner,
  ctx,
  {
    planningMachine: pm,
    planReviewMachine: prm,
    maxRounds,
    activeBranches,
  } = {},
) {
  maxRounds = maxRounds ?? ctx.config?.workflow?.maxPlanRevisions ?? 3;
  const allResults = [];
  let priorCritique = "";

  for (let round = 0; round < maxRounds; round++) {
    if (round > 0) {
      const paths = artifactPaths(ctx.artifactsDir);
      rmSync(paths.plan, { force: true });
      rmSync(paths.critique, { force: true });
    }

    const planRound = await runner.run(
      [
        {
          machine: pm,
          inputMapper: () => ({
            priorCritique,
            activeBranches: activeBranches || [],
          }),
        },
      ],
      {},
    );
    allResults.push(...planRound.results);
    if (planRound.status !== "completed") {
      return {
        status: planRound.status,
        error: planRound.error,
        results: allResults,
      };
    }

    const reviewRound = await runner.run(
      [{ machine: prm, inputMapper: () => ({ round }) }],
      {},
    );
    allResults.push(...reviewRound.results);
    if (reviewRound.status !== "completed") {
      return {
        status: reviewRound.status,
        error: reviewRound.error,
        results: allResults,
      };
    }

    const verdict = reviewRound.results[0]?.data?.verdict;
    ctx.log({ event: "plan_review_verdict", verdict, round, maxRounds });

    const needsRevision = verdict === "REVISE" || verdict === "REJECT";
    if (!needsRevision || round === maxRounds - 1) {
      if (needsRevision && round === maxRounds - 1) {
        ctx.log({
          event: "plan_review_exhausted",
          lastVerdict: verdict,
          roundsUsed: round + 1,
          maxRounds,
        });
      }
      break;
    }

    priorCritique = reviewRound.results[0]?.data?.critiqueMd || "";
    const state = await loadState(ctx.workspaceDir);
    state.steps ||= {};
    state.steps.wroteCritique = false;
    await saveState(ctx.workspaceDir, state);
  }

  return { status: "completed", results: allResults };
}

/**
 * Run a function with retries suitable for machine execution.
 * Checks for "failed" status in the result. Respects cancellation between attempts.
 */
export async function runWithMachineRetry(
  fn,
  { maxRetries, backoffMs = 5000, ctx, onFailedAttempt },
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      if (ctx.cancelToken?.cancelled) {
        return { status: "cancelled", results: [] };
      }
      ctx.log({ event: "machine_retry_attempt", attempt, maxRetries });
      if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
    }
    const result = await fn();
    if (result.status !== "failed") return result;
    ctx.log({
      event: "machine_retry_failed",
      attempt,
      maxRetries,
      error: result.error,
    });
    if (typeof onFailedAttempt === "function") {
      await onFailedAttempt({ attempt, maxRetries, result });
    }
    if (attempt === maxRetries) return result;
  }
}

function findFailedMachineResult(result) {
  const results = Array.isArray(result?.results) ? result.results : [];
  for (let i = results.length - 1; i >= 0; i--) {
    const step = results[i];
    if (step?.status === "error" || step?.status === "failed") return step;
  }
  return null;
}

async function injectRetryFeedback(ctx, failedMachine, error) {
  const message = String(error || "").trim();
  if (!message) return;
  const paths = artifactPaths(ctx.artifactsDir);
  const note =
    "\n\n---\n## Retry Feedback\n\n" +
    `**${failedMachine} failed — fix these issues before re-submitting:**\n\n` +
    `\`\`\`\n${message}\n\`\`\`\n`;
  await appendFile(paths.critique, note, "utf8");
  ctx.log({ event: "retry_feedback_injected", machine: failedMachine });
}

/**
 * Run the full develop pipeline for a single issue.
 *
 * @param {{
 *   issue: { source: string, id: string, title: string },
 *   repoPath: string,
 *   clarifications?: string,
 *   baseBranch?: string,
 *   testCmd?: string,
 *   testConfigPath?: string,
 *   allowNoTests?: boolean,
 *   ppcommitPreset?: string,
 *   prType?: string,
 *   prSemanticName?: string,
 *   prTitle?: string,
 *   prDescription?: string,
 *   prBase?: string,
 *   force?: boolean,
 *   activeBranches?: Array<{ branch: string, issueId: string, title: string, diffStat: string }>,
 * }} opts
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 */
export async function runDevelopPipeline(opts, ctx) {
  const start = Date.now();
  const allResults = [];

  const runner = new WorkflowRunner({
    name: "develop",
    workflowContext: ctx,
    onStageChange: (stage) => {
      ctx.log({ event: "develop_stage", stage });
    },
  });

  // Phase 1: issue draft
  const phase1 = await runner.run(
    [
      {
        machine: issueDraftMachine,
        inputMapper: () => ({
          issue: opts.issue,
          repoPath: opts.repoPath,
          clarifications: opts.clarifications || "",
          baseBranch: opts.baseBranch,
          force: opts.force ?? false,
        }),
      },
    ],
    {},
  );
  allResults.push(...phase1.results);
  if (phase1.status !== "completed") {
    return { ...phase1, results: allResults, durationMs: Date.now() - start };
  }

  // Heartbeat after phase 1 (issue draft)
  await updateHeartbeat(ctx);

  if (ctx.cancelToken.cancelled) {
    return {
      status: "cancelled",
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Phase 2: planning + review loop
  const loopResult = await runPlanLoop(runner, ctx, {
    planningMachine,
    planReviewMachine,
    activeBranches: opts.activeBranches,
  });
  allResults.push(...loopResult.results);
  if (loopResult.status !== "completed") {
    return {
      status: loopResult.status,
      error: loopResult.error,
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Heartbeat after phase 2 (planning + review)
  await updateHeartbeat(ctx);

  if (ctx.cancelToken.cancelled) {
    return {
      status: "cancelled",
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Check for conflicts with active branches detected during planning.
  // Skipped when conflict detection is disabled via config.
  if (ctx.config?.workflow?.conflictDetection !== false) {
    const planPath = artifactPaths(ctx.artifactsDir).plan;
    if (existsSync(planPath)) {
      const planMd = readFileSync(planPath, "utf8").replace(/\r\n/g, "\n");
      const conflictMatch = planMd.match(
        /## CONFLICT_DETECTED\n+[-*]\s*branch:\s*(.+)\n+[-*]\s*reason:\s*(.+)/,
      );
      if (conflictMatch) {
        return {
          status: "deferred",
          reason: "conflict",
          conflictBranch: conflictMatch[1].trim(),
          error: `Conflicts with active branch ${conflictMatch[1].trim()}: ${conflictMatch[2].trim()}`,
          results: allResults,
          runId: runner.runId,
          durationMs: Date.now() - start,
        };
      }
    }
  }

  // Phase 3: implementation → quality-review → PR creation
  const maxMachineRetries = ctx.config?.workflow?.maxMachineRetries ?? 2;
  const retryBackoffMs = ctx.config?.workflow?.retryBackoffMs ?? 5000;
  const phase3 = await runWithMachineRetry(
    () =>
      runner.run(
        [
          {
            machine: implementationMachine,
            inputMapper: () => ({}),
          },
          {
            machine: qualityReviewMachine,
            inputMapper: () => ({
              testCmd: opts.testCmd || "",
              testConfigPath: opts.testConfigPath || "",
              allowNoTests: opts.allowNoTests ?? false,
              ppcommitPreset: opts.ppcommitPreset || "strict",
            }),
          },
          {
            machine: prCreationMachine,
            inputMapper: () => ({
              type: opts.prType || "feat",
              semanticName: opts.prSemanticName || "",
              title: opts.prTitle || "",
              description: opts.prDescription || "",
              base: opts.prBase || "",
            }),
          },
        ],
        {},
      ),
    {
      maxRetries: maxMachineRetries,
      backoffMs: retryBackoffMs,
      ctx,
      onFailedAttempt: async ({ attempt, maxRetries, result }) => {
        if (attempt >= maxRetries) return;
        const failed = findFailedMachineResult(result);
        if (failed?.machine !== "develop.quality_review") return;
        await injectRetryFeedback(
          ctx,
          failed.machine,
          failed.error || result.error || "",
        );
      },
    },
  );
  allResults.push(...phase3.results);

  // Heartbeat after phase 3 (implementation + review + PR)
  await updateHeartbeat(ctx);

  return { ...phase3, results: allResults, durationMs: Date.now() - start };
}

/**
 * Build a dependency-aware issue queue with topological sort and difficulty tie-breaking.
 *
 * @param {Array<{ id: string, difficulty?: number, depends_on?: string[], dependsOn?: string[] }>} issues
 * @returns {{ queue: typeof issues, rationale: { method: string, cycles: string[][], depEdges: number } }}
 */
function buildIssueQueue(issues) {
  // Normalize depends_on (support both field names)
  const normalized = issues.map((iss) => ({
    ...iss,
    dependsOn: iss.depends_on || iss.dependsOn || [],
  }));

  const hasDeps = normalized.some((iss) => iss.dependsOn.length > 0);
  if (!hasDeps) {
    // No dependencies — sort by difficulty (ascending), stable for ties
    const sorted = [...normalized].sort(
      (a, b) => (a.difficulty || 3) - (b.difficulty || 3),
    );
    return {
      queue: sorted,
      rationale: { method: "difficulty_sort", cycles: [], depEdges: 0 },
    };
  }

  // Topological sort respecting dependencies
  const { sorted: sortedIds, cycles } = buildDependencyGraph(normalized);
  const byId = new Map(normalized.map((iss) => [iss.id, iss]));

  // Apply difficulty tie-break within each dependency tier
  const inDegreeMap = new Map();
  for (const iss of normalized) {
    const internalDeps = iss.dependsOn.filter((d) => byId.has(d));
    inDegreeMap.set(iss.id, internalDeps.length);
  }

  // Group by tier (same in-degree level in the topological order)
  const queue = sortedIds.map((id) => byId.get(id)).filter(Boolean);

  const depEdges = normalized.reduce(
    (sum, iss) => sum + iss.dependsOn.filter((d) => byId.has(d)).length,
    0,
  );

  return {
    queue,
    rationale: {
      method: "topological_sort",
      cycles,
      depEdges,
    },
  };
}

/**
 * Resolve the base branch for an issue from its completed dependencies.
 *
 * @param {Array<{ id: string, dependsOn?: string[] }>} issue
 * @param {Map<string, { status: string, branch?: string }>} outcomeMap
 * @returns {{ baseBranch: string | null, allDepsFailed: boolean, depOutcomes: object }}
 */
function resolveDependencyBranch(issue, outcomeMap) {
  const deps = issue.dependsOn || issue.depends_on || [];
  if (deps.length === 0) {
    return { baseBranch: null, allDepsFailed: false, depOutcomes: {} };
  }

  const outcomes = {};
  let failCount = 0;
  let baseBranch = null;

  for (const depId of deps) {
    const outcome = outcomeMap.get(depId);
    if (!outcome) {
      outcomes[depId] = "pending";
      continue;
    }
    outcomes[depId] = outcome.status;
    if (outcome.status === "completed" && outcome.branch) {
      // Use the first successful dependency branch as base
      if (!baseBranch) baseBranch = outcome.branch;
    } else if (outcome.status === "failed" || outcome.status === "skipped") {
      failCount++;
    }
  }

  const knownDeps = deps.filter((d) => outcomeMap.has(d));
  const allDepsFailed = knownDeps.length > 0 && failCount === knownDeps.length;

  return { baseBranch, allDepsFailed, depOutcomes: outcomes };
}

const isRateLimitError = (text) =>
  /rate limit|429|resource_exhausted|quota/i.test(String(text || ""));

/**
 * Fetch open PR/MR branches and their diff stats from the hosting platform.
 * Returns an array of { branch, issueId, title, diffStat } suitable for
 * activeBranches. Best-effort: returns [] on failure.
 *
 * @param {string} repoRoot
 * @param {string} defaultBranch
 * @param {(e: object) => void} log
 * @returns {Array<{ branch: string, issueId: string, title: string, diffStat: string }>}
 */
export function fetchOpenPrBranches(repoRoot, defaultBranch, log) {
  try {
    const platform = detectRemoteType(repoRoot);
    let prs;

    if (platform === "gitlab") {
      const res = spawnSync(
        "glab",
        ["mr", "list", "--state", "opened", "--output", "json"],
        { cwd: repoRoot, encoding: "utf8", timeout: 15000 },
      );
      if (res.status !== 0 || !res.stdout) {
        if (log)
          log({
            event: "open_prs_fetch_failed",
            error: (res.stderr || "glab failed").trim(),
          });
        return [];
      }
      const mrs = JSON.parse(res.stdout);
      prs = (Array.isArray(mrs) ? mrs : []).map((mr) => ({
        branch: mr.source_branch,
        id: `!${mr.iid}`,
        title: mr.title || "",
        fetchRef: `refs/merge-requests/${mr.iid}/head`,
      }));
    } else {
      const res = spawnSync(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--json",
          "headRefName,title,number",
          "--limit",
          "50",
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 15000 },
      );
      if (res.status !== 0 || !res.stdout) {
        if (log)
          log({
            event: "open_prs_fetch_failed",
            error: (res.stderr || "gh failed").trim(),
          });
        return [];
      }
      const items = JSON.parse(res.stdout);
      prs = (Array.isArray(items) ? items : []).map((pr) => ({
        branch: pr.headRefName,
        id: `#${pr.number}`,
        title: pr.title || "",
        fetchRef: `pull/${pr.number}/head`,
      }));
    }

    const result = [];
    for (const pr of prs) {
      // Use the platform-specific PR ref to fetch; this works for both
      // same-repo and fork-based PRs without needing the branch on origin.
      const localRef = `pr-fetch/${pr.id}`;
      const fetchRes = spawnSync(
        "git",
        ["fetch", "origin", `${pr.fetchRef}:${localRef}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 10000 },
      );
      if (fetchRes.status !== 0) continue;
      const stat = spawnSync(
        "git",
        ["diff", "--stat", `${defaultBranch}...${localRef}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 10000 },
      );
      if (stat.status !== 0) continue;
      const diffStat = (stat.stdout || "").trim();
      if (!diffStat) continue;
      result.push({
        branch: pr.branch,
        issueId: pr.id,
        title: pr.title,
        diffStat,
      });
    }

    if (log) {
      log({ event: "open_prs_fetched", platform, count: result.length });
    }
    return result;
  } catch (err) {
    if (log) {
      log({ event: "open_prs_fetch_failed", error: err.message });
    }
    return [];
  }
}

/**
 * Run the autonomous develop loop — process multiple issues.
 */
export async function runDevelopLoop(opts, ctx) {
  const {
    goal = "resolve all assigned issues",
    projectFilter,
    maxIssues = 10,
    destructiveReset = false,
    testCmd,
    testConfigPath,
    allowNoTests = false,
    issueSource = "",
    localIssuesDir = "",
    ppcommitPreset = "",
    issueIds = [],
  } = opts;

  // List issues (local or remote)
  const listResult = await issueListMachine.run(
    {
      projectFilter,
      issueSource: issueSource || undefined,
      localIssuesDir,
      issueIds: issueIds.length > 0 ? issueIds : undefined,
    },
    ctx,
  );
  if (listResult.status !== "ok") {
    return {
      status: "failed",
      error: listResult.error || "Issue listing failed",
      results: [],
    };
  }

  const rawIssues = listResult.data.issues.slice(0, maxIssues);
  if (rawIssues.length === 0) {
    return {
      status: "completed",
      results: [],
      completed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  // Build dependency-aware queue
  const { queue: issues, rationale } = buildIssueQueue(rawIssues);

  ctx.log({
    event: "queue_built",
    method: rationale.method,
    depEdges: rationale.depEdges,
    cycles: rationale.cycles.length,
    count: issues.length,
    order: issues.map((i) => i.id),
    source: listResult.data.source || "remote",
  });

  // Initialize loop state — merge terminal statuses from prior run
  const loopState = await loadLoopState(ctx.workspaceDir);
  const priorQueue = loopState.issueQueue || [];
  const priorById = new Map(priorQueue.map((q) => [q.id, q]));

  loopState.status = "running";
  loopState.issueQueue = issues.map((iss) => {
    const prior = priorById.get(iss.id);
    const isTerminal =
      prior && ["completed", "failed", "skipped"].includes(prior.status);
    return {
      ...iss,
      dependsOn: iss.dependsOn || iss.depends_on || [],
      status: isTerminal ? prior.status : "pending",
      branch: isTerminal ? prior.branch : null,
      prUrl: isTerminal ? prior.prUrl : null,
      error: isTerminal ? prior.error : null,
      baseBranch: isTerminal ? prior.baseBranch : null,
      startedAt: isTerminal ? prior.startedAt : null,
      completedAt: isTerminal ? prior.completedAt : null,
    };
  });
  loopState.currentIndex = 0;
  loopState.startedAt = new Date().toISOString();
  const prevLoopRunId = loopState.runId;
  loopState.runId = ctx.runId || loopState.runId;
  await saveLoopState(ctx.workspaceDir, loopState, {
    guardRunId: prevLoopRunId,
  });

  const loopRunId = randomUUID().slice(0, 8);
  runHooks(ctx, loopRunId, "loop_start", "", {
    status: "running",
    total: issues.length,
    method: rationale.method,
  });

  // Resolve repo root and default branch once for the entire loop
  const loopRepoRoot = resolveRepoRoot(ctx.workspaceDir, ".");
  const defaultBranch = detectDefaultBranch(loopRepoRoot);

  /** @type {Map<string, { status: string, branch?: string, diffSummary?: string, repoPath?: string }>} */
  const outcomeMap = new Map();
  const results = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  // Seed outcomeMap from ALL terminal issues in the prior run (includes
  // issues no longer in the active list, e.g. closed/merged).
  // For completed branches, compute diffSummary so they can serve as
  // fallback conflict context when open-PR fetching is unavailable.
  for (const prior of priorQueue) {
    if (!["completed", "failed", "skipped"].includes(prior.status)) continue;
    const priorRepoPath = normalizeRepoPath(ctx.workspaceDir, prior.repo_path);
    const entry = {
      status: prior.status,
      branch: prior.branch || undefined,
      repoPath: priorRepoPath,
    };
    if (prior.status === "completed" && prior.branch) {
      const priorRepoRoot = resolveRepoRoot(ctx.workspaceDir, priorRepoPath);
      const priorDefault = detectDefaultBranch(priorRepoRoot);
      const stat = spawnSync(
        "git",
        ["diff", "--stat", `${priorDefault}...${prior.branch}`],
        { cwd: priorRepoRoot, encoding: "utf8", timeout: 5000 },
      );
      if (stat.status === 0) {
        entry.diffSummary = (stat.stdout || "").trim() || undefined;
      }
    }
    outcomeMap.set(prior.id, entry);
  }
  for (const entry of loopState.issueQueue) {
    if (entry.status === "completed") completed++;
    else if (entry.status === "failed") failed++;
    else if (entry.status === "skipped") skipped++;
  }

  // Helper: process a single issue
  async function processIssue(issue, i, { isRetry = false } = {}) {
    const currentStatus = loopState.issueQueue[i].status;
    if (["completed", "failed", "skipped"].includes(currentStatus)) {
      results.push({
        ...issue,
        status: currentStatus,
        branch: loopState.issueQueue[i].branch,
        prUrl: loopState.issueQueue[i].prUrl,
        error: loopState.issueQueue[i].error,
      });
      return currentStatus;
    }

    loopState.currentIndex = i;
    loopState.currentStage = isRetry ? "retry" : "processing";
    loopState.lastHeartbeatAt = new Date().toISOString();
    loopState.issueQueue[i].status = "in_progress";
    loopState.issueQueue[i].branch = buildIssueBranchName(issue);
    loopState.issueQueue[i].startedAt = new Date().toISOString();
    await saveLoopState(ctx.workspaceDir, loopState, {
      guardRunId: loopState.runId,
    });

    const issueEnv = {
      CODER_HOOK_ISSUE_ID: String(issue.id || ""),
      CODER_HOOK_ISSUE_TITLE: String(issue.title || ""),
    };
    runHooks(ctx, loopRunId, "issue_start", "", {}, issueEnv);

    const { baseBranch, allDepsFailed, depOutcomes } = resolveDependencyBranch(
      issue,
      outcomeMap,
    );

    if (allDepsFailed) {
      ctx.log({
        event: "issue_skipped",
        issueId: issue.id,
        reason: "all_dependencies_failed",
        depOutcomes,
      });
      loopState.issueQueue[i].status = "skipped";
      loopState.issueQueue[i].error = "All dependencies failed";
      outcomeMap.set(issue.id, { status: "skipped" });
      skipped++;
      results.push({
        ...issue,
        status: "skipped",
        error: "All dependencies failed",
      });
      await saveLoopState(ctx.workspaceDir, loopState, {
        guardRunId: loopState.runId,
      });
      runHooks(
        ctx,
        loopRunId,
        "issue_skipped",
        "",
        { status: "skipped", reason: "all_dependencies_failed" },
        issueEnv,
      );
      return "skipped";
    }

    // Defer if any dependency hasn't been processed yet (first pass only)
    const hasUnresolvedDeps = Object.values(depOutcomes).some(
      (s) => s === "pending",
    );
    if (hasUnresolvedDeps && !isRetry) {
      ctx.log({ event: "issue_deferred", issueId: issue.id, depOutcomes });
      loopState.issueQueue[i].status = "deferred";
      await saveLoopState(ctx.workspaceDir, loopState, {
        guardRunId: loopState.runId,
      });
      runHooks(
        ctx,
        loopRunId,
        "issue_deferred",
        "",
        { status: "deferred" },
        issueEnv,
      );
      return "deferred";
    }

    if (baseBranch) {
      ctx.log({
        event: "dependency_branch_resolved",
        issueId: issue.id,
        baseBranch,
        depOutcomes,
      });
      loopState.issueQueue[i].baseBranch = baseBranch;
    }

    const repoPath = normalizeRepoPath(ctx.workspaceDir, issue.repo_path);
    const issueRepoRoot = resolveRepoRoot(ctx.workspaceDir, repoPath);

    // Pull latest default branch to pick up any PRs merged while
    // earlier issues were being processed.
    const pullResult = spawnSync("git", ["pull", "--ff-only"], {
      cwd: issueRepoRoot,
      encoding: "utf8",
    });
    if (pullResult.status !== 0) {
      ctx.log({
        event: "git_pull_failed",
        issueId: issue.id,
        stderr: (pullResult.stderr || "").trim().slice(0, 200),
      });
    }

    // Resolve per-issue default branch (may differ from workspace root
    // when issue.repo_path targets a different repo).
    const issueDefaultBranch = detectDefaultBranch(issueRepoRoot);

    // Build active branch context for conflict detection (skipped when disabled).
    let activeBranches = [];
    if (ctx.config?.workflow?.conflictDetection !== false) {
      const openPrBranches = fetchOpenPrBranches(
        issueRepoRoot,
        issueDefaultBranch,
        ctx.log,
      );
      const seenBranches = new Set(openPrBranches.map((b) => b.branch));

      // Add current-run completed branches not already covered by open PRs,
      // filtering to only those from the same repo to avoid cross-repo contamination.
      for (const [id, outcome] of outcomeMap) {
        if (
          outcome.status === "completed" &&
          outcome.branch &&
          outcome.diffSummary &&
          outcome.repoPath === repoPath &&
          !seenBranches.has(outcome.branch)
        ) {
          const entry = loopState.issueQueue.find((q) => q.id === id);
          openPrBranches.push({
            branch: outcome.branch,
            issueId: id,
            title: entry?.title || "",
            diffStat: outcome.diffSummary,
          });
          seenBranches.add(outcome.branch);
        }
      }
      activeBranches = openPrBranches;
    }

    try {
      const pipelineResult = await runDevelopPipeline(
        {
          issue,
          repoPath,
          clarifications: `Autonomous mode. Goal: ${goal}`,
          baseBranch: baseBranch || undefined,
          prBase: baseBranch || "",
          testCmd,
          testConfigPath,
          allowNoTests,
          ppcommitPreset,
          force: true,
          activeBranches,
        },
        ctx,
      );

      // Conflict-based deferral: planner detected overlap with an active branch
      if (pipelineResult.status === "deferred") {
        ctx.log({
          event: "issue_deferred_conflict",
          issueId: issue.id,
          conflictBranch: pipelineResult.conflictBranch,
          error: pipelineResult.error,
        });

        // Clear planning cache so the planner re-runs on retry with updated branches
        const deferState = await loadState(ctx.workspaceDir);
        deferState.steps ||= {};
        deferState.steps.wrotePlan = false;
        deferState.steps.wroteCritique = false;
        await saveState(ctx.workspaceDir, deferState);

        const deferPaths = artifactPaths(ctx.artifactsDir);
        if (existsSync(deferPaths.plan))
          rmSync(deferPaths.plan, { force: true });
        if (existsSync(deferPaths.critique))
          rmSync(deferPaths.critique, { force: true });

        loopState.issueQueue[i].status = "deferred";
        loopState.issueQueue[i].error = pipelineResult.error;
        await saveLoopState(ctx.workspaceDir, loopState, {
          guardRunId: loopState.runId,
        });

        // Phase 1+2 ran, so workspace is on the issue branch — reset it
        await resetForNextIssue(ctx.workspaceDir, repoPath, {
          destructiveReset,
          issueStatus: "deferred",
        });

        runHooks(
          ctx,
          loopRunId,
          "issue_deferred",
          "",
          { status: "deferred", reason: "conflict" },
          issueEnv,
        );
        return "deferred";
      }

      if (pipelineResult.status === "completed") {
        const prResult =
          pipelineResult.results[pipelineResult.results.length - 1];
        const branch = prResult?.data?.branch;
        loopState.issueQueue[i].status = "completed";
        loopState.issueQueue[i].branch = branch;
        loopState.issueQueue[i].prUrl = prResult?.data?.prUrl;

        // Record diff stats so subsequent issues can detect file overlap
        const diffStat = spawnSync(
          "git",
          ["diff", "--stat", `${issueDefaultBranch}...${branch}`],
          { cwd: issueRepoRoot, encoding: "utf8" },
        );
        const diffSummary = (diffStat.stdout || "").trim();
        outcomeMap.set(issue.id, {
          status: "completed",
          branch,
          diffSummary,
          repoPath,
        });
        completed++;
        results.push({
          ...issue,
          status: "completed",
          prUrl: prResult?.data?.prUrl,
          branch,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_complete",
          "",
          { status: "completed", prUrl: prResult?.data?.prUrl, branch },
          issueEnv,
        );
      } else {
        const errText = pipelineResult.error || "";
        if (isRateLimitError(errText) && !isRetry) {
          ctx.log({ event: "issue_rate_limited", issueId: issue.id });
          loopState.issueQueue[i].status = "deferred";
          loopState.issueQueue[i].error = errText;
          await saveLoopState(ctx.workspaceDir, loopState, {
            guardRunId: loopState.runId,
          });
          runHooks(
            ctx,
            loopRunId,
            "issue_deferred",
            "",
            { status: "deferred" },
            issueEnv,
          );
          return "deferred";
        }
        loopState.issueQueue[i].status = "failed";
        loopState.issueQueue[i].error = errText;
        outcomeMap.set(issue.id, { status: "failed" });
        failed++;
        results.push({
          ...issue,
          status: "failed",
          error: errText,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_failed",
          "",
          { status: "failed", error: errText },
          issueEnv,
        );
      }
    } catch (err) {
      if (isRateLimitError(err.message) && !isRetry) {
        ctx.log({ event: "issue_rate_limited", issueId: issue.id });
        loopState.issueQueue[i].status = "deferred";
        loopState.issueQueue[i].error = err.message;
        await saveLoopState(ctx.workspaceDir, loopState, {
          guardRunId: loopState.runId,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_deferred",
          "",
          { status: "deferred" },
          issueEnv,
        );
        return "deferred";
      }
      loopState.issueQueue[i].status = "failed";
      loopState.issueQueue[i].error = err.message;
      outcomeMap.set(issue.id, { status: "failed" });
      failed++;
      results.push({ ...issue, status: "failed", error: err.message });
      runHooks(
        ctx,
        loopRunId,
        "issue_failed",
        "",
        { status: "failed", error: err.message },
        issueEnv,
      );
    }

    await saveLoopState(ctx.workspaceDir, loopState, {
      guardRunId: loopState.runId,
    });

    // Reset between issues
    const issueStatus = loopState.issueQueue[i].status;
    await resetForNextIssue(ctx.workspaceDir, repoPath, {
      destructiveReset,
      issueStatus,
    });
    return issueStatus;
  }

  // Main pass
  for (let i = 0; i < issues.length; i++) {
    if (ctx.cancelToken.cancelled) break;
    const issueStatus = await processIssue(issues[i], i);
    if (issueStatus !== "failed") continue;

    const failedIssueId = issues[i]?.id;
    ctx.log({
      event: "loop_aborted_on_failure",
      issueId: failedIssueId,
      reason: "issue_failed",
    });

    for (let j = 0; j < loopState.issueQueue.length; j++) {
      const entry = loopState.issueQueue[j];
      if (entry.status !== "pending" && entry.status !== "deferred") continue;

      entry.status = "skipped";
      entry.error = "Skipped: prior issue failed";
      entry.completedAt = new Date().toISOString();
      outcomeMap.set(entry.id, { status: "skipped" });
      skipped++;

      const issueEnv = {
        CODER_HOOK_ISSUE_ID: String(entry.id || ""),
        CODER_HOOK_ISSUE_TITLE: String(entry.title || ""),
      };
      ctx.log({
        event: "issue_skipped",
        issueId: entry.id,
        reason: "aborted_after_failure",
        failedIssueId,
      });
      runHooks(
        ctx,
        loopRunId,
        "issue_skipped",
        "",
        {
          status: "skipped",
          reason: "aborted_after_failure",
          failedIssueId,
        },
        issueEnv,
      );

      results.push({
        ...issues[j],
        status: "skipped",
        error: entry.error,
      });
    }

    await saveLoopState(ctx.workspaceDir, loopState, {
      guardRunId: loopState.runId,
    });
    break;
  }

  // Retry pass for deferred issues whose dependencies are now resolved
  const deferredIndices = issues
    .map((_, i) => i)
    .filter((i) => loopState.issueQueue[i].status === "deferred");

  if (deferredIndices.length > 0 && !ctx.cancelToken.cancelled) {
    ctx.log({
      event: "deferred_retry_pass",
      count: deferredIndices.length,
      ids: deferredIndices.map((i) => issues[i].id),
    });

    for (const i of deferredIndices) {
      if (ctx.cancelToken.cancelled) break;
      await processIssue(issues[i], i, { isRetry: true });
    }
  }

  // Coalesce pass: summary and cleanup
  const stillDeferred = loopState.issueQueue.filter(
    (q) => q.status === "deferred",
  ).length;
  ctx.log({
    event: "loop_summary",
    total: issues.length,
    completed,
    failed,
    skipped,
    deferred: stillDeferred,
  });

  // Smart branch cleanup: only delete branches with no commits beyond default
  const failedOrSkipped = loopState.issueQueue.filter(
    (q) => q.status === "failed" || q.status === "skipped",
  );
  if (failedOrSkipped.length > 0) {
    const deleted = [];
    const kept = [];
    for (const q of failedOrSkipped) {
      const branch = q.branch || buildIssueBranchName(q);
      const verify = spawnSync("git", ["rev-parse", "--verify", branch], {
        cwd: loopRepoRoot,
        encoding: "utf8",
      });
      if (verify.status !== 0) continue; // branch never created

      const log = spawnSync(
        "git",
        ["log", `${defaultBranch}..${branch}`, "--oneline"],
        { cwd: loopRepoRoot, encoding: "utf8" },
      );
      const hasCommits = (log.stdout || "").trim().length > 0;

      if (hasCommits) {
        kept.push(branch);
      } else {
        spawnSync("git", ["branch", "-D", branch], {
          cwd: loopRepoRoot,
          encoding: "utf8",
        });
        deleted.push(branch);
      }
    }
    ctx.log({ event: "smart_branch_cleanup", deleted, kept });
  }

  // Agent-driven coalesce analysis for cross-branch integration review
  const completedBranches = loopState.issueQueue.filter(
    (q) => q.status === "completed" && q.branch,
  );
  if (completedBranches.length >= 2 && !ctx.cancelToken.cancelled) {
    try {
      ctx.log({
        event: "coalesce_analysis_start",
        branches: completedBranches.map((q) => q.branch),
      });

      const branchDiffs = [];
      for (const q of completedBranches) {
        const stat = spawnSync(
          "git",
          ["diff", `${defaultBranch}...${q.branch}`, "--stat"],
          { cwd: loopRepoRoot, encoding: "utf8" },
        );
        const diff = spawnSync(
          "git",
          ["diff", `${defaultBranch}...${q.branch}`],
          { cwd: loopRepoRoot, encoding: "utf8" },
        );
        branchDiffs.push({
          branch: q.branch,
          issueId: q.id,
          title: q.title,
          stat: (stat.stdout || "").trim(),
          diff: (diff.stdout || "").slice(0, 8000),
        });
      }

      const diffSections = branchDiffs
        .map(
          (d) =>
            `## Branch: ${d.branch} (Issue ${d.issueId}: ${d.title})\n\n### File Stats\n\`\`\`\n${d.stat}\n\`\`\`\n\n### Diff (truncated)\n\`\`\`diff\n${d.diff}\n\`\`\``,
        )
        .join("\n\n---\n\n");

      const prompt = `You are reviewing the combined changeset from ${completedBranches.length} feature branches that were implemented in parallel against the same base branch (${defaultBranch}).

Your task is to analyze the branches for integration issues and produce a structured report.

${diffSections}

Analyze and produce a markdown report with these sections:
1. **Overlapping File Changes** — files modified by multiple branches, with risk assessment
2. **Duplicate Code / Helpers** — similar functions, utilities, or patterns introduced independently
3. **Potential Merge Conflicts** — specific regions likely to conflict when merging
4. **Cross-Cutting Concerns** — shared changes (config, types, deps) that need coordination
5. **Simplification Opportunities** — code that could be consolidated after merging
6. **Recommended Merge Order** — optimal sequence to minimize conflict resolution effort

Be concrete: reference file paths, line ranges, and function names. If no issues exist for a section, say "None detected."`;

      const { agent } = ctx.agentPool.getAgent("coalesce", {
        scope: "repo",
      });
      const res = await agent.execute(prompt, {
        timeoutMs: 1000 * 60 * 15,
      });

      const artifactsDir = path.join(ctx.workspaceDir, ".coder", "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(
        path.join(artifactsDir, "COALESCE.md"),
        res.stdout || res.output || String(res),
        "utf8",
      );

      ctx.log({
        event: "coalesce_analysis_complete",
        branches: completedBranches.length,
      });
    } catch (err) {
      ctx.log({
        event: "coalesce_analysis_error",
        error: err.message,
      });
    }
  }

  loopState.status = ctx.cancelToken.cancelled ? "cancelled" : "completed";
  loopState.completedAt = new Date().toISOString();
  await saveLoopState(ctx.workspaceDir, loopState, {
    guardRunId: loopState.runId,
  });

  runHooks(ctx, loopRunId, "loop_complete", "", {
    status: loopState.status,
    completed,
    failed,
    skipped,
    deferred: stillDeferred,
  });

  return {
    status: loopState.status,
    results,
    completed,
    failed,
    skipped,
    deferred: stillDeferred,
  };
}

/**
 * Reset workspace for next issue in autonomous loop.
 */
async function resetForNextIssue(
  workspaceDir,
  repoPath,
  { destructiveReset = false, issueStatus = "completed" } = {},
) {
  // Delete per-issue state
  const statePath = statePathFor(workspaceDir);
  if (existsSync(statePath)) rmSync(statePath, { force: true });

  // Delete workflow artifacts
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  for (const name of [
    "ISSUE.md",
    "PLAN.md",
    "PLANREVIEW.md",
    "REVIEW_FINDINGS.md",
  ]) {
    const p = path.join(artifactsDir, name);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // Git cleanup
  const repoRoot = resolveRepoRoot(workspaceDir, repoPath);
  if (existsSync(repoRoot)) {
    // For failed/skipped issues, preserve partial work on the issue branch
    // before switching back to the default branch.
    const needsPreserve = issueStatus === "failed" || issueStatus === "skipped";

    if (needsPreserve) {
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if ((status.stdout || "").trim()) {
        // Commit partial work to the current (issue) branch so it's not lost
        spawnSync("git", ["add", "-A"], { cwd: repoRoot, encoding: "utf8" });
        spawnSync(
          "git",
          ["commit", "-m", `wip: partial work (issue ${issueStatus})`],
          { cwd: repoRoot, encoding: "utf8" },
        );
      }
    }

    const defaultBranch = detectDefaultBranch(repoRoot);
    spawnSync("git", ["checkout", defaultBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (destructiveReset) {
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if ((status.stdout || "").trim()) {
        spawnSync("git", ["restore", "--staged", "--worktree", "."], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        spawnSync("git", ["clean", "-fd", "--exclude=.coder/"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
    }
  }
}
