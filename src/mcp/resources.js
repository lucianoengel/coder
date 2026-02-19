import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loopStatePathFor, statePathFor } from "../state/workflow-state.js";

async function findLatestScratchpadFile(scratchpadDir) {
  if (!(await access(scratchpadDir).then(() => true, () => false))) return null;

  /** @type {{ path: string, mtimeMs: number } | null} */
  let latest = null;
  const stack = [scratchpadDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(abs)).mtimeMs;
      } catch {
        continue;
      }
      if (!latest || mtimeMs > latest.mtimeMs) latest = { path: abs, mtimeMs };
    }
  }

  return latest?.path || null;
}

export function registerResources(server, defaultWorkspace) {
  server.resource(
    "state",
    "coder://state",
    {
      description:
        "Current .coder/state.json — workflow state including steps completed, selected issue, and branch",
    },
    async () => {
      const statePath = statePathFor(defaultWorkspace);
      if (!(await access(statePath).then(() => true, () => false))) {
        return {
          contents: [
            { uri: "coder://state", mimeType: "application/json", text: "{}" },
          ],
        };
      }
      return {
        contents: [
          {
            uri: "coder://state",
            mimeType: "application/json",
            text: await readFile(statePath, "utf8"),
          },
        ],
      };
    },
  );

  server.resource(
    "issue",
    "coder://issue",
    { description: "ISSUE.md contents — the drafted issue specification" },
    async () => {
      const issuePath = path.join(
        defaultWorkspace,
        ".coder",
        "artifacts",
        "ISSUE.md",
      );
      if (!(await access(issuePath).then(() => true, () => false))) {
        return {
          contents: [
            {
              uri: "coder://issue",
              mimeType: "text/markdown",
              text: "ISSUE.md does not exist yet.",
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: "coder://issue",
            mimeType: "text/markdown",
            text: await readFile(issuePath, "utf8"),
          },
        ],
      };
    },
  );

  server.resource(
    "plan",
    "coder://plan",
    { description: "PLAN.md contents — the implementation plan" },
    async () => {
      const planPath = path.join(
        defaultWorkspace,
        ".coder",
        "artifacts",
        "PLAN.md",
      );
      if (!(await access(planPath).then(() => true, () => false))) {
        return {
          contents: [
            {
              uri: "coder://plan",
              mimeType: "text/markdown",
              text: "PLAN.md does not exist yet.",
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: "coder://plan",
            mimeType: "text/markdown",
            text: await readFile(planPath, "utf8"),
          },
        ],
      };
    },
  );

  server.resource(
    "critique",
    "coder://critique",
    { description: "PLANREVIEW.md contents — the plan review critique" },
    async () => {
      const critiquePath = path.join(
        defaultWorkspace,
        ".coder",
        "artifacts",
        "PLANREVIEW.md",
      );
      if (!(await access(critiquePath).then(() => true, () => false))) {
        return {
          contents: [
            {
              uri: "coder://critique",
              mimeType: "text/markdown",
              text: "PLANREVIEW.md does not exist yet.",
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: "coder://critique",
            mimeType: "text/markdown",
            text: await readFile(critiquePath, "utf8"),
          },
        ],
      };
    },
  );

  server.resource(
    "loop-state",
    "coder://loop-state",
    {
      description:
        "Current .coder/loop-state.json — develop workflow progress including issue queue and per-issue results",
    },
    async () => {
      const loopPath = loopStatePathFor(defaultWorkspace);
      if (!(await access(loopPath).then(() => true, () => false))) {
        return {
          contents: [
            {
              uri: "coder://loop-state",
              mimeType: "application/json",
              text: "{}",
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: "coder://loop-state",
            mimeType: "application/json",
            text: await readFile(loopPath, "utf8"),
          },
        ],
      };
    },
  );

  server.resource(
    "scratchpad",
    "coder://scratchpad",
    {
      description:
        "Current scratchpad notes from .coder/scratchpad (latest run or selected issue)",
    },
    async () => {
      const statePath = statePathFor(defaultWorkspace);
      const scratchpadDir = path.join(defaultWorkspace, ".coder", "scratchpad");
      let scratchpadPath = null;

      if (await access(statePath).then(() => true, () => false)) {
        try {
          const state = JSON.parse(await readFile(statePath, "utf8"));
          if (
            typeof state?.scratchpadPath === "string" &&
            state.scratchpadPath
          ) {
            const candidate = path.resolve(
              defaultWorkspace,
              state.scratchpadPath,
            );
            if (await access(candidate).then(() => true, () => false)) scratchpadPath = candidate;
          }
        } catch {
          // best-effort
        }
      }

      if (!scratchpadPath) {
        scratchpadPath = await findLatestScratchpadFile(scratchpadDir);
      }

      if (!scratchpadPath) {
        return {
          contents: [
            {
              uri: "coder://scratchpad",
              mimeType: "text/markdown",
              text: "No scratchpad file exists yet under .coder/scratchpad.",
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: "coder://scratchpad",
            mimeType: "text/markdown",
            text: await readFile(scratchpadPath, "utf8"),
          },
        ],
      };
    },
  );
}
