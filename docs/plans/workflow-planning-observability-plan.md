# Plan: Planning failures & status observability (rotmeter-style runs)

**Status:** Implemented on branch `feat/planning-observability` (planner/reviewer `hangTimeoutMs: 0`, PLAN salvage + diagnostics, glab shorthand stderr, `derivedArtifactPhase` for develop runs only, README).

Context: monitoring a long-running develop workflow (GitLab issues, Claude planner) surfaced **intermittent planning failures**, **glab CLI noise**, and **confusing `coder_status`**.

---

## 1. Issues observed (from the field)

| Symptom | Likely cause | Severity |
|--------|----------------|----------|
| Planning “fails” / no `PLAN.md` while runs sometimes succeed later | Mixed: see §2 | P1 |
| `coder_status.currentStage` shows `develop_starting` while `artifacts.planExists` / `steps` show later work | Loop snapshot vs machine `state.steps` / filesystem not fused in one view | P2 |
| `glab mr list` / `-F` / `--output` warnings in logs | glab version vs two hard-coded arg shapes; see §1.1 | P3 (ops + optional regex tweak) |
| Shell `mcp__coder__coder_status` not found | Operator mistake — MCP tools are not shell commands | — (docs only) |

### 1.1 GitLab `fetchOpenPrBranches` — actual behavior (this repo)

As implemented in `src/workflows/develop-git.js`:

1. Loop over two shapes: **`glab mr list --output json`**, then **`glab mr list -F json`** (`glabMrListArgs()` / `glabMrListArgsLegacy()`).
2. On each failed attempt (non-zero status, empty stdout, or JSON parse error): read stderr. If it **does not** match the “unknown flag” regex below **and** the `log` callback is provided (`if (!isUnknownFlag && log)`), the function logs **`open_prs_fetch_failed`** and **`return []` immediately** — it does **not** try the next CLI shape and does **not** call the API (`develop-git.js` ~149–159). If `log` is omitted, the loop can continue despite stderr not matching (unusual for develop callers).
3. Only if the loop finishes with `mrs` still empty does it call **`fetchMergeRequestsViaApi`**.

“Unknown flag” detection for **continuing** the loop (instead of that early return) uses `isGlabMrListFormatMismatchStderr` in `develop-git.js`:

`/unknown flag|unrecognized|invalid.*flag|shorthand flag/i`

If stderr **does not** match and `log` is set, the early return still applies — but **`unknown shorthand flag: 'F'`** now matches and allows trying the legacy `-F json` shape and/or the API.

---

## 2. Root cause analysis: “PLAN.md not found” vs timeouts

The string **`PLAN.md not found: <path>`** is thrown only in `planning.machine.js` **after** `plannerAgent.execute()` returns and **`requireExitZero`** passes — i.e. the process reported **exit code 0** but **`existsSync(paths.plan)`** is false.

Separately, the sandbox enforces:

- **`timeoutMs`** — total wall clock (planning uses `ctx.config.workflow.timeouts.planning`, default **40 min**).
- **`hangTimeoutMs`** — default from `agents.retry.hangTimeoutMs` (**300_000 ms = 5 min**) — kills if **no stdout** for that long; stderr resets the hang timer only when `hangResetOnStderr` is true (`CliAgent`: true for Claude).

So:

1. **Hang kill** → `CommandTimeoutError` / “Command timeout after …ms” (message uses the **hang** duration, not `timeouts.planning`). If logs were summarized as “timeout ~5 min”, correlate with **hang**, not the 40m planning budget.
2. **True `PLAN.md not found`** → agent exited 0 but did not write the exact artifact path (compliance, wrong path, or very unusual race). Durations ~90s–300s are consistent with an agent “finishing” without producing the file.

**Recommendation:** Treat these as **two different failure modes** in logs and runbooks.

---

## 3. Proposed work

### P1 — Align hang detection with step timeouts (code)

**Problem:** Long, quiet planning sessions can hit **5m hang** while `workflow.timeouts.planning` allows 40m.

**Critical implementation detail:** `planning.machine.js` calls `plannerAgent.execute()` in **two places** — the **normal** path (~line 286) and the **auth-retry** path (~line 330) after `session_retry_no_session`. Updating only the first call **preserves** the intermittent failure mode on the retry.

