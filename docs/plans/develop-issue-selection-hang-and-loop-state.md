# Develop workflow: issue-selection “hang” and loop-state drift

This document records findings from investigating the **rotmeter** workspace (example paths: `/home/coder/workspace/rotmeter/.coder`) and proposes fixes in the **coder** project. It is a planning artifact; implementation is tracked separately.

---

## Symptoms

- Every **develop** run appears to **stall** after GitLab issues are fetched: logs show `step1_list_issues` and `step1_fetch` then nothing else.
- **UI / status** may still show **`running`** / **`develop_starting`** even though the workflow has already failed.
- Retries repeat the same pattern.

---

## Root cause 1: Hardcoded two-minute hang timeout vs. slow / silent agent output

### What the data showed

- `workflow-state.json` contained an error like:

  `Command timeout after 120000ms: ... claude -p ... Here are the open GitLab issues...`

- **120000 ms** is the **hang** timeout (no stdout/stderr activity), not the full `workflow.timeouts.issueSelection` wall-clock budget.
- `develop.jsonl` stopped after `step1_fetch` with a large issue count (e.g. 34).
- `claude.jsonl` showed almost no output—consistent with the model (e.g. OpenRouter-routed `stepfun/step-3.5-flash:free`) taking **longer than two minutes** before emitting anything the sandbox observes.

### Why it happens (how hardcoded it is)

1. **`develop.issue_list`** sets a **fixed** `HANG_TIMEOUT_MS` (120000) and passes it to **`agent.executeWithRetry`** for:
   - **Linear** project listing (when applicable), and  
   - **main issue listing** (GitHub / GitLab / Linear).
2. That value **overrides** the CLI agent’s normal path: `cli-agent.js` already supports **config-driven** `hangTimeoutMs` (`config.agents?.retry?.hangTimeoutMs`), but this machine **bypasses** it by always passing an explicit `hangTimeoutMs`.
3. The **wall-clock** timeout for the same calls still uses `ctx.config.workflow.timeouts.issueSelection` (much larger by default)—so hang kills the process **long before** the configured issue-selection budget is reached.
4. Large prompts + remote/slow models often exceed **two minutes** before the first token or progress line → **predictable failure**, not an infinite “wait.”

### Proposed fixes

| Priority | Change | Rationale |
|----------|--------|-----------|
| P0 | **Stop hardcoding** `120000`: derive hang timeout from **config** (e.g. reuse `agents.retry.hangTimeoutMs`, add `workflow.timeouts.issueSelectionHang`, or set `hangTimeoutMs` proportional to / capped by `issueSelection`) | Aligns with existing CLI agent behavior and operator tuning |
| P0 (alt) | **Disable hang detection** for these issue-list calls (`hangTimeoutMs: 0`) and rely on **wall-clock** `timeoutMs` only | Defensible because `issueSelection` already bounds total wait; avoids false positives on silent-but-working models |
| P1 | **Prompt diet** (see Root cause 3) | Reduces time-to-first-token and hang risk |

---

## Root cause 2: Loop-state drift — launcher terminalization gap (not `runDevelopLoop` only)

### What the data showed

- **`loop-state.json`**: `status: "running"`, `currentStage: "develop_starting"`, `completedAt: null` for run id `d3fadba1`.
- **`workflow-state.json`** (same `runId`): lifecycle **`failed`** with `completedAt` and a concrete error string.

### Correct framing

- Early failures in **`runDevelopLoop()`** already return `{ status: "failed" }` (e.g. after `issueListMachine.run` at `develop.workflow.js` ~695, zero issues ~720, preflight ~736). The bug is **not** that the loop forgets to return failed.
- The **stale** `running` / `develop_starting` **loop-state** persists because the **workflow launcher** (`src/mcp/tools/workflows.js`) updates the **workflow actor** on normal completion but **does not reconcile `loop-state.json`** when `runDevelopLoop()` returns **`failed`**, **`completed`**, or **`blocked`** on the success path.
- **`markRunTerminalOnDisk()`** (`workflows.js` ~122) already performs the right disk update (and actor notification); today it is used on the **exception** path (`catch`), **not** when the background promise resolves with a terminal `result.status`.

### Why it matters

**Status tooling prefers loop-state** when it looks “active” (`status.js` ~35–48): if `loop-state.json` still says `running`, the UI keeps showing a live run even though **`workflow-state.json`** already recorded **failed**.

### Proposed fixes

| Priority | Change | Rationale |
|----------|--------|-----------|
| P0 | On **normal** terminal return from the develop background run, call **`markRunTerminalOnDisk`** (or a small shared **terminal-state helper**) with the appropriate status derived from `result.status` — same as the `catch` path conceptually | Fixes all early exits without scattering special cases inside `runDevelopLoop()` |
| P1 | Surface **last error** in status when loop and snapshot disagree, or prefer snapshot when loop is stale | Easier debugging on repeated failures |

**Implementation placement:** **launcher** (`workflows.js`) or a **shared terminal-state helper**, not a one-off patch only inside `runDevelopLoop()`.

---

## Root cause 3: Prompt size — `maxIssues` does **not** protect issue selection

### Scope (broader than “34 GitLab issues”)

