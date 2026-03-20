# Plan: Fix Gemini issue-list failures (envelope fallback + fragile inner JSON)

## Review notes (amendments)

Cross-check with the codebase confirms the diagnosis: **`extractGeminiPayloadJson`** silently **`return parsed`** (the CLI envelope) when inner `extractJson(parsed.response)` fails — that drives the misleading Zod errors in **`issue-list.machine.js`**. The **dominant fix is P0** (fail-fast, no envelope return). **`extractJson`** already applies **fence stripping** and **`jsonrepair`** (`src/helpers.js` ~339+), so **P1 is not** the main gap. **`recommended_index`** clamping (**P2**) is **defensive only**: the develop loop queue builder uses **`issues`** and does **not** currently use **`recommended_index`** to select or order work (`src/workflows/develop.workflow.js` ~780) — it was **not** part of the observed failure. **P3** duplicates intent already in the issue-list prompt (**“Return ONLY valid JSON”**). **Tests:** `test/helpers.test.js` ~283 covers the **happy** fenced path; a **mandatory** regression for the **bad** path (inner parse fails → **must not** return envelope) is still missing.

---

## Problem

Develop workflow fails at **`develop.issue_list`** when **`issueSelector`** is **`gemini`**, even with **exit code 0**. Observed symptoms:

- **`workflow-state` / SQLite** show Zod errors like: **`issues` expected array, received `undefined`**; **`recommended_index` expected number, received `undefined`**.
- **`gemini.jsonl`** shows **`gemini --yolo -o json`** returning a **CLI envelope**: `{ "session_id", "response", "stats" }`, where **`response`** is a **string** that often contains **markdown-fenced JSON** (` ```json ... ``` `) with **large, sometimes malformed** inner JSON (inconsistent escaping after long generations).

The outer assistant may misdiagnose this as “coder cannot parse markdown” — **incorrect**. **`extractJson`** already handles fences for **plain** stdout. The real bug is the **Gemini envelope path** in **`extractGeminiPayloadJson`**.

## Root cause (code)

**File:** `src/helpers.js` — **`extractGeminiPayloadJson`**

1. **`extractJson(stdout)`** parses the **outer** envelope successfully.
2. Code attempts **`extractJson(parsed.response)`** on the inner string (fenced JSON).
3. If that **throws** (and the **`\\n` normalization** retry also throws), the **`catch`** blocks **swallow** the error and execution **falls through**.
4. The function **`return parsed`** — i.e. the **full envelope** `{ session_id, response, stats }`, **not** `{ issues, recommended_index }`.
5. **`parseAgentPayload`** → **`IssuesPayloadSchema.parse`** in **`issue-list.machine.js`** then runs on the envelope → **confusing Zod** “undefined” errors instead of a **single clear** “inner payload parse failed” message.

Secondary (same incident class, not the primary bug):

- **Oversized / corrupted inner JSON** when many issues are listed (model output quality).

## Goals

1. **Never** pass the Gemini **envelope** through to **`IssuesPayloadSchema`** as if it were an issues payload.
2. On inner parse failure, surface a **diagnostic error** (short **preview** of `response`; stable message prefix for grep/logs).
3. **Tests:** happy path stays covered; **mandatory** regression when inner parse fails (**no** silent envelope return).

## Non-goals (for this plan)

- Replacing Gemini CLI or banning MCP globally (environment / user config).
- Full “real **`runDevelopLoop`**” E2E in CI (keep focused unit/integration tests).

---

## Proposed work items

### P0 — Primary fix: no silent envelope return

**Change `extractGeminiPayloadJson`** (`src/helpers.js`):

- When the outer object has **`typeof parsed.response === "string"`** and **inner `extractJson` fails** (both the direct attempt and the **`\\n` normalization** retry), **throw** a **`Error`** with a **stable message prefix** (e.g. **`[coder] Gemini -o json: could not parse issues payload from envelope response`**) followed by a **short preview** (~200–400 chars) of `parsed.response`. Optionally set **`error.cause`** to the last inner error. **Avoid a custom error class** unless a caller must **`instanceof`** — this repo mostly uses plain **`Error`**.
- **Do not** `return parsed` in that branch.

