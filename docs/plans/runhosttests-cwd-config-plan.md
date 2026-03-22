# Plan: Fix `scripts/test.sh: No such file` in develop quality review

## What went wrong

Two separate things showed up in the reported session:

1. **Issue #39 — `bash: scripts/test.sh: No such file or directory`**  
   Quality review calls `runHostTests(repoRoot, …)` with  
   `repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath)`  
   (`src/machines/develop/quality-review.machine.js`).  
   `runHostTests` runs shell commands with `runShellSync(…, { cwd: repoDir })`  
   (`src/helpers.js`, `src/test-runner.js`).

   So that error means: **from the directory bash used as `cwd`, `scripts/test.sh` was not found** — that can be a **wrong `cwd`**, a **missing file on disk under that `cwd`**, or on Linux a **bad shebang / missing interpreter** (bash often reports `No such file or directory` for the script path in that case too).

### Reference incident — `rotmeter` (ground truth)

For the repository that triggered the original report:

- **Git / project root:** `/home/coder/workspace/rotmeter`
- **Script on disk:** `/home/coder/workspace/rotmeter/scripts/test.sh` **exists** at that layout.

So this was **not** a case of “the repo never had `scripts/test.sh` at the root.” The interesting hypotheses are:

1. **Effective `cwd` at test time was not** `/home/coder/workspace/rotmeter` (e.g. MCP `workspace` / `workspaceDir` mismatch, server defaulting to `process.cwd()` somewhere, or systemd / runner not honoring `--working-directory`).
2. **Shebang or runtime environment** inside the test invocation (e.g. transient unit env missing the interpreter `env` resolves).
3. **Much less likely here:** wrong `repo_path` in issue state **if** it ever pointed away from that root despite the file living at root — still worth logging `state.repoPath` → `repoRoot`.

The **subdir / user-merge `coder.json`** story in this plan remains important for **other** workspaces, but **rotmeter-specific debugging should start from “cwd vs known-good tree on disk,”** not from assuming the script was absent under `repoRoot`.

2. **Issue #34 — invalid ISSUE.md / Gemini**  
   Separate from the test path: the agent returned MCP noise instead of draft markdown. Treat as **agent/output validation**, not the same bug as #39.

## Two axes (do not conflate)

The workflow **deliberately** sets `repoRoot` from `state.repoPath` and passes it into `runHostTests`; every execution path uses **`cwd: repoDir`** (`quality-review.machine.js`, `runHostTests`, `runTestConfig`). That preserves **valid nested-repo / monorepo-subdir issues** whose tests and scripts are intentionally relative to `repoPath`.

| Axis | Question |
|------|----------|
| **Config source** | Which file or merge supplies setup / healthCheck / `test` command / teardown (or explicit `testCmd` from `ctx.config`)? |
| **Execution root** | Where the shell runs — today always **`repoRoot`** for all branches. |

**Do not** treat “default `cwd` to `workspaceDir`” as the primary fix: that would change semantics for subdir issues that expect commands relative to `repoPath`.

The bug class is **mismatch**: a **workspace- or user-merged** test definition paired with **`cwd` = `repoRoot`** when the command or paths assume the workspace root (or another root). The fix should **align config source with execution root** (or make the mismatch impossible / visible), not silently move execution to the workspace root by default.

## `runHostTests` branches (all use `cwd = repoDir` today)

Order in `src/helpers.js`:

1. **`testConfigPath`** — resolves file with `path.resolve(repoDir, testConfigPath)`, loads via `loadTestConfig(repoDir, testConfigPath)`, runs `runTestConfig(repoDir, …)`.
2. **`loadTestConfig(repoDir)`** — `coder.json` at `repoDir` merged with user config; if a test section exists, `runTestConfig(repoDir, …)`.
3. **`testCmd`** — `runShellSync(testCmd, { cwd: repoDir })`.
4. **Auto-detect** — `detectTestCommand` / `runTestCommand` under `repoDir`.
5. **`allowNoTests` fallback** — no-op success or throw.

