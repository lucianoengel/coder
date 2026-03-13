import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadLoopState,
  loadState,
  saveLoopState,
  saveState,
} from "../src/state/workflow-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  ensureCleanLoopStart,
  resetForNextIssue,
  runDevelopLoop,
  runWithMachineRetry,
} from "../src/workflows/develop.workflow.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "destructive-reset-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "logs"), { recursive: true });
  execSync("git init", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: tmp, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function writeLocalManifest(workspaceDir, issues) {
  const dir = path.join(workspaceDir, ".coder", "local-issues");
  const issuesSubdir = path.join(dir, "issues");
  mkdirSync(issuesSubdir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      issues: issues.map((issue) => ({
        id: issue.id,
        file: `issues/${issue.id}.md`,
        title: issue.title,
        difficulty: issue.difficulty || 3,
        dependsOn: issue.dependsOn || [],
      })),
    }),
  );
  for (const issue of issues) {
    writeFileSync(
      path.join(issuesSubdir, `${issue.id}.md`),
      `# ${issue.id} — ${issue.title}\n\nDetails.`,
    );
  }
  return dir;
}

function makeCtx(workspaceDir, overrides = {}) {
  const logEvents = [];
  return {
    workspaceDir,
    repoPath: ".",
    artifactsDir: path.join(workspaceDir, ".coder", "artifacts"),
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
    cancelToken: { cancelled: false, paused: false },
    log: (event) => logEvents.push(event),
    config: {
      workflow: {
        maxMachineRetries: 0,
        retryBackoffMs: 0,
        hooks: [],
        issueSource: "local",
        localIssuesDir: "",
      },
    },
    agentPool: null,
    secrets: {},
    logEvents,
    ...overrides,
  };
}

function completedRunnerResult(runId = "run-test") {
  return {
    status: "completed",
    results: [
      {
        machine: "develop.pr_creation",
        status: "ok",
        data: { branch: "feat/test", prUrl: "https://example.test/pr" },
      },
    ],
    runId,
    durationMs: 0,
  };
}

