---
name: Codex Explicit Session Resume
overview: Replace the --last heuristic with reliable session ID capture using both --json parsing (primary) and ~/.codex/sessions/ inspection (fallback).
todos:
  - id: verify
    content: Verify thread_id from --json matches codex resume semantics
    status: pending
  - id: json-flow
    content: Implement --json flow with thread.started parsing
    status: completed
  - id: fs-fallback
    content: Implement filesystem fallback for session discovery
    status: completed
  - id: integration
    content: Wire both into implementation machine with fallback chain
    status: completed
  - id: tests
    content: Add tests for both capture paths
    status: completed
isProject: false
---

# Codex Explicit Session Resume: Implementation Plan

## 1. Problem Statement

**Current behavior:** When Codex is the programmer agent and `--session` is unsupported, we either (a) use `resume --last` with a sentinel `programmerSessionId = "__last__"` persisted after success (feat/retry-resume-from-failure), or (b) run sessionless with no resume (main). This plan applies to either baseline.

**Risk:** `--last` resumes the most recent session in the current working directory. If another Codex run occurred in the same directory between our implementation and retry, we could resume the wrong session. We have no way to verify the session is ours.

**Goal:** Capture the actual session/thread ID from each Codex run and use it explicitly for resume, eliminating the heuristic.

---

## 2. Solution Overview

Use **two complementary capture methods** with a fallback chain:


| Priority | Method                         | When used                                       | Reliability              |
| -------- | ------------------------------ | ----------------------------------------------- | ------------------------ |
| 1        | Parse from `codex exec --json` | Primary path                                    | High (documented API)    |
| 2        | Inspect `~/.codex/sessions/`   | Fallback when --json unavailable or parse fails | Medium (internal layout) |
| 3        | `resume --last`                | Final fallback when both fail                   | Low (heuristic)          |


---

## 3. Option 1: Parse from `codex exec --json`

### 3.1 How It Works

`codex exec --json` emits JSONL to stdout. The first event is:

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
```

We run with `--json`, read the first line(s) until we see `thread.started`, extract `thread_id`, and persist it. On retry, use `codex exec resume <thread_id>`.

### 3.2 Prerequisite

**Verify:** Confirm that `thread_id` from the JSON event is the same identifier accepted by `codex exec resume <id>`. The docs use both "thread" and "session"; they may be synonymous. Run a quick test: `codex exec --json "hello"`, capture thread_id, then `codex exec resume <thread_id> "continue"` and confirm it resumes.

### 3.3 Implementation

1. **CLI Agent (`src/agents/cli-agent.js`):**
  - **Resume command dispatch in `_buildCommand`:** Add explicit branch for `resumeId === "__last__"` → `codex exec resume --last ...` (flag semantics). For all other `resumeId` values → `codex exec resume <id> ...`. Without this, `__last_`_ would be passed as a literal ID instead of the `--last` flag.
  - Add `execWithJsonCapture: true` (or similar) to execute opts for Codex.
  - When set, build command with `--json` flag: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "prompt"`.
  - After `sandbox.commands.run()` returns, parse stdout line-by-line for first `{"type":"thread.started","thread_id":"..."}`.
  - Return `{ ...result, threadId: parsedThreadId }` so the caller can persist it.
2. **Implementation Machine (`src/machines/develop/implementation.machine.js`):**
  - For Codex without `--session`: call `programmerAgent.execute(..., { execWithJsonCapture: true })`.
  - **Capture session ID immediately after execute() returns, regardless of exit code** — before `requireExitZero`. Retry continuity depends on having the session ID even when the run fails (e.g. rate limit, transient error).
  - If `result.threadId` present, persist `state.programmerSessionId = result.threadId`. Else try Option 2. Else persist `"__last__"`.
  - On retry, pass `resumeId: state.programmerSessionId`.
