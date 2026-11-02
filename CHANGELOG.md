# Changelog

## 0.1.1 - 2026-11-02

### Fixed

- ESummary History paging now marks a full page as having more and returns a
  real next offset instead of treating the page size as the set total.
- EFetch keeps head and tail for a single oversized record fetched through
  History with retmax=1, not only for an explicit single UID.
- structuredContent is reduced to the same response budget as the text block,
  and JSON output remains valid JSON after truncation.
- ELink now sends db=dbfrom when db is omitted, matching the documented
  same-database behavior.
- EGQuery fallback separates failed databases from databases with no matches,
  and fails the call when every fallback database fails.
- link_then_fetch reports source_total for explicit UIDs, distinguishes
  requested from retrieved counts, and prefers the canonical dbfrom_dbto link.
- ECitMatch maps replies by citation key when NCBI omits a line.
- Input ceilings: 2,000 UIDs per call, 200 citations per call, and 1,000
  characters per citation.
- MCP cancellation now reaches the rate limiter, retry backoff, redirects, and
  fetch; an aborted request stops instead of consuming more NCBI quota.
- EGQuery fallback uses a 5-second per-database timeout with no retries, and
  stops when the MCP call is cancelled.

### Changed

- MCP annotations now mark History-creating tools as read-only false and
  idempotent false; pure readers keep the read-only/idempotent hints.
- The protocol smoke test is offline by default; live NCBI checks moved behind
  --live.
- npm scripts that talk to NCBI load .env explicitly.
- Node.js requirement is now 22.9 or newer, matching the SDK and the
  --env-file-if-exists flag.
- Runtime dependencies: @modelcontextprotocol/server 2.4.0 and zod 4.6.7.
- The lockfile uses registry.npmjs.org.
- Internal identifiers use EUtils-style acronyms and a typed map for the exact
  NCBI wire parameter names.

### Documentation

- README, README.zh, CONTRIBUTING, SECURITY, docs/upstream-issues, and the
  using-eutils-mcp skill now match the code for truncation, fencing,
  annotations, Node version, and coverage.
