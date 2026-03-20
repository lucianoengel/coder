# Coder workflow reliability plan

## Goals

- Stop false “implementation timeouts” when the workflow budget is much longer.
- Make **status** and **events** match what operators infer from logs.
- Reduce **silent stalls** and confusing **retries** after QA approval.

---

## 1. Align hang timeout with implementation wall-clock

**Problem:** `CliAgent.execute` applies `hangTimeoutMs` from `agents.retry.hangTimeoutMs` (default **5 minutes**) while implementation passes **only** `timeoutMs` from `workflow.timeouts.implementation` (often **60 minutes**). Hang and wall-clock limits are independent; a quiet CLI session can be killed by the hang timer first. See `implementation.machine.js` (`execOpts`) and `cli-agent.js` (`hangTimeoutMs` vs `timeoutMs` in `sandbox.commands.run`).

**Actions (code or validation required — documentation alone is insufficient):**

- **Enforce in code:** pass `hangTimeoutMs` on the implementation `execute` call so it matches or exceeds `workflow.timeouts.implementation`, or disable hang for that call when product-safe; **or**
- **Enforce at config load:** validate that `agents.retry.hangTimeoutMs` ≥ `workflow.timeouts.implementation` (or equivalent rule) and fail fast with a clear error.
- Add a test that the implementation path cannot hit hang kill before the configured implementation wall-clock without an explicit override.
- README / example config may **supplement** the above but must not be the only fix.

---

## 2. Heartbeat during phase 3 (implementation → QA → PR)

**Problem:** `updateHeartbeat` runs after phases 1, 2, and end of 3 only. The phase-3 `WorkflowRunner` uses the default `onHeartbeat` (no-op), so `lastHeartbeatAt` can go stale for the entire implementation and QA window.

**Safety constraint (run-scoped):** The existing `updateHeartbeat(ctx)` helper reloads `.coder/loop-state.json` and writes back using whatever `runId` is on disk. That is **not** safe to call blindly from a background tick: during restart/cleanup overlap, an old runner could still be alive and refresh **another** run’s `lastHeartbeatAt`, hiding staleness. Heartbeat updates from phase 3 must **only** apply when the on-disk `runId` matches the **emitting** workflow run (e.g. `phase3Runner.runId` / loop `guardRunId`), or use a dedicated helper that takes `expectedRunId` and no-ops on mismatch.

**Actions:**

- Add run-guarded heartbeat writes (new helper or extended `updateHeartbeat`) and wire `onHeartbeat` on the phase-3 runner to that path (optionally throttled).
- Consider the same pattern for other long `WorkflowRunner` instances if they can run for many minutes without crossing existing heartbeat points.

---

## 3. Loop state: stage and active agent

**Problem:** Loop `currentStage` is only `processing` / `retry` per issue; `activeAgent` is set at workflow start (issue selector) and not updated for planner/programmer/reviewer. Lifecycle actor snapshots are not fed `STAGE`/`HEARTBEAT` during the run, so persisted snapshot can stay at `develop_starting`.

**Actions:**

- **Stage:** On each machine transition (where `develop_stage` / `machine_start` is logged), update loop state `currentStage` to machine id or a stable alias (one value per machine is fine).
- **`activeAgent`:** Do **not** stamp a single configured role per machine for `develop.quality_review` — that machine runs **programmer, reviewer, and committer** in sequence; a machine-level field would misreport who is active for much of the longest phase. Prefer one of: sub-step hooks that update loop state (or `activity.json`) when each inner agent starts; or document that coarse loop `activeAgent` is best-effort and operators should use existing **`agentActivity`** / fine-grained artifacts for QA.
- Throttle `saveLoopState` if needed.
- **`readWorkflowRunState`:** Precedence is **already** defined — running/paused runs prefer loop state, else persisted workflow snapshot (`status.js`). The remaining gap is **keeping those sources in sync** during the run (writes), not redesigning precedence.

---

## 4. MCP `events` + `afterSeq` + run filter

**Problem:** `readWorkflowEvents` filters by current `runId` while paging by **line index**. Skipped lines still advance the window, so clients can see **empty or tiny** pages even though the log grew.

**Actions:**

- Document: `seq` is line-based; filtering can yield empty pages; use `nextSeq` or `afterSeq: 0` with a larger limit for history.
- Add an optional parameter to **disable run filtering** (e.g. for ops/debug).
- Optional follow-up: page by “N matching events” instead of “N lines” for clearer client behavior.

---

## 5. Phase-3 retries after QA approval

**Problem:** `runWithMachineRetry` retries the whole phase-3 pipeline. After QA `APPROVED`, a later failure (e.g. PR step) can make a retry **look like** “implementation again,” especially with checkpoint + `implemented` flags.

**Actions:**

- Inspect logs for `machine_retry_attempt` / failed machine name on real incidents.
- Improve logging: reason, failed machine, whether `implemented` was cleared, resume step index.
- If needed, narrow retries so failures after review don’t unnecessarily clear implementation or restart from step 0.

---

## 6. Silent stall / zombie `running` state

**Problem:** If the runner dies without normal completion, logs and processes can stop while loop state still says `running`.

**Already in place:** The MCP launcher `runPromise` catch path persists failed terminal state on disk; `readWorkflowStatus` already returns `runnerPid`, `runnerAlive`, `isStale`, and `staleReason`. Do not re-implement those.

**Remaining gap:** Focus on **auto-repair / cleanup** — e.g. when `runnerPid` is dead (or heartbeat is truly stale) but loop status is still `running`, optionally auto-mark failed, or expose a documented MCP/CLI action to reconcile state without a full daemon restart.

---

## 7. Plan review: empty / missing critique

**Problem:** Plan review can fail with “no critique output” when the model/CLI returns nothing usable; combined with max rounds this becomes DEFERRED/FAIL without a clear retry path.

**Actions:**

- Add a **small, bounded retry** inside plan-review for empty/unparseable output (re-prompt or single retry with stricter instructions).
- Keep `planReviewExhausted` behavior but ensure errors are **typed** and documented for operators.

---

## Implementation order

| Order | Track | Why |
|------|--------|-----|
| 1 | Hang vs implementation timeout | Stops the main false-timeout class |
| 2 | Phase-3 heartbeat | Fixes “frozen” heartbeat during long work |
| 3 | Events API docs + optional `allRuns` | Stops pagination confusion |
| 4 | Loop `currentStage` / `activeAgent` | Aligns status with logs |
| 5 | Retry logging / narrower resume | Explains “implement again” cases |
| 6 | Stall: auto-repair / reconcile when PID dead vs `running` | Closes gap beyond existing catch + staleness fields |
| 7 | Plan-review empty-output retry | Cuts flaky DEFERRED/FAIL |

---

## Primary files

- `src/agents/cli-agent.js`, `src/machines/develop/implementation.machine.js`, `src/config.js`
- `src/workflows/develop.workflow.js`, `src/workflows/_base.js`
- `src/mcp/tools/workflows.js`, `src/mcp/tools/status.js`
- `src/machines/develop/plan-review.machine.js`
- `coder.example.json`, `README.md` (config/docs only as needed)
