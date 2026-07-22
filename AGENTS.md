# Global Agent Instructions

- On Windows PowerShell tool calls, avoid loading user profiles by default. Prefer `login:false` for shell commands unless profile behavior is explicitly needed.
- Keep configuration variable names short and direct. Do not add backward-compatible aliases or fallback names unless explicitly requested.
- Features that create output artifacts, such as Excel report generation, should be controlled by CLI arguments instead of `.env` defaults.
- Webhook payload shape belongs in `HOOK_TMPL` or `HOOK_TMPL_FILE`. Do not add separate config keys for fields that should be part of the JSON template.
- `.env` files may use full-line comments for grouping and explanation. Keep actual config entries as simple `KEY=value` lines.
- Use `fastcontext` according to project size and uncertainty. For small projects or when the relevant file path is already obvious, prefer direct tools such as `rg`, `rg --files`, and file reads. For medium or large projects, unfamiliar codebases, or when ownership/file locations are unclear, use `fastcontext` first to gather codebase context, then verify with targeted file reads or `rg`.
