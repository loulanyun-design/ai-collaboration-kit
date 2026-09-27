# Collaboration Runner

The Runner validates explicit project enrollment, handoff state, hashes, locks, idempotency, allowlists, and result evidence before/after delegated execution.

It is intentionally separate from DevSpace. Codex execution is opt-in and should only be started after explicit user delegation.

Commands are exposed through `src/runner.mjs`; run `npm test` before changing workflow behavior.