test("destructiveReset retries failed/skipped issues but preserves completed", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
      { id: "C", title: "Issue C", difficulty: 3 },
    ]);

    // Seed prior loop state: A=completed, B=failed, C=skipped
    await saveLoopState(ws, {
      runId: "prior-run",
      goal: "prior",
      status: "completed",
      projectFilter: null,
      maxIssues: null,
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "completed",
          branch: "feat/A",
          prUrl: "https://example.test/pr/A",
          error: null,
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: "2025-01-01T00:01:00.000Z",
          dependsOn: [],
        },
        {
          source: "local",
          id: "B",
          title: "Issue B",
          status: "failed",
          branch: null,
          prUrl: null,
          error: "quality review failed",
          startedAt: "2025-01-01T00:02:00.000Z",
          completedAt: null,
          dependsOn: [],
        },
        {
          source: "local",
          id: "C",
          title: "Issue C",
          status: "skipped",
          branch: null,
          prUrl: null,
          error: "Skipped: prior issue failed",
          startedAt: null,
          completedAt: "2025-01-01T00:03:00.000Z",
          dependsOn: [],
        },
      ],
      currentIndex: 0,
      currentStage: null,
      currentStageStartedAt: null,
      lastHeartbeatAt: null,
      runnerPid: null,
      activeAgent: null,
      startedAt: "2025-01-01T00:00:00.000Z",
      completedAt: "2025-01-01T00:04:00.000Z",
    });

    const processedIds = [];

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (machineName === "develop.issue_draft") {
        const issueId = steps[0]?.inputMapper?.()?.issue?.id;
        processedIds.push(issueId);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-reset",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-reset");
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: true,
      },
      ctx,
    );

    // A was completed in prior run → should NOT be re-processed
    assert.ok(
      !processedIds.includes("A"),
      "completed issue A should be skipped",
    );
    // B was failed → should be retried
    assert.ok(processedIds.includes("B"), "failed issue B should be retried");
    // C was skipped → should be retried
    assert.ok(processedIds.includes("C"), "skipped issue C should be retried");

    // Final tallies: A preserved + B,C now completed
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((q) => q.id === "A");
    const issueB = finalState.issueQueue.find((q) => q.id === "B");
    const issueC = finalState.issueQueue.find((q) => q.id === "C");
    assert.equal(issueA.status, "completed");
    assert.equal(issueB.status, "completed");
    assert.equal(issueC.status, "completed");
    // B and C should have cleared their prior errors
    assert.equal(issueB.error, null);
    assert.equal(issueC.error, null);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("without destructiveReset, failed/skipped issues are preserved from prior run", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
    ]);

    // Seed prior loop state: A=completed, B=failed
    await saveLoopState(ws, {
      runId: "prior-run",
      goal: "prior",
      status: "completed",
      projectFilter: null,
      maxIssues: null,
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "completed",
          branch: "feat/A",
          prUrl: "https://example.test/pr/A",
          error: null,
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: "2025-01-01T00:01:00.000Z",
          dependsOn: [],
        },
        {
          source: "local",
          id: "B",
          title: "Issue B",
          status: "failed",
          branch: null,
          prUrl: null,
          error: "quality review failed",
          startedAt: "2025-01-01T00:02:00.000Z",
          completedAt: null,
          dependsOn: [],
        },
      ],
      currentIndex: 0,
      currentStage: null,
      currentStageStartedAt: null,
      lastHeartbeatAt: null,
      runnerPid: null,
      activeAgent: null,
      startedAt: "2025-01-01T00:00:00.000Z",
      completedAt: "2025-01-01T00:04:00.000Z",
    });

    const processedIds = [];

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (machineName === "develop.issue_draft") {
        processedIds.push(steps[0]?.inputMapper?.()?.issue?.id);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-no-reset",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-no-reset");
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    // Neither A (completed) nor B (failed) should be re-processed
    assert.equal(processedIds.length, 0);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);

    const finalState = await loadLoopState(ws);
    const issueB = finalState.issueQueue.find((q) => q.id === "B");
    assert.equal(issueB.status, "failed");
    assert.equal(issueB.error, "quality review failed");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- resetForNextIssue tests ---

