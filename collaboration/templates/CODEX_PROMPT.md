# Shared Codex Handoff Entry

This is a shared template for explicitly enrolled projects under <COLLAB_ROOT>.

Do not assume parent AGENTS.md files were auto-loaded.

For the target project, always use that project's local handoff entry first:

`node <PROJECT_ROOT>\work\handoffs\handoff.mjs context`

The context command must explicitly output and you must read all three:

1. `<COLLAB_ROOT>\AGENTS.md` — root collaboration rules
2. `<PROJECT_ROOT>\AGENTS.md` — project/business rules
3. `<PROJECT_ROOT>\work\handoffs\current.md` — this project's current task

Then run:

`node <PROJECT_ROOT>\work\handoffs\handoff.mjs status`

Only claim if the project is explicitly registered and the handoff is READY:

`node <PROJECT_ROOT>\work\handoffs\handoff.mjs claim`

For code tasks:
- work in the generated worktree
- diagnose from sufficient evidence before editing
- run targeted/regression/safety tests
- commit
- write the project's RESULT.md
- return through the local handoff entry

For non-code tasks:
- do not create a worktree merely for process compliance
- produce only the deliverables allowed by current.md
- record acceptance evidence
- write the project's RESULT.md
- return through the local handoff entry

Never use another project's current.md or RESULT.md.
