# Contributing

## Setup

```bash
git clone https://github.com/canesin/coder.git
cd coder
npm install
```

## Validation

```bash
npm run lint          # biome check
npm run format:check  # biome format
npm test              # node --test (162 tests)
npm audit --audit-level=high
```

Auto-fix formatting:

```bash
npm run lint:fix
```

## Commit hygiene

This project uses `ppcommit` (tree-sitter AST-based) to enforce commit quality:

```bash
coder ppcommit              # check all files
coder ppcommit --base main  # check branch diff only
```

## Pull request checklist

- Keep changes focused and scoped to one concern
- Add or update tests when behavior changes
- Update README.md if user-facing behavior or config changes
- Never commit secrets or local config (`.env`, `.mcp.json`, `.claude/settings.local.json`)
- Never commit local workflow artifacts (`ISSUE.md`, `PLAN.md`, `PLANREVIEW.md`, `REVIEW.md`)
