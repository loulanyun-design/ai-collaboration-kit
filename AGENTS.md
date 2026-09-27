# AI Collaboration Kit — Root Rules

ChatGPT owns orchestration and business acceptance. DevSpace is an optional local file/command transport. Runner/Codex executes only when the user explicitly delegates. A Jev-style classifier may decide whether an already-authorized flow can continue, but it never grants new permissions.

Only projects explicitly listed in `collaboration/projects.json` with `enabled=true` participate.

State machine: `DRAFT -> READY -> IN_PROGRESS -> REVIEW / BLOCKED -> DONE`.

Each handoff must explicitly declare independent side-effect gates: `allow_real_system_write`, `allow_bulk_write`, `allow_final_submit`, `allow_git_push`, and `allow_external_upload`. Default all to false.

Code tasks use an isolated worktree, explicit code allowlist, targeted tests, and a separate commit. Codex must not merge or push by itself. Non-code tasks use explicit deliverables and acceptance evidence.

Do not invoke Runner/Codex unless the user explicitly asked to delegate. Do not recursively delegate. Technical REVIEW is not business DONE.
