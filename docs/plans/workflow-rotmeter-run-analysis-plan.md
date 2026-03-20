# Rotmeter run analysis & fix plan (run `94caba7c`)

**Context:** Develop workflow on `/home/coder/workspace/rotmeter`, March 20, 2026. GitLab #39 deferred after plan review exhaustion; pipeline moved to #34; user cancelled during #34 plan review (empty-output retry).

**P0 status:** Implemented on branch `feat/launcher-cancelled-completion` at `66a27a7` — launcher completion preserves **`cancelled`** on both actor and no-actor paths (`saveWorkflowTerminalState` fallback), with tests in `test/workflow-launcher-completion.test.js`.

---

## What actually happened

### 1. GitLab #39 — plan review exhausted (not a random failure)

From `.coder/logs/develop.jsonl`:

- Three full **plan → review** cycles ran (`round` 0, 1, 2 with `maxRounds: 3`).
- Each review ended with **`REVISE`**.
- On the **last** review round, the code treats any remaining `REVISE` / `REJECT` / `UNKNOWN` as terminal exhaustion and returns `plan_review_exhausted` (`runPlanLoop` in `src/workflows/develop.workflow.js`).

The archived `PLANREVIEW.md` for the final round described **one narrow** remaining fix (Ecto `Repo.get/2` with `nil` raises; add a nil-guard). The pipeline stopped **because the round budget ran out**, not because the plan was hopelessly wrong.

**Operational takeaway:** Fixed revision count plus strict “REVISE always costs another round” can defer issues that are one small edit away from approval.

### 2. Duplicate / misleading `plan-failures` entries for #39

Two directories for the same issue (~2s apart):

