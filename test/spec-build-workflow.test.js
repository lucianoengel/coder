import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineMachine } from "../src/machines/_base.js";
import { requirePayloadFields } from "../src/machines/research/_shared.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  registerSpecBuildMachines,
  runSpecBuildPipeline,
  specBuildMachines,
} from "../src/workflows/spec-build.workflow.js";

const mockIngestBuild = defineMachine({
  name: "research.spec_ingest",
  description: "Mock ingest (build)",
  inputSchema: z.object({ repoPath: z.string().default(".") }),
  async execute() {
    return {
      status: "ok",
      data: {
        runId: "test-run",
        runDir: "/tmp/run",
        stepsDir: "/tmp/run/steps",
        issuesDir: "/tmp/run/issues",
        scratchpadPath: "/tmp/run/SCRATCHPAD.md",
        pipelinePath: "/tmp/run/pipeline.json",
        repoRoot: "/tmp/repo",
        mode: "build",
        researchManifest: {
          issues: [{ id: "R-01", title: "Fix auth" }],
        },
      },
    };
  },
});

const mockIngestIngest = defineMachine({
  name: "research.spec_ingest",
  description: "Mock ingest (ingest)",
  inputSchema: z.object({ repoPath: z.string().default(".") }),
  async execute() {
    return {
      status: "ok",
      data: {
        runId: "test-run",
        runDir: "/tmp/run",
        stepsDir: "/tmp/run/steps",
        issuesDir: "/tmp/run/issues",
        scratchpadPath: "/tmp/run/SCRATCHPAD.md",
        pipelinePath: "/tmp/run/pipeline.json",
        repoRoot: "/tmp/repo",
        mode: "ingest",
        parsedDomains: [{ name: "auth", version: "1" }],
        parsedDecisions: [{ id: "ADR-001", status: "accepted" }],
        parsedGaps: [
          {
            description: "Needs work",
            domain: "AUTH",
            severity: "blocker",
            status: "open",
          },
        ],
      },
    };
  },
});

const mockArchitectBuild = defineMachine({
  name: "research.spec_architect",
  description: "Mock architect (build)",
  inputSchema: z.object({ mode: z.string(), runDir: z.string() }),
  async execute() {
    return {
      status: "ok",
      data: {
        mode: "build",
        domains: [{ name: "core", description: "Core domain" }],
        decisions: [
          {
            id: "ADR-001",
            title: "Use X",
            status: "accepted",
            rationale: "...",
          },
        ],
        phases: [{ id: "phase-1", title: "Foundation", issueSpecs: [] }],
        issueSpecs: [
          {
            title: "Implement auth",
            objective: "Add auth",
            priority: "P1",
          },
        ],
      },
    };
  },
});

const mockArchitectIngest = defineMachine({
  name: "research.spec_architect",
  description: "Mock architect (ingest)",
  inputSchema: z.object({ mode: z.string(), runDir: z.string() }),
  async execute() {
    return {
      status: "ok",
      data: {
        mode: "ingest",
        phases: [{ id: "phase-1", title: "Fix gaps" }],
        issueSpecs: [
          {
            title: "Fix auth gap",
            objective: "Address auth blocker",
            priority: "P1",
            domain: "AUTH",
          },
        ],
        parsedDomains: [{ name: "auth" }],
        parsedDecisions: [{ id: "ADR-001", status: "accepted" }],
      },
    };
  },
});

const mockRender = defineMachine({
  name: "research.spec_render",
  description: "Mock render",
  inputSchema: z.object({
    mode: z.string(),
    issueSpecs: z.array(z.any()),
  }),
  async execute(input) {
    return {
      status: "ok",
      data: {
        mode: input.mode,
        issueCount: input.issueSpecs.length,
        wroteSpecDocs: input.mode === "build",
      },
    };
  },
});

function makeCtx() {
  return {
    workspaceDir: "/tmp/test",
    repoPath: ".",
    config: {},
    agentPool: null,
    log: () => {},
    cancelToken: { cancelled: false, paused: false },
    secrets: {},
    artifactsDir: "/tmp/test/.coder/artifacts",
    scratchpadDir: "/tmp/test/.coder/scratchpad",
  };
}

test("spec-build pipeline cascades data in build mode", async () => {
  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestBuild, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: mockArchitectBuild,
      inputMapper: (prev) => ({
        mode: prev.data.mode,
        runDir: prev.data.runDir,
      }),
    },
    {
      machine: mockRender,
      inputMapper: (prev, state) => ({
        mode: state.results[0]?.data?.mode,
        issueSpecs: prev.data.issueSpecs || [],
      }),
    },
  ]);

  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].data.mode, "build");
  assert.equal(result.results[1].data.issueSpecs.length, 1);
  assert.equal(result.results[2].data.wroteSpecDocs, true);
  assert.equal(result.results[2].data.issueCount, 1);
});

test("spec-build pipeline cascades data in ingest mode", async () => {
  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestIngest, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: mockArchitectIngest,
      inputMapper: (prev) => ({
        mode: prev.data.mode,
        runDir: prev.data.runDir,
      }),
    },
    {
      machine: mockRender,
      inputMapper: (prev, state) => ({
        mode: state.results[0]?.data?.mode,
        issueSpecs: prev.data.issueSpecs || [],
      }),
    },
  ]);

  assert.equal(result.status, "completed");
  assert.equal(result.results[0].data.mode, "ingest");
  assert.equal(result.results[0].data.parsedGaps.length, 1);
  assert.equal(result.results[2].data.wroteSpecDocs, false);
  assert.equal(result.results[2].data.issueCount, 1);
});

test("spec-build pipeline fails on non-optional step error", async () => {
  const failArchitect = defineMachine({
    name: "research.spec_architect",
    description: "Failing architect",
    inputSchema: z.object({ mode: z.string() }),
    async execute() {
      throw new Error("architect failed");
    },
  });

  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestBuild, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: failArchitect,
      inputMapper: (prev) => ({ mode: prev.data.mode }),
    },
    {
      machine: mockRender,
      inputMapper: () => ({ mode: "build", issueSpecs: [] }),
    },
  ]);

  assert.equal(result.status, "failed");
  assert.match(result.error, /architect failed/);
});

// --- requirePayloadFields ---

test("requirePayloadFields throws on missing fields", () => {
  assert.throws(
    () => requirePayloadFields({ a: 1 }, ["a", "b"], "test"),
    /test missing required fields: b/,
  );
});

test("requirePayloadFields passes when all fields present", () => {
  assert.doesNotThrow(() => requirePayloadFields({ a: 1, b: 2 }, ["a", "b"]));
});

// --- spec-build workflow exports ---

test("specBuildMachines is an array of 3 machines", () => {
  assert.equal(Array.isArray(specBuildMachines), true);
  assert.equal(specBuildMachines.length, 3);
});

test("registerSpecBuildMachines is a function", () => {
  assert.equal(typeof registerSpecBuildMachines, "function");
});

test("runSpecBuildPipeline is a function", () => {
  assert.equal(typeof runSpecBuildPipeline, "function");
});