**Optional refinement:** If **`response`** is missing but the outer object **looks like** an envelope (e.g. **`session_id`** + **`stats`**), avoid returning it as the issues payload — throw with a similar prefix.

**Downstream:** **`issue-list.machine.js`** surfaces thrown errors via **`defineMachine`** → failed run; message becomes **actionable** for operators.

### P4 — Tests (**mandatory** for the bad path)

**Extend `test/helpers.test.js`** (or adjacent helpers tests):

1. **Happy path** — already covered ~283: envelope + valid fenced **`response`** → **`extractGeminiPayloadJson`** returns **`{ issues, recommended_index }`** (keep passing).
2. **Regression (required):** envelope + **`response`** that is **garbage / truncated / unrecoverable JSON** → **throws** (message includes stable prefix); return value is **not** the envelope object (e.g. assert thrown, or if wrapped, assert result lacks **`session_id`** + has **`issues`** — prefer **throw** assertion).
3. Optional: trimmed **fixture** from real **`gemini.jsonl`** (redacted) — **only if** it stabilizes the regression without flaking.

**Integration test** for **`parseAgentPayload("gemini", stdout)`** + schema: optional, not required if P4 unit tests cover **`extractGeminiPayloadJson`** directly.

### P1 — Inner extraction hardening (**only if proven**)

**`extractJson`** already strips fences and runs **`jsonrepair`**. **Do not** duplicate fence logic by default. Add extra normalization / repair **only if** a **concrete failing fixture** from P4 shows it helps **without** breaking happy paths.

### P2 — **`recommended_index` clamp (**secondary**)

**Lower priority than P0/P4.** The develop queue does not use **`recommended_index`** for ordering today; this is **defensive** for future use and bad LLM indices. Implement **after** P0/P4 if still desired: clamp to **`[0, issues.length - 1]`** after successful parse (with a one-line comment).

### P3 — Prompt nudge (**lowest**)

**`TAIL`** already says **“Return ONLY valid JSON”**. A Gemini-only line is **optional** and low ROI; only add if product wants explicit “no tools / no files” language — **after** P0/P4.

### P5 — Logging

Prefer **rich `Error.message`** only; avoid **`process.stderr.write`** unless consistent with nearby patterns.

---

## Suggested implementation order

1. **P0** + **P4** (including **mandatory** inner-parse-failure regression).  
2. **P1** only if a fixture proves missing behavior (unlikely given current **`extractJson`**).  
3. **P2** / **P3** as optional hardening after the above.

---

## References

- **`extractGeminiPayloadJson`:** `src/helpers.js` (~384–409)  
- **`extractJson` (fences + `jsonrepair`):** `src/helpers.js` (~339+)  
- **`parseAgentPayload`:** `src/machines/develop/_shared.js` (~155–159)  
- **`IssuesPayloadSchema`:** `src/schemas.js` (~13–16)  
- **Issue list parse path:** `src/machines/develop/issue-list.machine.js` (~524–536)  
- **Queue build (issues only):** `src/workflows/develop.workflow.js` (~780)  
- **Happy-path test:** `test/helpers.test.js` (~283)  
- **`geminiJsonPipeWithModel` / structured mode:** `src/agents/cli-agent.js` (~266–270, ~432–437)

---

## Success criteria

- Failed Gemini issue selection **never** produces Zod **“issues undefined”** on the **envelope**; operators see an **explicit** inner-parse failure (**stable prefix** + preview).  
- Valid fenced JSON inside **`response`** still parses (**existing** happy test still passes).  
- **Mandatory** regression test prevents **silent envelope return**.  
- **P2/P3** treated as optional follow-ups, not part of the core incident fix.