- `#39-…-56-49` → `reason.txt`: **`plan_review_exhausted`** (from `develop.workflow.js` after defer).
- `#39-…-56-51` → `reason.txt`: **`issue_switch`** (from `prepareForIssue` when starting #34: archives again before `clearStateAndArtifacts` — `src/state/issue-backup.js`).

`archivePlanFailureArtifacts` only runs if `PLANREVIEW.md` still exists; after the first archive, artifacts were still present until the next issue’s `prepareForIssue`, so a **second** copy was taken with the generic reason. That confuses debugging.

### 3. GitLab #34 — empty critique + cancel timing

Logs show the intended recovery path:

- `critique_retry_empty_output` → `critique_retry_fresh_session` (same second as `cancelRequestedAt`).
- The retry **completed** ~110s later with `plan_review_verdict` (`REVISE`), then `workflow_cancelled`.

The “empty output” was a **transient** agent/tooling issue, not a stuck pipeline; cancel overlapped the retry. Optional UX: clarify “retry in progress” in status text.

### 4. `workflow-state.json` vs `loop-state.json` on cancel

- `loop-state.json` correctly shows **`cancelled`**.
- `workflow-state.json` showed **`failed`** / **`error: "unknown"`** because `applyLauncherNormalCompletion` only maps `completed`, `blocked`, or else **`failed`** — it never handles **`cancelled`** — and sends **`FAIL`** with `result.error || "unknown"` (`src/mcp/tools/workflows.js`).

When cancel has already persisted **`cancelled`** on disk, `persistTerminalLoopState(..., "failed")` often **no-ops** (guard: only updates from `running` / `paused` / `cancelling`), so loop-state stays correct while the **lifecycle actor / SQLite snapshot** still records failure.

---

## Plan to fix (prioritized)

### P0 — Correct cancelled completion (snapshot + actor)

- Extend **`applyLauncherNormalCompletion`** to treat `result.status === "cancelled"`: persist **`cancelled`** where applicable, send **`CANCELLED`** to the workflow actor (same as `markRunTerminalOnDisk`), and avoid **`FAIL` / `unknown`**.
- **Tests (`test/workflow-launcher-completion.test.js`):** Add **two** cases so operational risk is covered: (1) **`cancelled`** with a **registered** workflow actor — assert loop-state and workflow snapshot **`cancelled`**. (2) **`cancelled`** with **no** actor entry (e.g. never started or removed before completion) — assert terminal snapshot and loop-state stay **`cancelled`**; if the implementation does not yet persist the snapshot without an actor, extend **`applyLauncherNormalCompletion`** (or shared helper) to match **`markRunTerminalOnDisk`**’s **`saveWorkflowTerminalState`** fallback, then lock it in with this test.
- **Actor-missing (separate from the observed bug):** The **`failed` / `unknown`** snapshot in §4 comes from **`applyLauncherNormalCompletion`** mapping an unresolved **`cancelled`** result to **`FAIL`** on the actor — not from the no-actor branch of **`markRunTerminalOnDisk`**, which already passes **`cancelled`** through to **`saveWorkflowTerminalState`**.

### P1 — Stop duplicate / wrong `reason.txt` on issue switch

**Do not** delete or rename **`PLANREVIEW.md`** in `.coder/artifacts/` after archiving to suppress the second copy. That would break **resume** for deferred `plan_blocked` issues: `artifactConsistent()` in `issue-backup.js` requires `PLANREVIEW.md` when `steps.wroteCritique` is true; the plan-review machine sets `wroteCritique` after a critique exists; **`develop.implementation`** expects the critique artifact. Removing the file turns a resumable defer into inconsistent state or precondition failure — contradicting “safe to resume later” for #39-style defers.

Viable directions:

- **B (dedupe):** In **`prepareForIssue`**, skip **`archivePlanFailureArtifacts(..., "issue_switch")`** when this issue switch was already covered (e.g. explicit archive for `plan_review_exhausted` on the same issue, or state that records “artifacts copied to plan-failures for current selection”). **Goal:** one timestamped archive directory per logical failure where possible, without touching live artifacts needed for resume.
- **C (reason only, not dedupe):** Pass a more accurate reason into the issue-switch archive when the queue entry is already `plan_blocked`. **`archivePlanFailureArtifacts` always creates a new timestamped directory**, so this **only fixes `reason.txt` / operator confusion** — it does **not** stop a second copy. Describe it that way in any implementation notes; pair with **B** if the goal is both accurate labeling and no duplicate archives.

### P2 — Reduce false `plan_blocked` deferrals (product behavior)

- **Config:** Raise default **`workflow.maxPlanRevisions`** or document raising it in `coder.json`.
- **Reviewer prompt:** Instruct plan reviewer to use **`APPROVED`** or **`PROCEED WITH CAUTION`** when remaining items are trivial implementation nits and the plan is otherwise sound.
- **Loop semantics (optional):** Final-round handling or one bonus round — only with tests and tolerance for heuristic false positives.

### P3 — Observability / operator UX

- When **`critique_retry_empty_output`** fires, surface: retry in fresh session, expected duration.
- Optionally refresh **heartbeat** during long `plan_review` if `lastHeartbeatAt` appears stale while work continues.

### P4 — Doc alignment

`docs/plans/workflow-plan-review-resilience-plan.md` marked **max revision rounds** and **verdict semantics** as out of scope; this run is a concrete example of why that section may need a small amendment if P2 is adopted.

---

## Rotmeter workspace (operational)

- **#39:** `deferred` / `plan_blocked` with artifacts under `.coder/plan-failures/` — safe to **resume** develop loop later (see tests for `planReviewExhausted` defer + retry).
- **#34:** `pending` with branch already created; may be mid-plan — re-run develop or continue manually from that branch as needed.

---

## References

- `src/workflows/develop.workflow.js` — `runPlanLoop`, `plan_review_exhausted`, issue deferral.
- `src/mcp/tools/workflows.js` — `applyLauncherNormalCompletion`, `persistTerminalLoopState`, `markRunTerminalOnDisk` / `saveWorkflowTerminalState` fallback.
- `src/state/issue-backup.js` — `prepareForIssue`, `archivePlanFailureArtifacts`, `artifactConsistent`.
- `src/machines/develop/plan-review.machine.js` — empty-output retry, `critique_retry_*` events, `wroteCritique`.
- `src/machines/develop/implementation.machine.js` — dependency on `PLANREVIEW.md` for implementation phase.