test("resetForNextIssue throws when git checkout fails", async () => {
  const ws = makeTmpWorkspace();
  try {
    // Create and switch to a branch, then delete the default branch so checkout fails
    spawnSync("git", ["checkout", "-b", "feat/test"], {
      cwd: ws,
      stdio: "ignore",
    });
    spawnSync("git", ["branch", "-D", "main"], { cwd: ws, stdio: "ignore" });
    spawnSync("git", ["branch", "-D", "master"], { cwd: ws, stdio: "ignore" });

    await assert.rejects(
      () => resetForNextIssue(ws, ".", { destructiveReset: false }),
      (err) => {
        assert.match(err.message, /git checkout.*failed/i);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("resetForNextIssue skips git restore on empty-commit repo", async () => {
  const ws = makeTmpWorkspace();
  try {
    // ws was init'd with --allow-empty, so there are no tracked files.
    // Create an untracked file so status is dirty.
    writeFileSync(path.join(ws, "untracked.txt"), "hello");

    // Should not throw — git restore is skipped, only git clean runs
    await resetForNextIssue(ws, ".", { destructiveReset: true });
    assert.ok(
      !existsSync(path.join(ws, "untracked.txt")),
      "untracked file should be cleaned",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- ensureCleanLoopStart tests ---

function makeLogCtx(workspaceDir) {
  const logEvents = [];
  return {
    workspaceDir,
    log: (event) => logEvents.push(event),
    logEvents,
  };
}

test("ensureCleanLoopStart: WIP-preserves known branch, switches to default", async () => {
  const ws = makeTmpWorkspace();
  try {
    // Seed loop state with a known branch
    await saveLoopState(ws, {
      runId: "run-1",
      issueQueue: [
        {
          id: "A",
          title: "A",
          source: "local",
          status: "in_progress",
          branch: "feat/known",
          dependsOn: [],
        },
      ],
    });

    // Create the known branch and make it dirty
    spawnSync("git", ["checkout", "-b", "feat/known"], {
      cwd: ws,
      stdio: "ignore",
    });
    writeFileSync(path.join(ws, "dirty.txt"), "wip");
    spawnSync("git", ["add", "dirty.txt"], { cwd: ws, stdio: "ignore" });

    const ctx = makeLogCtx(ws);
    await ensureCleanLoopStart(ws, ctx);

    // Should have committed and switched to master/main
    const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: ws,
      encoding: "utf8",
    });
    assert.ok(["main", "master"].includes(head.stdout.trim()));
    assert.ok(
      ctx.logEvents.some((e) => e.event === "clean_loop_start_wip_commit"),
    );
    assert.ok(
      ctx.logEvents.some((e) => e.event === "clean_loop_start_checkout"),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: discards dirty unknown branch", async () => {
  const ws = makeTmpWorkspace();
  try {
    // No loop state (unknown branch)
    spawnSync("git", ["checkout", "-b", "feat/unknown"], {
      cwd: ws,
      stdio: "ignore",
    });
    writeFileSync(path.join(ws, "junk.txt"), "junk");

    const ctx = makeLogCtx(ws);
    await ensureCleanLoopStart(ws, ctx);

    const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: ws,
      encoding: "utf8",
    });
    assert.ok(["main", "master"].includes(head.stdout.trim()));
    assert.ok(
      ctx.logEvents.some((e) => e.event === "clean_loop_start_discard"),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: resets stale in_progress to pending", async () => {
  const ws = makeTmpWorkspace();
  try {
    await saveLoopState(ws, {
      runId: "run-1",
      issueQueue: [
        {
          id: "A",
          title: "A",
          source: "local",
          status: "in_progress",
          dependsOn: [],
        },
        {
          id: "B",
          title: "B",
          source: "local",
          status: "completed",
          dependsOn: [],
        },
        {
          id: "C",
          title: "C",
          source: "local",
          status: "in_progress",
          dependsOn: [],
        },
      ],
    });

    const ctx = makeLogCtx(ws);
    await ensureCleanLoopStart(ws, ctx);

    const ls = await loadLoopState(ws);
    assert.equal(ls.issueQueue[0].status, "pending");
    assert.equal(ls.issueQueue[1].status, "completed");
    assert.equal(ls.issueQueue[2].status, "pending");
    assert.ok(
      ctx.logEvents.some(
        (e) => e.event === "clean_loop_start_reset_stale" && e.count === 2,
      ),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: no-op when clean", async () => {
  const ws = makeTmpWorkspace();
  try {
    const ctx = makeLogCtx(ws);
    await ensureCleanLoopStart(ws, ctx);

    // No recovery events should have been logged
    assert.equal(ctx.logEvents.length, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- Retry implemented flag test ---

test("quality-review retry clears state.steps.implemented", async () => {
  const ws = makeTmpWorkspace();
  try {
    // Seed state with implemented=true
    await saveState(ws, { steps: { implemented: true } });

    const logEvents = [];
    const ctx = {
      workspaceDir: ws,
      artifactsDir: path.join(ws, ".coder", "artifacts"),
      log: (e) => logEvents.push(e),
      cancelToken: { cancelled: false },
    };

    let attempt = 0;
    const result = await runWithMachineRetry(
      () => {
        attempt++;
        if (attempt === 1) {
          return {
            status: "failed",
            error: "quality issues",
            results: [
              {
                machine: "develop.quality_review",
                status: "error",
                error: "quality issues",
              },
            ],
          };
        }
        return { status: "completed", results: [] };
      },
      {
        maxRetries: 1,
        backoffMs: 0,
        ctx,
        onFailedAttempt: async () => {
          // Simulate the real callback: clear implemented flag
          const retryState = await loadState(ctx.workspaceDir);
          if (retryState?.steps) {
            retryState.steps.implemented = false;
            await saveState(ctx.workspaceDir, retryState);
          }
        },
      },
    );

    assert.equal(result.status, "completed");
    const finalState = await loadState(ws);
    assert.equal(finalState.steps.implemented, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