Any design must state how **(1)** and **(2)** interact with workspace-level vs repo-level config, not only `test.command`. Fixing precedence for `ctx.config.test.command` alone can leave the same workspace-vs-subdir gap for **explicit `testConfigPath`**.

## Likely root causes for #39 (priority order)

### A. Config source vs. `repoRoot` mismatch

`loadTestConfig(repoDir)` uses `loadConfig(repoDir)`, which **deep-merges** `~/.config/coder/config.json` with **`repoDir/coder.json`**.  
If `repo_path` is a **subdir** and the merged result still carries a **root-style** `test.command` (from user config or from a parent `coder.json` concept), commands run with **`cwd` = subdir** → missing paths.

The **`testConfigPath`** branch resolves the config file under **`repoDir`**; a path meant to be workspace-relative can land wrong or load commands that assume a different root.

### B. `state.repoPath` / issue `repo_path` wrong

Same symptom if `repoRoot` is not where the test script actually lives.

### C. Systemd / environment edge case (less likely)

`runShellSync` uses `systemd-run` with `--working-directory=${cwd}` when `cwd` is set (`src/systemd-run.js`).

### D. Wrong MCP workspace

`coder-mcp` defaults `--workspace` to `process.cwd()` when omitted (`bin/coder-mcp.js`). Per-request `workspace` should win for workflow tools — confirm in logs.

---

## Plan to fix

### Phase 1 — Confirm root cause

1. **Log at test gate** (temporary or behind a debug flag):  
   `ctx.workspaceDir`, `state.repoPath`, resolved `repoRoot`, inputs `testCmd` / `testConfigPath`,  
   existence checks for any known relative script (e.g. `scripts/test.sh`) under **`repoRoot` and under `workspaceDir`** when they differ.  
   **If the file exists under `repoRoot` but the command still failed** (as with rotmeter), treat that as strong evidence the bug is **wrong `cwd` / workspace / systemd / environment**, not missing assets — prioritize logging the **actual** `cwd` passed into `runShellSync` and the **`workspaceDir` → `repoRoot` resolution chain**.

2. **Log which `runHostTests` branch ran** (single enum), e.g.  
   `test_config_path` | `repo_coder_json` | `explicit_test_cmd` | `auto_detect` | `allow_no_tests`.

3. **Inspect the failing issue** for `repo_path` vs location of `coder.json`, optional test config file, and `scripts/test.sh`.

4. **Inspect `~/.config/coder/config.json`** for a global `test` section merged into `loadConfig(repoDir)`.

### Phase 2 — Fix design (one coherent rule for all entry points)

#### Implementation contract (locked for v1)

**Adopt 2b — fail loud** as the **only** behavior we implement, test, and document in the first change set. **2a** (merge/precedence rules) and **2c** (opt-in alternate `cwd`) stay **out of scope** until this plan is explicitly revised.

**Execution root (v1):** always **`repoRoot`** for every `runHostTests` branch (`testConfigPath`, merged `coder.json`, `testCmd`, auto-detect). No new default `cwd`.

**Path / config contract (v1):**

