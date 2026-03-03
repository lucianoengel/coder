import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceForMcp } from "../src/mcp/workspace.js";

test("normal path within root returns resolved path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  const sub = path.join(root, "sub");
  mkdirSync(sub);
  try {
    const result = resolveWorkspaceForMcp(sub, root);
    assert.ok(result.startsWith(root));
  } finally {
    // cleanup handled by OS tmpdir
  }
});

test("root itself as workspace returns resolved path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  try {
    const result = resolveWorkspaceForMcp(root, root);
    assert.equal(result, root);
  } finally {
    // cleanup handled by OS tmpdir
  }
});

test("outside symlink pointing inside root succeeds", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  const allowed = path.join(root, "allowed");
  mkdirSync(allowed);
  const link = path.join(os.tmpdir(), `coder-outside-link-${process.pid}`);
  symlinkSync(allowed, link);
  try {
    const result = resolveWorkspaceForMcp(link, root);
    assert.ok(result.startsWith(root));
  } finally {
    import("node:fs").then(({ unlinkSync }) => {
      try {
        unlinkSync(link);
      } catch {
        /* ignore */
      }
    });
  }
});

test("outside symlink pointing inside root resolves to real path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  const sub = path.join(root, "sub");
  mkdirSync(sub);
  const link = path.join(os.tmpdir(), `coder-outside-link2-${process.pid}`);
  symlinkSync(sub, link);
  try {
    const result = resolveWorkspaceForMcp(link, root);
    assert.equal(result, sub);
  } finally {
    import("node:fs").then(({ unlinkSync }) => {
      try {
        unlinkSync(link);
      } catch {
        /* ignore */
      }
    });
  }
});

test("inside symlink pointing outside root throws", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "coder-outside-"));
  const link = path.join(root, "evil");
  symlinkSync(outside, link);
  try {
    assert.throws(
      () => resolveWorkspaceForMcp(link, root),
      /Workspace must be within server root/,
    );
  } finally {
    // cleanup handled by OS tmpdir
  }
});

test("plain path outside root throws", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "coder-other-"));
  try {
    assert.throws(
      () => resolveWorkspaceForMcp(other, root),
      /Workspace must be within server root/,
    );
  } finally {
    // cleanup handled by OS tmpdir
  }
});

test("CODER_ALLOW_ANY_WORKSPACE=1 bypasses check", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coder-ws-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "coder-other-"));
  process.env.CODER_ALLOW_ANY_WORKSPACE = "1";
  try {
    const result = resolveWorkspaceForMcp(other, root);
    assert.ok(result.startsWith(os.tmpdir()));
  } finally {
    delete process.env.CODER_ALLOW_ANY_WORKSPACE;
  }
});
