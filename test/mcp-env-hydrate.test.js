import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { earlyWorkspaceDirForMcp } from "../src/mcp-env-hydrate.js";

test("earlyWorkspaceDirForMcp uses --workspace when present", () => {
  const prev = process.argv;
  try {
    process.argv = ["node", "coder-mcp", "--workspace", "/tmp/foo/bar"];
    assert.equal(earlyWorkspaceDirForMcp(), path.resolve("/tmp/foo/bar"));
  } finally {
    process.argv = prev;
  }
});

test("earlyWorkspaceDirForMcp accepts --workspace=/path (equals form)", () => {
  const prev = process.argv;
  try {
    process.argv = ["node", "coder-mcp", "--workspace=/tmp/x"];
    assert.equal(earlyWorkspaceDirForMcp(), path.resolve("/tmp/x"));
  } finally {
    process.argv = prev;
  }
});

test("earlyWorkspaceDirForMcp falls back to cwd without --workspace", () => {
  const prev = process.argv;
  try {
    process.argv = ["node", "coder-mcp"];
    assert.equal(earlyWorkspaceDirForMcp(), process.cwd());
  } finally {
    process.argv = prev;
  }
});
