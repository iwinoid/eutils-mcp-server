# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.0.1   | ✅        |

Only the latest release receives security fixes. If you are on an older
commit, upgrade first and confirm the issue still reproduces.

## Reporting a Vulnerability

Open an [issue](https://github.com/iwinoid/eutils-mcp-server/issues) with:

- The tool name and the arguments you passed.
- The full error text and the server version from `package.json`.
- Your Node.js version (`node --version`).

**Redact secrets before posting.** The server masks `api_key` in its own
output, but your shell history or host configuration file may still hold the
real key. Replace any key, token, or personal address with `***`. A report
that contains a live credential will be edited on sight, so rotate the key
first if one slipped in.

## Scope

In scope: this server's code — credential handling and redaction, the
redirect allowlist, XML hardening, input validation, and rate limiting.

Out of scope, please route elsewhere:

- NCBI behaviour or data bugs → <eutilities@ncbi.nlm.nih.gov>.
- Vulnerabilities in a dependency → that project's own tracker.
- The STRIDE-A working notes some releases were developed against. They are
  local analysis material, not part of any release, and are not tracked here.

## What to Expect

This is a single-maintainer project, so there is no fixed SLA. Every report
is read, reproduced against the latest release, and answered in the issue.
Fixes ship as ordinary releases; anything that changes tool behaviour or
output shape is noted in the release text.