3. **Output format impact:**
  - With `--json`, stdout is JSONL, not human-readable. The implementation machine currently does not consume stdout for display; it only checks exit code. Downstream (logs, hooks) may expect formatted text. Options:
    - **A:** Accept JSONL for Codex implementation runs when using this path. Document that logs will show JSONL.
    - **B:** Add a `--output-last-message` or similar to write the final response to a file, and stream/forward a subset for logs.
    - **C:** Run with `--json` only for the first few lines (e.g. spawn, read until thread.started, then... no, we can't switch mid-run). So we commit to JSONL for the full run when using this path.
     **Recommendation:** Use A initially. The workflow does not display implementation output to the user in real time; it's primarily for the agent. If UX requires human-readable output, we can add a separate "summary" extraction from the JSONL (e.g. last `agent_message` item) for logging.
4. **Error handling:**
  - If `thread.started` never appears (e.g. Codex version difference, stream error), fall through to Option 2.
  - If `--json` causes Codex to fail or behave differently, fall through to Option 2.

---

## 4. Option 2: Inspect `~/.codex/sessions/`

### 4.1 How It Works

Codex stores sessions under:

```
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

Each file is JSONL. One or more lines contain `sessionId` and `cwd`; metadata may appear on the first line or any later line.

1. Resolve `CODEX_HOME` or `~/.codex`.
2. Recursively find `rollout-*.jsonl` files under `sessions/`.
3. **Run-boundary filter:** Only consider files with `mtime >= runStartTime` (strict; no slack). Record `runStartTime` immediately before calling execute(). A slack (e.g. `runStartTime - 100`) would admit pre-run sessions under fast repeated runs and can reintroduce stale binding.
4. **Concurrent-run ambiguity:** Option 2 cannot reliably disambiguate when multiple Codex runs overlap in the same cwd. Session file mtime reflects write time, not process start time — a run that starts later can write its file earlier. **No ordering heuristic guarantees our run.** Document: when concurrent runs exist, Option 2 is best-effort; prefer Option 1 (--json) when available. Sort by mtime asc as a tie-breaker only; do not claim it selects "our" run.
5. For each file (in mtime-asc order), scan lines (not just the first) until a line parses as JSON with both `sessionId` and `cwd`. Check if `cwd` matches our workspace (normalize paths).
6. Return the first matching `sessionId`.

### 4.2 Implementation

1. **New helper (`src/agents/codex-session-discovery.js` or in `cli-agent.js`):**

```js
   /**
    * Find a Codex session ID for the given workspace, scoped to sessions created
    * during the current run (run-boundary filter). Iterates files by mtime asc
    * (oldest first) and returns the first cwd match — tie-breaker only.
    * @param {string} workspaceDir - Absolute path to workspace (must match cwd in session file)
    * @param {number} runStartTimeMs - Timestamp (Date.now()) recorded before execute(); only accept files with mtime >= runStartTimeMs (strict; no slack)
    * @returns {string|null} - sessionId or null if not found
    */
   export function discoverCodexSessionId(workspaceDir, runStartTimeMs) { ... }
```

1. **Logic:**
  - `const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');`
  - `const sessionsDir = path.join(codexHome, 'sessions');`
  - Use `readdirSync` with `recursive: true` (Node 18+) or a simple recursive walk.
  - Filter to `rollout-*.jsonl` **with mtime >= runStartTimeMs** (strict; no slack — slack admits pre-run sessions).
  - Sort remaining by `statSync().mtimeMs` asc (tie-breaker only; does not guarantee our run when concurrent).
  - For each file, read lines and scan until a line parses as JSON with both `sessionId` and `cwd` (metadata may be on any line).
  - Normalize: `path.resolve(workspaceDir)` vs `path.resolve(cwd)` for comparison.
  - Return first match.
2. **When to call:**
  - **Immediately after `programmerAgent.execute()` returns** (success or failure), when we did NOT get `threadId` from Option 1. Call before `requireExitZero` — retry continuity requires the session ID even on non-zero exit.
  - Pass `runStartTimeMs` (recorded before execute()) so we only accept sessions from this run.
3. **Edge cases:**
  - Session file may not exist yet (Codex writes asynchronously). Add a short retry loop (e.g. 3 attempts, 200ms apart) before giving up.
  - Multiple sessions in same second: prefer the one with cwd match; if multiple match, take the first (oldest by mtime, per tie-breaking above).
  - `CODEX_HOME` may point elsewhere; respect it.

---

## 5. Fallback Chain

### 5.1 Flow

```
1. For Codex, first run (no programmerSessionId in state):
   - If codexSessionSupported() (--session): use existing --session path.
   - Else: run with execWithJsonCapture (--json).
     - **Capture session ID immediately after execute() returns, regardless of exit code** (before requireExitZero). Parse thread_id from stdout; if found, persist.
     - On parse failure: call discoverCodexSessionId(), persist if found.
     - On both fail: persist "__last__", use resume --last (current behavior).
     - **If execute() throws** (timeout, hang, fatal error): in the catch block, call discoverCodexSessionId() before rethrowing; if found, persist. If discovery also fails, persist "__last__" before rethrowing so retry still uses the documented final fallback instead of dropping to no resume ID.

2. For Codex, retry (programmerSessionId in state):
   - If `id === "__last__"`: use `codex exec resume --last`.
   - Otherwise: use `codex exec resume <id>`. No format validation — pass through as-is (see 5.2).
```

### 5.2 Resume ID Dispatch (single source of truth)

- **Explicit sentinel:** `id === "__last__"` → `codex exec resume --last`.
- **All other values:** `codex exec resume <id>`. Do not validate format; pass through as-is. Codex may change identifier format; non-sentinel IDs always pass through.

---

## 6. File Changes Summary


| File                                                     | Changes                                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/cli-agent.js`                                | Add _buildCommand branch for `resumeId === "__last__"` → `resume --last`; add execWithJsonCapture path; parse thread.started from stdout when set; return threadId in result.                        |
| `src/agents/codex-session-discovery.js`                  | New: `discoverCodexSessionId(workspaceDir, runStartTimeMs)` with run-boundary filter.                                                                                                                |
| `src/machines/develop/implementation.machine.js`         | Record runStartTime before execute; capture session ID after execute (before requireExitZero) and in catch block when execute() throws; persist on success, failure, and throw; wire fallback chain. |
| `test/cli-agent.test.js`                                 | Test --json path, thread_id parsing, fallback behavior.                                                                                                                                              |
| `test/codex-session-discovery.test.js`                   | New: test discoverCodexSessionId with mock sessions dir, run-boundary filter.                                                                                                                        |
| `test/implementation-machine.test.js` (or develop-retry) | Integration: state persistence of programmerSessionId; retry uses correct resume command; capture on failure and throw paths.                                                                        |


---

## 7. Implementation Order

1. **Verify** thread_id semantics (manual test).
2. **Implement Option 2** (filesystem) first — it does not change how we invoke Codex, so lower risk. Add `discoverCodexSessionId` and unit tests.
3. **Implement Option 1** (--json) — add execWithJsonCapture flag, parsing, threadId extraction. Add tests.
4. **Wire fallback chain** in implementation machine.

---

## 8. Risks and Mitigations


| Risk                               | Mitigation                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| thread_id ≠ session_id for resume  | Verify in prerequisite step; if different, Option 2 may be primary.                                                                            |
| --json changes output format       | Document; accept JSONL for Codex implementation runs.                                                                                          |
| ~/.codex/sessions/ layout changes  | Version detection or graceful fallback to **last**.                                                                                            |
| Race: session file not yet written | Retry loop with short delay.                                                                                                                   |
| Option 2 binds to wrong session    | Strict filter (mtime >= runStartTime, no slack). Option 2 cannot reliably disambiguate concurrent runs; best-effort only.                      |
| No session ID on failure           | Capture immediately after execute(), before requireExitZero; persist regardless of exit code.                                                  |
| execute() throws (timeout/hang)    | In catch block, call discoverCodexSessionId() before rethrowing; persist if found, else persist "**last**" so retry still uses final fallback. |


---

## 9. Open Questions (Resolved)


| Question                                                                                                             | Answer                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Should session capture happen immediately after execute() returns (regardless of exit code), before requireExitZero? | **Yes.** Retry continuity requires the session ID even when the run fails.                                                |
| Can you add a run-start timestamp so Option 2 only accepts files created during our invocation?                      | **Yes.** Pass `runStartTimeMs` to `discoverCodexSessionId`; filter files by `mtime >= runStartTimeMs` (strict; no slack). |


---

## 10. Success Criteria

- On retry, we use `codex exec resume <id>` with the captured session ID when we captured one (Option 1 or 2). No format validation — pass through as-is.
- We only fall back to `resume --last` when both capture methods fail.
- No regression for Claude or other agents.