- **`testConfigPath`:** keep resolving the file with `path.resolve(repoDir, testConfigPath)`; setup / test / teardown in that file run with **`cwd = repoDir`** (current behavior). Document that the path is **relative to `repoRoot`**.
- **`loadTestConfig(repoDir)` + `testCmd` + auto-detect:** same **`cwd = repoDir`**.
- **Before** executing any shell step, **validate** the same way for **all** of: **`setup[]`**, the **main test** command, **`teardown[]`** (everything `runTestConfig` runs), **and** standalone `testCmd` when used. Do **not** validate only the main test line — setup/teardown often invoke the same relative scripts; narrowing validation to “test only” is an implementation bug relative to this contract.
- Validation rules: e.g. detect obvious relative invocations (`bash scripts/foo.sh`, `./script`, etc.) and ensure those paths exist under `repoDir` **or** fail with a **structured coder error** that names `repoRoot`, `repo_path`, `testConfigPath`, and suggests fixes (`cd … &&`, move `coder.json` test config, correct `repo_path`). Exact heuristics are implementation details; the contract is **no silent bash “No such file” as the only signal** when we can detect the mismatch first.
- **rotmeter-shaped incidents:** If the script **does** exist under the real repo root on disk (e.g. `/home/coder/workspace/rotmeter/scripts/test.sh`) but the workflow still failed, a path-existence check against **`repoDir` may pass** while bash fails — meaning **`repoDir` at runtime may not have been that root**, or the failure is **shebang / env** (see Reference incident). **2b does not replace** Phase 1 logging of **`cwd` vs `workspaceDir` vs `repoRoot`** and systemd behavior; it complements “declared root vs relative paths,” not every possible ENOENT.

**Regression tests (v1) must lock:**

1. **`repo_path` = subdir**, tests and scripts live **under that subdir** — still **passes** (unchanged semantics).
2. **`repo_path` = subdir** (or wrong path) **and** resolved **main test** command points at files **missing under `repoDir`** — **fails** with the new structured error (not optional).
3. **`testConfigPath` branch** — same validation applies to commands loaded from that file.
4. **`setup` or `teardown`** contains a relative script path **missing under `repoDir`** — **fails** with the same structured error **before** that step runs (pins that 2b covers the full `runTestConfig` surface, not test-only).

**Docs (v1):** state that **`setup`**, **`test.command`**, **`teardown`**, and `testConfigPath` contents are interpreted with **`cwd = repoRoot`**; monorepos may need `repo_path` at the component root or `cd … &&` in those command strings.

---

**Deferred (not v1 — require plan update to adopt):**

| ID | Idea | Why deferred |
|----|------|----------------|
| **2a** | Precedence / user-merge rules so subdir issues do not inherit a root-only `test.command` from `~/.config/coder/config.json` | Smaller change set first; validate pain with 2b errors, then decide merge semantics. |
| **2c** | Opt-in `test.cwd` (or equivalent) for an alternate execution root | Only if product wants first-class multi-root without `cd` in command strings. |

Constraints (unchanged):

- **Preserve `repo_path` semantics**: default execution remains **`cwd = repoRoot`** unless a future **2c**-style opt-in is added and documented.
- **Separate** “which config wins” from “where commands run”; v1 does not change merge order except as needed to **surface** errors (2b). **2a** would change merge order — explicitly deferred.

### Phase 3 — Hardening

1. **Document** `test.setup`, `test.command`, `test.teardown`, `testConfigPath`, and merge behavior: paths are relative to **`repoRoot`** unless the doc states otherwise; monorepos may need `repo_path` at the root or `cd … &&` in those commands.

2. **Optional:** assert `path.isAbsolute(cwd)` before test `runShellSync` when using systemd.

3. **Issue #34 (Gemini / ISSUE.md):** separate task.

### Phase 4 — Verify

1. Re-run develop workflow where scripts exist under **`repoRoot`** for the configured command.

2. Tests cover **`repo_path` = subdir**, **`testConfigPath`**, main-test **and** setup/teardown **2b** validation (regression item 4), per the locked contract above.

---

## Bottom line

There is a real **workspace / user-merge / `repo_path` mismatch risk**: config can describe paths for one root while **`runHostTests` always executes under `repoRoot`** across **all** branches. The plan keeps **config source vs. execution root** separate, **does not** default `cwd` to `workspaceDir`, and requires **branch logging** in Phase 1.

**v1 implementation choice:** **2b (fail loud)** — validate **setup, test, and teardown** (full `runTestConfig` surface) plus standalone `testCmd` before run; structured errors; docs + regression tests pin that scope so the validator cannot shrink to “test command only”; **2a / 2c** deferred until the plan is updated.
