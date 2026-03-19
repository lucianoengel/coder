# Session Auth Failure Tracking

**Issue:** Planning stage fails with "Session ID X is already in use" (auth/session collision).

**Last updated:** 2025-03-19

---

## Root Cause: Sandbox Kill Race (Confirmed)

**High:** When a fatal stdout/stderr pattern matches, the sandbox sent SIGTERM and **immediately** rejected the promise (~8ms), without waiting for the child to exit. The killed child could still run for 2.5+ seconds. The planning retry could start while the first Claude process was still alive, causing both to compete for session storage → "already in use".

**Fix:** Defer `settle(err)` until the child's `close` event fires. On pattern match: send SIGTERM, set `pendingFatalError`, start 2s escalation timer. If child doesn't exit, escalate to SIGKILL. When `close` fires, settle with `pendingFatalError`. If overall timeout fires while `pendingFatalError` is set, escalate to SIGKILL (don't settle with timeout); wait for `close`. This ensures: (1) process is actually gone before retry, (2) fatal errors stay fatal even when child ignores SIGTERM.

**File:** `src/host-sandbox.js` — `pendingFatalError`, escalation timer, `terminateChild(signal)`.

---

## Symptoms

- **Stage:** `develop.planning` (step3a_create_plan)
- **Error:** `Command aborted after fatal stderr match [auth]: already in use`
- **Observed:** `session_auth_failed` is logged with `wasCreating: true`, but no `session_retry_no_session` between it and `machine_complete` (error)
- **Impact:** Workflow fails; issue draft succeeds, planning fails every time

---

## Root Cause Analysis

### What We Know

1. **session_auth_failed is logged** → The planning machine's auth-error catch block is entered. We have `isAuthError && hadSessionOpts`.

2. **No session_retry_no_session in events** → Either:
   - The retry never runs (e.g. `saveState` throws before we get there)
   - The `session_retry_no_session` log was added recently and isn't in the deployed version
   - The retry runs but fails immediately (before we could log, or the log isn't emitted)

3. **Error message is "Command aborted..."** → The kill pattern matched. That requires `killOnStderrPatterns` or `killOnStdoutPatterns` to include the auth patterns. Those are only set when `opts.resumeId || opts.sessionId` is truthy. So either:
   - The first call fails (expected; we had sessionId)
   - The retry also fails with the same error → retry would need to have session opts or kill patterns

4. **Pool wrapper behavior:** When the agent pool has retry/fallback config, it wraps the planner in `RetryFallbackWrapper`. On auth error with session, we changed the pool to **propagate** (throw) so the machine can run the full fix. Before that fix, the pool only retried when `opts?.resumeId`; with `sessionId` (create path) it would try fallback or throw. The pool cannot update workflow state, so it must not retry—the machine must handle it.

### Hypotheses (Pre-Sandbox Fix)

- **A:** Retry never runs (e.g. `saveState` throws, or we exit before retry)
- **B:** Retry runs but receives session opts from somewhere (pool, cached state, opts merge)
- **C:** Retry runs with correct opts but the CliAgent/sandbox has internal state that triggers "already in use" even without session (e.g. session storage lock)
- **D:** Pool fix not deployed; pool swallows or transforms the error before machine sees it
- **E (confirmed):** Sandbox kill race — retry starts before first process is dead

### Reviewer Findings (Summary)

1. **Sandbox kill race (high):** On fatal pattern match, sandbox rejected in ~8ms while child could run 2.5s more. Retry could start while first Claude still alive.
2. **Planning/CLI changes:** Mostly observability or redundant under current config (no planner fallback).
3. **Pool bug (medium):** Real but secondary; only special-cased `opts.resumeId`, not `opts.sessionId` for create path. Fix useful when fallback is enabled.

---

## Fixes Applied

### 1. Sandbox: Wait for Child Exit + SIGKILL Escalation (Primary Fix)

**File:** `src/host-sandbox.js`

On fatal pattern match: send SIGTERM, set `pendingFatalError`, start 2s escalation timer. Defer `settle` until `close`. If child doesn't exit in 2s, escalate to SIGKILL. If overall timeout fires while `pendingFatalError` is set, escalate to SIGKILL (don't settle with timeout). Ensures: (1) process is gone before retry, (2) fatal errors stay fatal when child ignores SIGTERM.

### 2. Pool: Propagate Auth Errors (Not Retry/Fallback)

**File:** `src/agents/pool.js`

On auth error with session opts, the pool now **throws** instead of retrying or trying fallback. This ensures the machine's catch block runs so it can call `clearAllSessionIdsAndDisable` and retry.

```javascript
if (isAuthError && (opts?.resumeId || opts?.sessionId)) {
  throw err;
}
```

### 3. Planning: Explicit Retry Opts (No Session, No Kill Patterns)

**File:** `src/machines/develop/planning.machine.js`

On retry, we explicitly pass:

- `sessionId: undefined`, `resumeId: undefined`
- `killOnStderrPatterns: []`, `killOnStdoutPatterns: []`

This ensures the retry cannot be killed by the "already in use" pattern even if opts are merged somewhere.

### 4. Diagnostic Logging

**File:** `src/machines/develop/planning.machine.js`

- `planning_auth_catch` — When any error is caught: `isAuthError`, `hadSessionOpts`, `errName`, `errCategory`
- `session_retry_no_session` — Before retry: `retryOptsKeys`, `hasSessionInRetry`
- `session_retry_done` — After retry: `exitCode`, `ok`

**File:** `src/agents/cli-agent.js`

- `cli_agent_execute_opts` — When agent runs with session or kill patterns: `hasSessionOpts`, `sessionId`, `resumeId`, `killPatternsCount` (logged to agent-specific file, e.g. `claude.jsonl`)

---

## Log Events Reference

| Event                    | File          | When                                      | Key Fields                                           |
|--------------------------|---------------|-------------------------------------------|------------------------------------------------------|
| `planning_auth_catch`    | develop.jsonl | Planning machine catches any execute error| `isAuthError`, `hadSessionOpts`, `errName`, `errCategory` |
| `session_auth_failed`    | develop.jsonl | Auth error with session opts; about to retry | `sessionId`, `wasCreating`                        |
| `session_retry_no_session` | develop.jsonl | Right before retry without session       | `retryOptsKeys`, `hasSessionInRetry`                |
| `session_retry_done`     | develop.jsonl | After retry completes                     | `exitCode`, `ok`                                    |
| `session_opts`           | develop.jsonl | When session opts are used                 | `sessionKey`, `hadSessionBefore`, `usingCreate`, `usingResume` |
| `cli_agent_execute_opts` | claude.jsonl  | CliAgent execute with session or patterns | `hasSessionOpts`, `sessionId`, `resumeId`, `killPatternsCount` |
| `machine_complete`       | develop.jsonl | Machine finishes                           | `status`, `error`, `durationMs`                     |
| `sandbox_fatal_match`    | claude.jsonl  | Fatal pattern matched in stdout/stderr     | `stream`, `pattern`, `category`, `pid`              |
| `sandbox_terminate_signal` | claude.jsonl | Signal sent to child                       | `pid`, `signal`, `reason`                           |
| `sandbox_fatal_escalate_sigkill` | claude.jsonl | Escalation timer fired (child ignored SIGTERM) | `pattern`, `category`, `pid`                   |
| `sandbox_process_close`  | claude.jsonl  | Child process exited (when kill patterns)  | `pid`, `exitCode`, `signal`, `pattern`, `category`, `elapsedMs` |

---

## How to Debug

1. **Run the workflow** and reproduce the failure.

2. **Check `develop.jsonl`** for the sequence:
   ```
   step3a_create_plan
   session_opts           (first call: usingCreate or usingResume)
   planning_auth_catch    (isAuthError, hadSessionOpts)
   session_auth_failed
   session_retry_no_session  (retryOptsKeys, hasSessionInRetry)
   session_retry_done     (exitCode, ok)
   machine_complete       (status: error)
   ```

3. **Check `.coder/logs/claude.jsonl`** (or planner agent log) for `cli_agent_execute_opts`:
   - First call: `hasSessionOpts: true`, `killPatternsCount > 0`
   - Retry call: `hasSessionOpts: false`, `killPatternsCount: 0` (expected)

4. **Interpret:**
   - No `session_retry_no_session` → retry never reached (saveState throw? or older code)
   - `session_retry_done` with `ok: false` → retry ran but failed (exitCode !== 0)
   - `session_retry_done` with `ok: true` then `machine_complete` error → requireExitZero or later step failed
   - `cli_agent_execute_opts` on retry with `hasSessionOpts: true` → opts are being merged/cached somewhere

5. **Sandbox lifecycle (definitive teardown timeline):** When kill patterns are used, `.coder/logs/claude.jsonl` (or planner agent log) will contain:
   - `sandbox_fatal_match` — when the fatal pattern matched
   - `sandbox_terminate_signal` — when SIGTERM/SIGKILL was sent (`reason`: fatal, fatal_escalate, timeout, hang, etc.)
   - `sandbox_fatal_escalate_sigkill` — when the 2s escalation fired (child ignored SIGTERM)
   - `sandbox_process_close` — when the child exited (`elapsedMs` = time from fatal match to close)

---

## Related Code Paths

- **Host sandbox (kill race fix):** `src/host-sandbox.js` (lines ~280–395) — `pendingFatalError`, defer settle until `close`
- **Planning machine:** `src/machines/develop/planning.machine.js` (lines ~262–330)
- **Pool RetryFallbackWrapper:** `src/agents/pool.js` (lines ~34–60)
- **CliAgent execute:** `src/agents/cli-agent.js` (lines ~291–335)
- **clearAllSessionIdsAndDisable:** `src/state/workflow-state.js`

---

## Test Coverage

- `test/planning-session-collision.test.js` — Mocks planner to throw auth error on first call, succeed on retry; verifies `sessionsDisabled`, `planningSessionId` cleared, `session_retry_no_session` path
- `test/session-helper.test.js` — `withSessionResume` auth retry without session
- `test/agents-retry.test.js` — Pool propagates auth errors (does not retry)

---

## Open Questions

1. Is the pool fix (propagate on auth) deployed on the environment where the failure occurs?
2. Does `saveState` ever throw in this flow (e.g. permission, lock)?
3. Are there multiple coder-mcp or claude processes sharing session storage?
4. Does the planner use a fallback agent; if so, does the fallback path bypass the machine's retry?
