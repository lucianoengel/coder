import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Per-machine state checkpoint — saved after each machine completes within a workflow.
 */

const MachineCheckpointSchema = z.object({
  machine: z.string(),
  status: z.enum(["ok", "error", "skipped"]),
  data: z.any().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  completedAt: z.string(),
});

const WorkflowCheckpointSchema = z.object({
  runId: z.string(),
  workflow: z.string(),
  steps: z.array(MachineCheckpointSchema).default([]),
  currentStep: z.number().int().default(0),
  updatedAt: z.string(),
});

export function checkpointPathFor(workspaceDir, runId) {
  return path.join(workspaceDir, ".coder", `checkpoint-${runId}.json`);
}

export async function saveCheckpoint(workspaceDir, checkpoint) {
  const p = checkpointPathFor(workspaceDir, checkpoint.runId);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(checkpoint, null, 2) + "\n");
}

export async function loadCheckpoint(workspaceDir, runId) {
  const p = checkpointPathFor(workspaceDir, runId);
  if (
    !(await access(p)
      .then(() => true)
      .catch(() => false))
  )
    return null;
  try {
    return WorkflowCheckpointSchema.parse(
      JSON.parse(await readFile(p, "utf8")),
    );
  } catch {
    return null;
  }
}

export async function appendStepCheckpoint(
  workspaceDir,
  runId,
  workflow,
  step,
) {
  const existing = (await loadCheckpoint(workspaceDir, runId)) || {
    runId,
    workflow,
    steps: [],
    currentStep: 0,
    updatedAt: new Date().toISOString(),
  };
  existing.steps.push({
    ...step,
    completedAt: new Date().toISOString(),
  });
  existing.currentStep = existing.steps.length;
  existing.updatedAt = new Date().toISOString();
  await saveCheckpoint(workspaceDir, existing);
  return existing;
}