**Requirement:** **Centralize** planner execute options in one helper or object, e.g. `buildPlannerCliOpts(ctx)` returning `{ timeoutMs, hangTimeoutMs, ... }`, and **spread** it into **both** `execute()` calls so the retry path **cannot** diverge.

Same pattern for **plan review** if it has multiple `execute` sites (or wrap `executeFn` in `withSessionResume` to inject opts once).

**Options (pick one, prefer A):**

- **A.** Pass **`hangTimeoutMs: 0`** on planner/reviewer `execute()`, so only **`timeoutMs`** bounds the call; hang stays useful for chattier steps.
- **B.** Pass **`hangTimeoutMs`** equal to **`ctx.config.workflow.timeouts.planning`** / **`planReview`** so silence budget matches the step.
- **C.** Global config: `workflow.timeouts.planningHangMs` with default `0` or aligned to `planning`.

**Tests:** Unit or integration asserting **both** code paths pass the same `hangTimeoutMs` (mock agent / spy on `execute`).

### P1 — Missing `PLAN.md` after exit 0: diagnostics vs salvage (code)

**Today:** `plan-review.machine.js` mitigates missing **PLANREVIEW.md** by stripping agent noise from **stdout** and writing the file when non-empty (~149–159).

**Planning** still **hard-fails** if `PLAN.md` is missing after a clean run (~402–403).

**Plan:**

1. **Minimum (always):** Richer failure data when throwing: log `paths.plan`, `ctx.artifactsDir`, `repoPath`, and (log-only) a truncated directory listing — same spirit as the original observability item.

2. **Optional recovery (decide explicitly):**

   - **Option — stdout salvage:** Mirror plan-review: if `!existsSync(paths.plan)` and `res.stdout` after `stripAgentNoise` is non-empty and looks like markdown with plan-like structure, write to `paths.plan`. **Risk:** planner stdout is often **tool/stream noise** or partial reasoning; false positives could commit garbage as `PLAN.md`. Safer if gated (e.g. minimum length, required heading `#`, or “only if stdout contains `## Implementation`” heuristic).
   - **Option — document skip:** If salvage is **not** implemented, state **why** in code comment + this doc: critique is short and verdict-scoped; plans are long and easy to corrupt from stdout alone.

Do not leave the doc at “better errors only” without addressing the **asymmetry** with plan-review.

### P2 — Status fusion for monitors (code or doc)

**Problem:** `getStatus` (`status.js`) sets `currentStage` from **loop state** or **workflow snapshot**, while `steps` / `artifacts.*` come from **machine state** / FS — they can **temporarily disagree** during transitions or if loop sync lags.

**Options:**

- **Doc-only:** In README or MCP tool description, explain: *prefer `steps` + `artifacts` for “what exists”; use `currentStage` as coarse runner position.*
- **Code:** Add optional `derivedPhase` (e.g. `issue_draft | planning | plan_review | …`) computed from `steps` + artifact existence when `runStatus === "running"`, without removing raw fields.

### P3 — Operations (rotmeter / self-hosted)

- **glab:** Know the **two-arg** loop and that **API runs only** if the loop exits without the **`open_prs_fetch_failed` / `return []`** short-circuit (~149–159). Upgrade glab or extend stderr matching if logs show **shorthand-flag** errors that trigger that path.
- If planning is consistently slow, raise **`workflow.timeouts.planning`** / **`planReview`** in `coder.json` **after** hang alignment — otherwise hang may still dominate.
- Do not script `mcp__coder__*` in bash; call **`coder_status`** via MCP.

---

## 4. Out of scope / already addressed elsewhere

- **Multi-issue loop terminal status** / lifecycle **SYNC** — covered by workflow reliability + follow-up work on `feat/workflow-reliability`.
- **Plan-review resilience** (structured failure logs, fresh-session empty-output retry) — see **[workflow-plan-review-resilience-plan.md](./workflow-plan-review-resilience-plan.md)**.

---

## 5. Success criteria

- No default **5m silent kill** during planning while **40m** planning timeout is configured (unless explicitly desired), on **both** normal and auth-retry planner executes.
- Field debugging distinguishes **hang timeout** vs **missing artifact after exit 0** from logs alone; missing-plan path either **salvages safely** or **documents why not**.
- Monitor/readme text explains how to read **`currentStage`** vs **`steps`/`artifacts`**.
- Plan/docs **match** `develop-git.js` behavior for GitLab MR listing (no references to helpers or flags that are not in tree).
