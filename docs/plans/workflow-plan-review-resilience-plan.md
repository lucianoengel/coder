# Plan: Plan-review failures & remaining planning edge cases

**Status:** Implemented in-tree (`plan_review_execute_failed`, `critique_missing_after_review`, fresh-session retry, `plan_missing_final`).

**Context:** Rotmeter logs (`develop.jsonl`) showed:

- **Planning:** `PLAN.md not found` (including ~5 min runs consistent with hang — addressed on `feat/planning-observability`).
- **Plan review (issue #33):** After a successful **REVISE** cycle, a **second** `develop.plan_review` run failed with **`claude plan review produced no critique output.`** (~181 s) — `PLANREVIEW.md` missing **and** stdout empty after `stripAgentNoise`.
- **Fast planning failures (#31, ~22 s):** Still hard-fail if no file and stdout doesn’t pass salvage heuristics.

This plan covers what **planning observability** did **not** add: **symmetric diagnostics for plan review**, optional **recovery/retry**, and **tightening** optional items for planning.

---

## 1. Goals

1. **Exit-0 / missing-artifact:** Operators can see **structured logs** when plan review finishes with **exit code 0** but **`PLANREVIEW.md`** is still missing after salvage — the rotmeter #33 case.
2. **Execute / nonzero / thrown errors:** Operators can see **structured logs** when `withSessionResume` / `execute` **fails before** the exit-0 path (timeout, `CommandTimeoutError`, nonzero exit from `requireExitZero`, etc.) — these failures **never reach** the “missing file after ok” branch today, so a **separate** log event is required if we want parity with goal 1 for timeouts vs empty output.
3. Reduce **flaky** “no critique file + empty stdout” outcomes without hiding real failures (bounded retry; **session policy** explicit — §3).
4. (Optional) Narrow remaining **planning** blind spots where salvage doesn’t apply (§5).

---

## 2. P1 — Plan review: structured failure logging

### 2a — Exit 0, critique still missing (today’s throw site)

**Today:** `plan-review.machine.js` throws  
`${planReviewerName} plan review produced no critique output.`  
only after `withSessionResume()` returns, `requireExitZero()` passes, `!existsSync(paths.critique)`, and stripped stdout is empty — **no** structured log event.

**Add** before that throw:

- Log event **`critique_missing_after_review`** with:
  - `critiquePath` (`paths.critique`)
  - `planPath` (`paths.plan`)
  - `artifactsDir`, `repoPath` (from state)
  - `artifactDirEntries` — truncated `readdirSync(artifactsDir)` (e.g. first 40 names)
  - `stdoutLen`, `stderrLen` (lengths only)
  - `exitCode` from `reviewRes`
  - `round` (plan revision round) from machine input

**Throw** message: append hint to check logs for `critique_missing_after_review`.

### 2b — Execute / nonzero / timeout (bypasses 2a)

Failures at **`plan-review.machine.js`** around `withSessionResume` → `execute` → **`requireExitZero`** (nonzero) or **thrown** errors (e.g. hang/timeout, auth) **do not** hit §2a.

**Add** a dedicated log on those paths, e.g. **`plan_review_execute_failed`**, with:

- `errorName`, `errorMessage` (truncated, e.g. 500 chars)
- `exitCode`, `stdoutLen`, `stderrLen` when a `res` exists; if the failure **threw** before a result, use **`err.stdout` / `err.stderr`** lengths when the sandbox attached them (e.g. fatal pattern errors)
- `round`, `critiquePath`, `planPath`
- Optional: `timeoutMs` / whether error is `CommandTimeoutError` (by name) for hang vs wall-clock timeout

Implement via a **try/catch** around the review block, or log immediately before rethrowing from `requireExitZero` failure — avoid duplicating logs on both success and failure branches.

**Tests:** Mock nonzero exit → assert `plan_review_execute_failed`; mock exit 0 + missing file → assert `critique_missing_after_review` only.

---

## 3. P2 — Plan review: bounded recovery

**Problem:** Legitimate Claude runs sometimes finish with **exit 0** but **no file** and **stream stripped to empty** (tool noise only, or UI-only output).

**Session semantics (must be explicit):** `plan-review` uses **`withSessionResume`** (`_session.js`), which persists **`planReviewSessionId`**. `runPlanLoop` keeps that session across **REVISE** rounds while clearing **`wroteCritique`** (`develop.workflow.js`). The rotmeter #33 failure was a **second** plan-review call **still resuming the same session**. A naive “call `execute` again with a short follow-up” risks **reusing the same broken session** and repeating empty output.

**Required policy for any P2-A retry:**

- **Do not** only send a follow-up message in the **same** `resumeId` session without an explicit decision.
- **Recommended:** Before the retry attempt, **clear `planReviewSessionId`** (set `null`), **`saveState`**, then run the retry through **`withSessionResume`** so it allocates a **new** `sessionId` (fresh Claude session) — analogous to starting clean after a bad transcript. Log **`critique_retry_fresh_session`** when sessions are in use; when **`sessionsDisabled`** is already true, **`withSessionResume`** invokes **`executeFn({})`** with no session id — log **`critique_retry_sessionless`** (`reason: sessions_disabled`) instead so operators are not misled.
- **Alternative (document if chosen):** Same-session follow-up only — cheaper but **higher risk** of repeating #33; if implemented, log `critique_retry_same_session: true` for forensics.

**Options (pick one primary):**

- **A. One automatic re-execute** after §2a condition (missing file + empty stdout): log **`critique_retry_empty_output`**, apply **fresh-session** policy above, then **one** second pass with a prompt that **repeats the primary review spec** (read **`PLAN.md`**, required sections, constraints, revision-round note) — not a minimal “write to path only” stub, or a fresh session has no plan context. Same **`buildPlanReviewExecuteOpts`**. **Cap:** one retry per `develop.plan_review` invocation.

- **B. Defer / soft-fail:** mark issue **deferred** with `deferredReason: plan_review_empty` (new reason) instead of hard **failed** — larger behavior change.

- **C. Diagnostics only (P1):** skip automatic retry.

**Recommendation:** **A** with **fresh session** on retry; document in README.

**Tests:** First mock → exit 0, no file, empty stdout; assert **`planReviewSessionId` cleared** (or new UUID after save) before second `execute`; second mock → writes file or salvageable stdout; assert at most one retry.

---

## 4. P3 — Salvage heuristics for critique (optional)

**Today:** If critique file missing, code already salvage from **stdout** when `stripAgentNoise` yields **non-empty** text (no structure gate).

**Optional:** Add **light** gates for critique salvage (e.g. must contain `Verdict` or `##` heading) to avoid writing garbage — **only** if field reports false positives from noise-only stdout.

**Default:** leave current “any non-empty filtered stdout” unless we see bad archives in `.coder/plan-failures/`.

---

## 5. P4 — Planning: fast-fail diagnostics (#31-style)

When **`PLAN.md` still missing** after salvage (final throw):

- Include **`lastPlannerResult` timing** in log if available (duration not always on `res` — optional).
- Log **`stdoutLen` / `stderrLen`** on final failure (same pattern as §2) for parity with plan review.

Low effort; helps distinguish “instant exit” vs “long run, no file.”

---

## 6. Out of scope

- Changing **max plan revision rounds** or **verdict** semantics.
- **Implementation / quality-review** hang alignment (separate audit if those steps show similar 5 m patterns).
- **Gemini** plan-review path (`runPlanreview`) — only extend logging if the same failure class appears there.

---

## 7. Success criteria

- Every **exit-0** hard fail with missing `PLANREVIEW.md` (after salvage) is preceded by **`critique_missing_after_review`**.
- Every **nonzero / thrown** plan-review agent failure logs **`plan_review_execute_failed`** (or equivalent) with error identity and stream lengths where available — not only the exit-0 path.
- (If P2-A) At most **one** empty-output retry; logs show **`critique_retry_empty_output`** and **fresh-session** behavior (or explicitly document same-session choice).
- README / `workflow-planning-observability-plan.md` cross-link this doc under “follow-ups.”

---

## 8. Implementation & test checklist (coding-time)

Residual risks from plan review — lock these down in code and tests:

1. **Fresh-session retry:** Tests must prove the P2-A second attempt uses a **new** Claude session (**`sessionId` create path**), not **`resumeId`**, after `planReviewSessionId` is cleared — e.g. spy on `planReviewerAgent.execute` options, or assert a new UUID was written to state before the retry.
2. **No double logging:** **`plan_review_execute_failed`** (§2b) must fire **at most once** per failed invocation — avoid logging in both a `catch` and again around **`requireExitZero`**; use a single failure path that logs then throws/rethrows.

---

## 9. References

- `src/machines/develop/plan-review.machine.js` — `withSessionResume`, critique file check, stdout salvage.
- `src/machines/develop/planning.machine.js` — `plan_missing_after_planner`, `trySalvagePlanFromStdout`.
- Rotmeter sample: `develop.jsonl` lines 59–61 (issue #33), 72–74 (issue #31).
