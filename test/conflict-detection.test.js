import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  runDevelopPipeline,
  runPlanLoop,
} from "../src/workflows/develop.workflow.js";

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "conflict-detect-test-"));
  mkdirSync(path.join(dir, ".coder", "artifacts"), { recursive: true });
  return dir;
}

function makeCtx(overrides = {}) {
  const logEvents = [];
  const workspaceDir = overrides.workspaceDir || "/tmp/test";
  return {
    workspaceDir,
    artifactsDir:
      overrides.artifactsDir || path.join(workspaceDir, ".coder", "artifacts"),
    cancelToken: { cancelled: false, paused: false },
    log: (e) => logEvents.push(e),
    config: {
      workflow: {
        maxMachineRetries: 0,
        retryBackoffMs: 0,
      },
    },
    agentPool: null,
    secrets: {},
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
    logEvents,
    ...overrides,
  };
}

function makeRunner(ctx) {
  return new WorkflowRunner({ name: "test", workflowContext: ctx });
}

// ---------------------------------------------------------------------------
// runPlanLoop passes activeBranches to the planning machine
// ---------------------------------------------------------------------------

test("runPlanLoop: passes activeBranches to the planning machine input", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx({ workspaceDir: tmp, artifactsDir: path.join(tmp, ".coder", "artifacts") });
    const runner = makeRunner(ctx);
    let capturedInput = null;

    const mockPlan = {
      name: "develop.planning",
      async run(input) {
        capturedInput = input;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "ok", verdict: "APPROVED" },
          durationMs: 0,
        };
      },
    };

    const activeBranches = [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Add auth",
        diffStat: " src/auth.js | 50 ++++\n 1 file changed",
      },
    ];

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
      activeBranches,
    });

    assert.equal(result.status, "completed");
    assert.ok(capturedInput, "planning machine should have received input");
    assert.deepEqual(capturedInput.activeBranches, activeBranches);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: defaults activeBranches to empty array when not provided", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx({ workspaceDir: tmp, artifactsDir: path.join(tmp, ".coder", "artifacts") });
    const runner = makeRunner(ctx);
    let capturedInput = null;

    const mockPlan = {
      name: "develop.planning",
      async run(input) {
        capturedInput = input;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "ok", verdict: "APPROVED" },
          durationMs: 0,
        };
      },
    };

    await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.ok(capturedInput);
    assert.deepEqual(capturedInput.activeBranches, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runDevelopPipeline returns deferred when CONFLICT_DETECTED is in PLAN.md
// ---------------------------------------------------------------------------

test("runDevelopPipeline: returns deferred when PLAN.md contains CONFLICT_DETECTED", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-2", title: "Conflict test" },
    repoPath: "/tmp/repo",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Auth feature",
        diffStat: " src/auth.js | 50 ++++\n",
      },
    ],
  };

  const originalRun = WorkflowRunner.prototype.run;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.planning") {
      // Simulate planner writing PLAN.md with CONFLICT_DETECTED
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\nModify src/auth.js to add OAuth.\n\n## CONFLICT_DETECTED\n- branch: coder/issue-1\n- reason: Both modify src/auth.js authentication logic\n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.plan_review") {
      return {
        status: "completed",
        results: [
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    // Phase 3 should NOT be reached
    throw new Error(
      `Unexpected: Phase 3 reached despite CONFLICT_DETECTED (machine: ${machineName})`,
    );
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "conflict");
    assert.equal(result.conflictBranch, "coder/issue-1");
    assert.match(result.error, /src\/auth\.js/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: proceeds to Phase 3 when PLAN.md has no CONFLICT_DETECTED", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-3", title: "No conflict test" },
    repoPath: "/tmp/repo",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Auth feature",
        diffStat: " src/auth.js | 50 ++++\n",
      },
    ],
  };

  const originalRun = WorkflowRunner.prototype.run;
  let phase3Reached = false;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.planning") {
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\nModify src/users.js to add user profiles.\n\n## Files to Modify\n- src/users.js\n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.plan_review") {
      return {
        status: "completed",
        results: [
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.implementation") {
      phase3Reached = true;
      return {
        status: "completed",
        results: [
          { status: "ok", data: {} },
          { status: "ok", data: {} },
          {
            status: "ok",
            data: { prUrl: "https://example.test/pr/3", branch: "feat/3" },
          },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "completed");
    assert.ok(phase3Reached, "Phase 3 should have been reached");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: proceeds normally when no activeBranches provided", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-4", title: "No branches test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;
  let phase3Reached = false;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.planning") {
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\nSimple plan.\n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.plan_review") {
      return {
        status: "completed",
        results: [
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.implementation") {
      phase3Reached = true;
      return {
        status: "completed",
        results: [
          { status: "ok", data: {} },
          { status: "ok", data: {} },
          {
            status: "ok",
            data: { prUrl: "https://example.test/pr/4", branch: "feat/4" },
          },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "completed");
    assert.ok(phase3Reached, "Phase 3 should have been reached");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CONFLICT_DETECTED regex edge cases
// ---------------------------------------------------------------------------

test("runDevelopPipeline: CONFLICT_DETECTED with extra whitespace in branch/reason", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-5", title: "Whitespace test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.planning") {
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\n## CONFLICT_DETECTED\n- branch:   feat/auth-flow  \n- reason:   Overlapping auth logic  \n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.plan_review") {
      return {
        status: "completed",
        results: [
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error("Phase 3 should not be reached");
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.conflictBranch, "feat/auth-flow");
    assert.match(result.error, /Overlapping auth logic/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Planning machine input schema accepts activeBranches
// ---------------------------------------------------------------------------

test("planning machine: inputSchema accepts activeBranches", async () => {
  const planningMachine = (
    await import("../src/machines/develop/planning.machine.js")
  ).default;

  const validInput = {
    priorCritique: "",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Test",
        diffStat: "1 file changed",
      },
    ],
  };

  const parsed = planningMachine.inputSchema.parse(validInput);
  assert.equal(parsed.activeBranches.length, 1);
  assert.equal(parsed.activeBranches[0].branch, "coder/issue-1");
});

test("planning machine: inputSchema defaults activeBranches to empty array", async () => {
  const planningMachine = (
    await import("../src/machines/develop/planning.machine.js")
  ).default;

  const parsed = planningMachine.inputSchema.parse({});
  assert.deepEqual(parsed.activeBranches, []);
});
