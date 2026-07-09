# Security Policy

Thanks for helping keep noddle draw and its users safe.

## Supported versions

noddle draw ships from `main` as a single rolling release — there are no
long-term support branches. Security fixes land on `main` and deploy to
draw.noddle.dev; self-hosters should track the latest `main`.

| Version | Supported |
|---|---|
| Latest `main` | ✅ |
| Older commits / forks | ❌ (please update) |

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem** —
that discloses it before a fix is available.

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of
   [noddle-dev/noddle-draw](https://github.com/noddle-dev/noddle-draw/security).
2. Click **Report a vulnerability** and fill in the advisory form.

This opens a private channel with the maintainers. If private reporting is
unavailable to you, open a public issue that says only "security report —
please enable a private channel" (no details) and we will follow up.

Please include:

- a description of the issue and its impact;
- steps to reproduce (a minimal board JSON export or request is ideal);
- affected URL/commit and, if relevant, browser/OS;
- any proof-of-concept, logs, or screenshots.

## What to expect

This is a small open-source project, so responses are best-effort:

- acknowledgement of your report, typically within a few days;
- an initial assessment and, where confirmed, a fix on `main` as soon as we
  reasonably can;
- credit in the advisory if you'd like it.

Please give us a reasonable window to ship a fix before any public disclosure.

## Scope & threat model

noddle draw is **anonymous by design** — there are no accounts, and a board's
URL is its access capability (anyone with the link can view and edit it, the
same model as Excalidraw share links). Keep the following in mind when judging
what is a vulnerability:

**In scope**

- ways to read or modify a board **without** its URL (e.g. enumerating board
  ids, listing boards, IDOR beyond the capability-link model);
- SVG sanitizer bypasses — stored/generated SVG that executes script or
  smuggles active content past `backend/app/security/svg_sanitizer.py`;
- XSS, SSRF, or injection in the API, collaboration WebSocket, or SPA;
- leakage of a **BYOK AI key** by the server (it must never be stored or
  logged — see the AI-route rules in `CLAUDE.md`);
- iframe/framing issues (only `/embed/{id}` is meant to be embeddable).

**Out of scope (by design, not bugs)**

- anyone with a board link can view/edit it — that is the sharing model;
- there is no per-board password, owner, or deletion endpoint;
- collaboration rooms are in-memory single-instance (do not scale replicas);
- issues that require a self-hoster to misconfigure their own deployment.

## Self-hosting notes

If you deploy noddle draw yourself:

- serve it over HTTPS — BYOK keys transit as request headers;
- set `NODDLE_ALLOWED_ORIGINS` tightly (production is same-origin);
- if you enable the free AI pool (`OPENROUTER_POOL_KEY`), keep the per-IP
  limits, `POOL_DAILY_BUDGET`, and Cloudflare Turnstile guards on;
- keep dependencies current.
