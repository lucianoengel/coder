# Workflow state & integrations — follow-up plan

This plan addresses issues observed on a real workspace (`rotmeter/.coder`) and gaps **not** covered by the workflow reliability work already merged (hang/heartbeat alignment, plan-review empty retry, reconcile + `activeRuns`, events `allRuns`, etc.).

---

## Already addressed by latest reliability commits

Deploy/use current `feat/workflow-reliability` (or main after merge) for:

- **300s implementation kills** — implementation `hangTimeoutMs` aligned with `workflow.timeouts.implementation` (including auth-retry path).
- **Empty `PLANREVIEW.md`** — bounded retry + substantive check + `PLAN_REVIEW_EMPTY_OUTPUT`.
- **Reconcile vs `start` blocked** — `releaseActiveRunsForWorkspace` before marking loop terminal.
- **Stale heartbeat during phase 3** — throttled, run-guarded ticks.
- **Loop `currentStage` / QA `activeAgent`** — `syncDevelopLoopStage` + quality-review sub-steps.

Remaining items below assume that build is deployed; they fix **other** bugs and UX.

---

## 1. P0 — `loop-state.status: "failed"` while the loop keeps running

**Symptom:** `loop-state.json` shows `status: "failed"` (and often `completedAt: null`) while `runnerPid` is alive, a queue entry is `in_progress`, and `develop.jsonl` shows continued work under the same loop `runId`.

**Root cause (code):** In `runDevelopLoop`, when an issue returns `"failed"`, the code sets `loopState.status = "failed"` and logs `loop_aborted_on_failure`, but the **main `for` loop does not `break`**. The comment says independent issues should continue — which is correct for product — but **`status` stays `"failed"` in memory** for the rest of the run. Every later `saveLoopState` from `processIssue` then persists **`failed` + `in_progress`**, which is self-contradictory and breaks status/reconcile semantics.

**Reference:** `src/workflows/develop.workflow.js` (~1562–1624): failure branch sets `loopState.status = "failed"` without resetting when the next issue starts.

**Actions:**

- **Preferred:** While the loop is still actively processing issues, keep **`loopState.status === "running"`**. Use **per-issue** `issueQueue[i].status` / `error` for terminal failure; reserve **`loopState.status = "failed"`** for when the **entire** develop loop exits in a failed state (or remove top-level `failed` entirely and derive from queue).
- **Alternative:** If top-level `failed` must mean “at least one issue failed”, introduce a separate field (e.g. `hadIssueFailure: boolean`) and keep **`status: "running"`** until the runner actually stops.
- After behavior change, add a **test** that simulates: issue A fails → issue B starts → saved loop state must not combine `status: "failed"` with `in_progress` on B.

---

## 2. P1 — GitLab `glab mr list`: early exit skips API fallback

**Symptom:** Repeated `open_prs_fetch_failed` with `unknown shorthand flag: 'F'`, and empty `activeBranches` / conflict context.

**Root cause (code):** `fetchOpenPrBranches` in `develop-git.js` tries `glabMrListArgs()` then `glabMrListArgsLegacy()` (`-F json`). The stderr matcher for “unknown flag” uses `/unknown flag|unrecognized|invalid.*flag/i`, which does **not** match **“unknown shorthand flag”**. The branch then **logs and `return []`**, so execution **never** reaches **`fetchMergeRequestsViaApi`**.

**Actions:**

- Treat **“shorthand flag”** / **“unknown shorthand”** as a benign glab version mismatch (same as unknown flag): **do not** return early; **fall through** to the next strategy or API fallback.
- Optionally **reorder**: try `--output json`, then **API fallback**, then legacy `-F` if still needed.
- Extend **`test/conflict-detection.test.js`** (or `develop-git` tests) with stderr fixture `"unknown shorthand flag: 'F'"` and assert API path is still attempted / no premature `return []`.

---

## 3. P2 — Stale `workflow-state.json` / lifecycle snapshot

**Symptom:** SQLite-backed snapshot stuck at `develop_starting` / `running` with an old `updatedAt` while `loop-state.json` and logs show real progress.

**Status:** Partially mitigated by writing **loop** `currentStage` / heartbeat during the develop pipeline; the **XState actor** still receives no `STAGE`/`SYNC` during the loop.

**Layering:** Do **not** push lifecycle updates into **`saveLoopState()`** (`src/state/workflow-state.js`) — that helper is a storage primitive and should stay decoupled from the MCP in-memory actor registry (`workflowActors` in `src/mcp/tools/workflows.js`).