- **`runDevelopLoop`** applies **`maxIssues`** only **after** `issueListMachine.run` returns (`develop.workflow.js` ~706–718). The **LLM** (GitHub / GitLab / Linear remote path) already received the **full** fetched list in the prompt built **inside** `issue-list.machine.js`.
- **GitHub:** `gh issue list` up to **50** issues with **full body and comments** in JSON (`issue-list.machine.js` ~102–114, prompt ~427).
- **GitLab:** `glab api` uses **`per_page=100`** and loops up to **10** pages (`issue-list.machine.js` ~155–201), so up to **~1000 issues total** across the fetch, not 1000 per page; descriptions truncated to 500 chars each — still huge at scale — prompt ~443.

So even with **`maxIssues: 1`**, issue selection can still send a **massive** prompt unless the list is trimmed **before** the agent call inside **`develop.issue_list`**.

### Proposed fixes

| Priority | Change | Rationale |
|----------|--------|-----------|
| P1 | **Inside `issue-list.machine.js`**, before `executeWithRetry`: cap rows / truncate fields / drop comments for the **model-facing** payload (CLI fetch can stay richer if needed for logging) | Actually reduces tokens and hang risk |
| P2 | **Operational workarounds**: `issueIds` skips the LLM for GitHub/GitLab; different **issueSelector**; fewer open issues upstream | Unblocks without product changes |

---

## Environment checks (no code)

- Run a **minimal** `claude -p` test in the same repo cwd and confirm output within a few minutes.
- Confirm **`OPENROUTER_API_KEY`** and model id; free tiers may add latency or odd empty behavior.
- Confirm **`GITLAB_TOKEN`** / `glab` still return issues (already implied if `step1_fetch` logs `count`).

---

## Suggested implementation order

1. **Launcher loop-state terminalization** for normal `failed` / `completed` / `blocked` returns (`markRunTerminalOnDisk` or equivalent) — fixes misleading “always running.”
2. **Config-driven or disabled hang timeout** for `develop.issue_list` — fixes repeated 120s kills.
3. **Prompt diet inside issue-list machine** before the LLM call — robustness at scale; do **not** assume `maxIssues` fixes this.

### Implemented (branch `feature/develop-issue-list-launcher-fixes`)

- **`persistTerminalLoopState`** in `workflows.js` (**exported** for tests); runs **before** `activeRuns.delete` / actor teardown on the normal path; uses **`saveLoopState(..., { guardRunId })`** so a stale finish cannot overwrite a newer run’s loop-state; **`saveLoopState` returns `false`** when the guard skips a write, and **`persistTerminalLoopState` returns false** in that case so **`markRunTerminalOnDisk`** does not send terminal actor events for the wrong run; **wraps errors** (logs to stderr, returns false) so a disk failure does not fall through to `catch` and reclassify success as failure.
- **`markRunTerminalOnDisk`** refactored to reuse **`persistTerminalLoopState`**.
- **`workflow.timeouts.issueSelectionHangMs`** (default **0** = hang detection off; wall-clock still **`issueSelection`**) and **`workflow.issueListPromptMaxIssues`** (default **50**); GitHub/GitLab prompts use slimmed rows and log **`step1_prompt_trimmed`** when capped. **`resolveIssueListHangTimeoutMs`** / slim helpers are **named exports** from `issue-list.machine.js` for tests.
- **Tests:** `test/workflow-launcher-loop-state.test.js`, `test/issue-list-selector-prompt.test.js`.
- **`host-sandbox.js`**: force-settle after fatal kill if **`close`** never arrives (separate concern; review independently).

---

## Tests to add (suggested)

- Issue listing machine returns **error** → loop state ends **terminal**, status tools consistent.
- **Zero** issues returned → loop state **terminal** (`completed` or equivalent), not stuck `running`.
- **Preflight** fails early → loop state **terminal** `failed`.
- **Slow / silent** issue selector: respects **config-driven** hang timeout (or `0` = no hang) and does not die at a hidden 120s cap when wall-clock allows longer.

---

## Risks (implementation)

- **Misplacing** the loop-state fix (only inside `runDevelopLoop`) leaves the **launcher** inconsistency for other terminal paths.
- **Assuming `maxIssues`** already limits the issue-selector prompt — it does **not**; prompt shaping must happen in **`issue-list.machine.js`**.

---

## Assessment

Directionally the plan is **correct** on both root causes. The loop-state item should be reframed as a **workflow-launcher terminalization gap**, not a hidden bug inside `runDevelopLoop()` alone. There is no strong evidence of a deeper loop bug beyond **launcher reconciliation**, **hardcoded hang**, and **pre-slice prompt size**.

---

## References (code locations)

| Area | Location |
|------|----------|
| Fixed hang + both agent calls | `src/machines/develop/issue-list.machine.js` (~15, ~357, ~464) |
| Config hang default | `src/agents/cli-agent.js` (~319) |
| `maxIssues` slice **after** list | `src/workflows/develop.workflow.js` (~706–718) |
| GitHub fetch shape | `issue-list.machine.js` (~102–114), prompt (~427) |
| GitLab fetch / prompt | `issue-list.machine.js` (~152+), prompt (~443) |
| Early failed returns | `develop.workflow.js` (~695, ~720, ~736) |
| `markRunTerminalOnDisk`, actor paths | `src/mcp/tools/workflows.js` (~122, ~814+) |
| Status prefers loop when “active” | `src/mcp/tools/status.js` (~35) |
| Sandbox hang vs wall-clock | `src/host-sandbox.js` |
| Default `issueSelection` | `src/config.js` (`workflow.timeouts.issueSelection`) |

---

## Example workspace config (context)

Rotmeter used GitLab issue source, `issueSelector: "claude"`, and OpenRouter-backed Claude model settings in `coder.json`. That combination exacerbates slow time-to-first-output vs. a fixed 2-minute hang window.
