# Security

Do not commit credentials, OAuth tokens, API keys, private project data, runtime job snapshots, or production handoff files.

The local development MCP mode is loopback-only and may use no authentication. Never expose that mode directly to the Internet.

For remote access, require HTTPS and strong authentication. Preserve Runner-side validation of project registration, state, hashes, locks, idempotency, allowlists, and side-effect policy.

A successful technical task does not authorize merge, push, deployment, publication, external upload, final submit, or production writes.
