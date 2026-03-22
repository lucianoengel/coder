import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertTestCommandPathsExist,
  collectRelativePathsFromShellCommand,
  stripOuterShellQuotes,
  TestCommandPathError,
} from "../src/test-command-paths.js";

test("collectRelativePathsFromShellCommand finds bash script path", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand("bash scripts/test.sh"),
    ["scripts/test.sh"],
  );
});

test("collectRelativePathsFromShellCommand normalizes ./ prefix", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand("bash ./scripts/test.sh"),
    ["scripts/test.sh"],
  );
});

test("collectRelativePathsFromShellCommand finds standalone ./path", () => {
  assert.deepEqual(collectRelativePathsFromShellCommand("cd x && ./run.sh"), [
    "run.sh",
  ]);
});

test("collectRelativePathsFromShellCommand ignores bare bash word", () => {
  assert.deepEqual(collectRelativePathsFromShellCommand("bash echo hi"), []);
});

test("collectRelativePathsFromShellCommand finds node relative script", () => {
  assert.deepEqual(collectRelativePathsFromShellCommand("node tools/run.cjs"), [
    "tools/run.cjs",
  ]);
});

test("collectRelativePathsFromShellCommand handles double-quoted bash operand", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand('bash "scripts/test.sh"'),
    ["scripts/test.sh"],
  );
});

test("collectRelativePathsFromShellCommand handles double-quoted node operand", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand('node "tools/run.cjs"'),
    ["tools/run.cjs"],
  );
});

test("stripOuterShellQuotes removes one pair of quotes", () => {
  assert.equal(stripOuterShellQuotes('"scripts/a.sh"'), "scripts/a.sh");
  assert.equal(stripOuterShellQuotes("'x.sh'"), "x.sh");
  assert.equal(stripOuterShellQuotes("nope"), "nope");
});

test("collectRelativePathsFromShellCommand collects multiple bash scripts", () => {
  const paths = collectRelativePathsFromShellCommand(
    "bash scripts/a.sh && bash scripts/b.sh",
  );
  assert.equal(paths.includes("scripts/a.sh"), true);
  assert.equal(paths.includes("scripts/b.sh"), true);
});

test("assertTestCommandPathsExist throws when script missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-miss-"));
  assert.throws(
    () =>
      assertTestCommandPathsExist(dir, ["bash scripts/nope.sh"], {
        repoPath: "api",
      }),
    (err) => {
      assert.equal(err instanceof TestCommandPathError, true);
      assert.match(err.message, /does not exist under the effective directory/);
      assert.match(err.message, /repo_path: api/);
      return true;
    },
  );
});

test("assertTestCommandPathsExist passes when script exists", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-ok-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(dir, ["bash scripts/t.sh"], {}),
  );
  assert.equal(existsSync(path.join(dir, "scripts", "t.sh")), true);
});

test("assertTestCommandPathsExist passes for quoted bash path when file exists", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-quote-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(dir, ['bash "scripts/t.sh"'], {}),
  );
});

test("assertTestCommandPathsExist respects cd .. before bash script", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "tcp-cdup-"));
  const sub = path.join(parent, "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(parent, "scripts"), { recursive: true });
  writeFileSync(path.join(parent, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(sub, ["cd .. && bash scripts/t.sh"], {}),
  );
});

test("assertTestCommandPathsExist respects quoted cd target", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "tcp-cdqt-"));
  const sub = path.join(parent, "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(parent, "scripts"), { recursive: true });
  writeFileSync(path.join(parent, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(sub, ['cd ".." && bash scripts/t.sh'], {}),
  );
});