**Actions (pick one):**

- After **guarded** loop-state updates on the **develop workflow / launcher path** (where `runId` and workspace are known), call into the lifecycle layer to **`SYNC`** (or `STAGE` + heartbeat) the persisted snapshot from loop fields (`currentStage`, `activeAgent`, `lastHeartbeatAt`). Wire at the same boundaries that already call `syncDevelopLoopStage` / `updateHeartbeat`, or from the MCP `runPromise` wrapper when loop state is flushed — **not** inside generic `saveLoopState`.
- **Or** stop relying on snapshot for “running” UI and document **loop-state + `develop.jsonl`** as canonical (already partly true for `coder_status`).

---

## 4. P2 — `lastFailedRunId` vs `checkpoint-*.json` (narrow remaining gap)

**Symptom:** Queue row references e.g. `d4d07c7a` but no `checkpoint-d4d07c7a.json` on disk.

**Existing behavior (do not regress):** Resume is already handled when a checkpoint is missing: **`WorkflowRunner`** emits **`resume_skipped`** and the phase-3 wrapper’s **`onResumeSkipped`** rolls **`lastFailedRunId`** forward to the **new** runner id so the next attempt has a valid retry anchor. That path is **intentional** and covered by tests (e.g. `test/workflow-runner.test.js`). **Blindly clearing `lastFailedRunId`** on missing checkpoint would **break** that roll-forward if a fresh attempt then fails mid-phase.

**Actions:**

- **Document** the above in operator-facing docs or comments near `runDevelopPipeline` phase-3 resume (`onResumeSkipped`, checkpoint load in `src/workflows/_base.js`).
- **Investigate only** residual cases where `lastFailedRunId` can **still** point at a **missing** checkpoint **after** the onResumeSkipped handoff (race, partial disk write, or guard failure) — if any, fix **that** path without undoing roll-forward.
- Optional: **prune** old `checkpoint-*.json` files when an issue completes or via explicit operator hygiene (doc-only is acceptable).

---

## 5. P3 — Operator / repo configuration (not coder code)

**Symptom:** Planning failure `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / 4096 cap on large plans.

**Actions:**

- Document in **README** (troubleshooting): set **`claude.maxOutputTokens`** (or env per your coder build) for repos with large planning prompts.
- **rotmeter** `coder.json`: raise limit if planning repeatedly fails on big issues.

---

## 6. P3 — `deferredReason: "plan_blocked"` vs `error: "plan_review_exhausted"`

**Symptom:** Looks inconsistent in raw `loop-state.json`.

**Clarification:** This is **intentional** today: `error` carries the pipeline error string (`plan_review_exhausted`); `deferredReason: "plan_blocked"` buckets the issue for **retry policy** (excluded from same-run deferred retry — see `DEFERRED_SAME_RUN_RETRY_REASONS`).

**Actions:**

- Add a **short comment** in `develop.workflow.js` next to the assignment, **or** a **README / status** note so operators are not misled.
- Optional: add **`deferredDetail`** human string separate from machine codes.

---

## Suggested implementation order

| Order | Item | Rationale |
|------|------|-----------|
| 1 | §1 Loop `status` vs continued processing | Fixes corrupt loop-state; unblocks trustworthy status/reconcile |
| 2 | §2 `glab` / API fallback | Restores conflict / open-MR detection on more glab versions |
| 3 | §3 Lifecycle snapshot sync (launcher/MCP layer) | Better MCP/UI consistency without coupling `saveLoopState` |
| 4 | §4 Docs / edge-case audit for checkpoint ids | Roll-forward already covers typical missing-checkpoint resume |
| 5 | §5–§6 Docs + clarity | Low cost, fewer false “bugs” |

---

## Primary files

- `src/workflows/develop.workflow.js` — loop status semantics, optional comments for deferral fields.
- `src/workflows/develop-git.js` — `fetchOpenPrBranches` / glab error classification.
- `src/mcp/tools/workflows.js` — lifecycle actor `SYNC` from loop fields (call sites on develop/launcher path; **not** inside `saveLoopState`).
- `test/develop-loop-*.test.js` or extend existing loop tests — §1 regression.
- `test/conflict-detection.test.js` — §2 stderr / fallback behavior.
- `test/workflow-runner.test.js` — reference for §4 resume / `onResumeSkipped` behavior.
