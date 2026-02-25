# Failure Mode Review

## Scope
This review focuses on failure modes that are not currently treated well and can stop or derail workflow execution across config loading, state persistence, agents, workflow machines, and external tool/service dependencies.

## Operating Decisions (Confirmed)
1. Missing `gh` for GitHub issue workflows is a **hard fail**.
2. Test executable failures are a **soft fail**; they should trigger a review round, not crash the workflow.
3. Workflow persistence is **required**.
4. Design workflows should **fail fast** when Stitch is unavailable.

## Findings (Ordered by Severity)

### 1) High: Invalid configuration can crash startup without controlled handling
- **Files:** `src/config.js` (around lines 381-393)
- **Failure mode:** `CoderConfigSchema.parse(...)` throws directly on malformed config.
- **Trigger examples:** invalid field types in `coder.json`.
- **Impact:** CLI/MCP startup can abort before workflows start.
- **Desired behavior:** Fail with a clear, user-facing configuration error (hard fail is acceptable), rather than an unstructured crash.

### 2) High: Required persistence path can crash workflow on filesystem write failure
- **Files:** `src/state/workflow-state.js` (around lines 45-92)
- **Failure mode:** synchronous `mkdirSync`/`writeFileSync` failures are not safely mediated.
- **Trigger examples:** read-only workspace, permission errors, ENOSPC.
- **Impact:** workflow halts during checkpoint/state writes.
- **Decision alignment:** Persistence is required, so failing is acceptable, but failure should be explicit and diagnostic-rich (not opaque).

### 3) High: Structured agent paths parse JSON even when execution already failed
- **Files:**
  - `src/agents/api-agent.js` (around lines 58-61)
  - `src/agents/cli-agent.js` (around lines 175-181)
  - `src/agents/mcp-agent.js` (around lines 182-188)
- **Failure mode:** structured parse is attempted unconditionally; non-JSON/empty output after failure causes parse exceptions.
- **Trigger examples:** API/network/auth/timeout failures.
- **Impact:** secondary parse crash can mask the primary cause and abort workflow steps.
- **Desired behavior:** preserve original execution failure context; parse only when safe.

### 4) High: Issue-list workflow can treat CLI failure as “no issues”
- **Files:** `src/machines/develop/issue-list.machine.js` (around lines 93-135 and 285-314)
- **Failure mode:** failed `gh`/`glab` calls can be interpreted as empty issue sets.
- **Trigger examples:** missing CLI binary, auth failure, network/API failure.
- **Impact:** workflow may continue incorrectly with zero issues and no meaningful work.
- **Decision alignment:** For GitHub issue workflows, this must be a hard fail.

### 5) High: Design workflow can advance then crash when Stitch is disabled/unavailable
- **Files:**
  - `src/machines/design/intent-capture.machine.js` (around lines 110-132)
  - `src/machines/design/ui-generation.machine.js` (around line 30)
  - `src/machines/design/_shared.js` (around lines 10-46)
- **Failure mode:** pipeline can continue after detecting Stitch unavailable, then fail later in generation.
- **Trigger examples:** default/disabled Stitch config.
- **Impact:** delayed failure and wasted workflow cycles.
- **Decision alignment:** fail fast at entry when Stitch is unavailable.

### 6) High: Missing `gitleaks` can hard-stop quality review
- **Files:** `src/ppcommit.js` (around lines 175-193)
- **Failure mode:** required external secret-scanning binary missing causes immediate throw.
- **Trigger examples:** missing `gitleaks`, PATH issues.
- **Impact:** quality-review/develop flow halts before downstream checks.
- **Note:** Depending on policy, this may be acceptable as a hard requirement, but failure should remain explicit and actionable.

### 7) Medium: Missing test executable can crash instead of producing reviewable failure result
- **Files:**
  - `src/test-runner.js` (around lines 27-38)
  - `src/helpers.js` (around lines 591-607)
- **Failure mode:** `spawnSync` ENOENT can surface as exception rather than structured test failure.
- **Trigger examples:** configured test command binary not installed.
- **Impact:** workflow can stop abruptly rather than enter a review/remediation round.
- **Decision alignment:** this should be soft fail with explicit review signal.

### 8) Medium: Agent name resolution is narrowly hard-coded
- **Files:**
  - `src/agents/cli-agent.js` (around lines 18-36)
  - `src/agents/pool.js` (around lines 262-269)
- **Failure mode:** config role overrides to unsupported names can throw early.
- **Trigger examples:** custom/new provider names.
- **Impact:** workflow start failure due to validation rigidity.

### 9) Medium: MCP HTTP tool calls have limited resilience controls
- **Files:** `src/agents/mcp-agent.js` (around lines 60-112)
- **Failure mode:** transient transport/service failures bubble up without robust recovery behavior.
- **Trigger examples:** intermittent network faults, upstream restart.
- **Impact:** MCP-dependent workflow steps can fail on transient conditions.

## Summary of Most Important Workflow-Stopping Risks
1. Config parse failures without clean startup diagnostics.
2. Required persistence write failures halting workflow execution.
3. Agent structured parse masking true failures.
4. GitHub issue discovery silently degrading to empty results instead of hard fail.
5. Design pipeline not failing early on Stitch unavailability.

## Recommended Priority
1. Enforce strict hard-fail semantics with explicit diagnostics for: config invalidity, missing `gh` in issue workflows, missing Stitch in design workflows, required persistence failures.
2. Convert test runner executable failures to structured soft-fail review outcomes.
3. Prevent secondary parse exceptions from obscuring primary agent failures.
