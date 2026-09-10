# Changelog

## 2.0.0 — unreleased

- Replace the obsolete Express/request/async stack with Node built-ins; require Node 22+.
- Accept JSON GitLab pushes and legacy form payloads (#1).
- Require webhook authentication and branch selection; support GitHub, GitLab signing/token modes, and Bitbucket Cloud.
- Serialize work per checkout, bound the queue/body/commands, deduplicate delivery IDs, and drain on shutdown.
- Verify checkout branch and use fast-forward pulls. Add a side-effect-free API, declarations, meaningful tests and Actions.
- Replace the README with setup, provider, operational, and migration documentation.
- Remove implicit startup, internal privilege dropping, file logging, and webhook forwarding. See README before upgrading.

Release prerequisite: restore the full intended BSD license notice. The historical package metadata says only `BSD`, with no license text in the repository; no variant is assumed by this change.
