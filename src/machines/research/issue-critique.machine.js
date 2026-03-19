import { z } from "zod";
import { checkCancel, defineMachine } from "../_base.js";
import {
  appendScratchpad,
  loadPipeline,
  resolveArtifact,
  runStructuredStep,
} from "./_shared.js";

export default defineMachine({
  name: "research.issue_critique",
  description:
    "Standalone tool: review and score an issue backlog with structured critique. " +
    "Not part of the automated pipeline (issue_synthesis has its own built-in critique loop). " +
    "Auto-loads analysisBrief, webReferenceMap, validationResults from stepsDir.",

  inputSchema: z.object({
    issues: z.array(z.any()).min(1).describe("Issue drafts to critique"),
    repoRoot: z.string().min(1),
    analysisBrief: z.any().default({}),
    webReferenceMap: z.any().default({}),
    validationResults: z.any().default({}),
    priorFeedback: z
      .array(z.string())
      .default([])
      .describe("Feedback from previous iterations"),
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
  }),

  async execute(input, ctx) {
    const pipeline = loadPipeline(input.pipelinePath) || {
      version: 1,
      runId: "issue-critique",
      current: "init",
      history: [],
      steps: {},
    };
    const analysisBrief = resolveArtifact(
      input.analysisBrief,
      input.stepsDir,
      "analysis-brief",
    );
    const webReferenceMap = resolveArtifact(
      input.webReferenceMap,
      input.stepsDir,
      "web-references",
    );
    const validationResults = resolveArtifact(
      input.validationResults,
      input.stepsDir,
      "validation-results",
    );

    checkCancel(ctx);

    const asLines = (v) =>
      Array.isArray(v)
        ? v.map((x) => String(x || "").trim()).filter(Boolean)
        : [];

    const issuesSummary = input.issues
      .map((issue, i) => {
        const parts = [
          `### Issue ${i + 1}: ${issue.title || issue.id || `issue-${i}`}`,
          `- Priority: ${issue.priority || "P2"}`,
          `- Objective: ${(issue.objective || "").slice(0, 300)}`,
          `- Changes: ${(issue.changes || []).join(", ").slice(0, 300)}`,
          `- Dependencies: ${(issue.depends_on || []).join(", ") || "none"}`,
        ];
        const ac = asLines(issue.acceptance_criteria);
        if (ac.length > 0)
          parts.push(`- Acceptance criteria: ${ac.join("; ")}`);
        if (issue.verification)
          parts.push(
            `- Verification: ${String(issue.verification).slice(0, 200)}`,
          );
        const risks = asLines(issue.risks);
        if (risks.length > 0) parts.push(`- Risks: ${risks.join("; ")}`);
        const ts = issue.testing_strategy;
        if (ts) {
          const existing = asLines(ts.existing_tests);
          const newTests = asLines(ts.new_tests);
          if (existing.length > 0 || newTests.length > 0) {
            parts.push(
              `- Testing: ${existing.length} existing, ${newTests.length} new` +
                (ts.test_patterns
                  ? ` (${String(ts.test_patterns).slice(0, 100)})`
                  : ""),
            );
          }
        }
        const refs = Array.isArray(issue.references) ? issue.references : [];
        if (refs.length > 0)
          parts.push(
            `- References: ${refs.length} (${refs
              .map((r) => r.title || r.url || "")
              .join(", ")
              .slice(0, 200)})`,
          );
        return parts.join("\n");
      })
      .join("\n\n");

    const priorFeedbackSection =
      input.priorFeedback.length > 0
        ? `## Prior Feedback (address these)\n${input.priorFeedback.map((f) => `- ${f}`).join("\n")}`
        : "";

    const hasContent = (v) =>
      v != null && typeof v === "object" && Object.keys(v).length > 0;

    const briefSummary = hasContent(analysisBrief)
      ? JSON.stringify(analysisBrief).slice(0, 3000)
      : "";

    const refSummary = hasContent(webReferenceMap)
      ? JSON.stringify(webReferenceMap).slice(0, 2000)
      : "";

    const validationSummary = hasContent(validationResults)
      ? JSON.stringify(validationResults).slice(0, 2000)
      : "";

    const prompt = `You are a senior engineering reviewer. Critique this issue backlog for completeness, correctness, and actionability.

## Issue Backlog
${issuesSummary}

${priorFeedbackSection}

## Research Context
${briefSummary || "No analysis brief available."}

## Web References
${refSummary || "No web references available."}

## Validation Results
${validationSummary || "No validation data available."}

## Review Criteria
1. **Completeness**: Does each issue have clear scope, acceptance criteria, verification command?
2. **Dependencies**: Are dependency chains correct? Any circular dependencies?
3. **Sizing**: Are issues appropriately sized (not too large, not too small)?
4. **Overlap**: Do any issues duplicate work?
5. **Gaps**: Are there missing issues needed to achieve the overall goal?
6. **Actionability**: Can a developer pick up each issue and start working immediately?
7. **Risk**: Are high-risk items identified and mitigated?
8. **Testing**: Does each issue include a testing strategy with references to existing tests and concrete new tests to write?

Return JSON:
{
  "verdict": "approve" | "revise",
  "overallScore": 1-10,
  "issueReviews": [
    {
      "issueIndex": 0,
      "title": "issue title",
      "verdict": "approve" | "revise" | "drop" | "split",
      "score": 1-10,
      "strengths": ["strength1"],
      "weaknesses": ["weakness1"],
      "suggestions": ["suggestion1"],
      "missingFields": ["field1"]
    }
  ],
  "backlogIssues": {
    "circularDeps": ["description of any circular dependencies"],
    "gaps": ["missing issue descriptions"],
    "overlaps": ["overlapping issue pairs"],
    "orderSuggestions": ["reordering suggestions"]
  },
  "summary": "overall assessment",
  "feedback": ["actionable feedback items for next iteration"]
}`;

    const { payload, agentName } = await runStructuredStep({
      stepName: "issue_critique",
      role: "planReviewer",
      prompt,
      timeoutMs: ctx.config.workflow.timeouts.researchStep,
      stepsDir: input.stepsDir,
      scratchpadPath: input.scratchpadPath,
      pipeline,
      pipelinePath: input.pipelinePath,
      ctx,
    });

    appendScratchpad(input.scratchpadPath, "Issue Critique", [
      `- agent: ${agentName}`,
      `- verdict: ${payload?.verdict || "unknown"}`,
      `- score: ${payload?.overallScore || "unknown"}`,
      `- issues_reviewed: ${(payload?.issueReviews || []).length}`,
      `- gaps_found: ${(payload?.backlogIssues?.gaps || []).length}`,
    ]);

    return {
      status: "ok",
      data: {
        verdict: payload?.verdict || "revise",
        overallScore: payload?.overallScore || 0,
        issueReviews: payload?.issueReviews || [],
        backlogIssues: payload?.backlogIssues || {},
        summary: payload?.summary || "",
        feedback: payload?.feedback || [],
      },
    };
  },
});
