# Changelog

## 0.2.0 - 2026-11-02

### Fixed

- EFetch follows the manual's per-database defaults when rettype is omitted:
  PMC returns XML, PubMed returns abstract text, sequence databases return
  FASTA, and other databases get NCBI's native default instead of a validation
  error. Both workflow tools use the same resolver.
- ELink parses the responses of acheck, ncheck, lcheck, llinks, prlinks, and
  neighbor_score. Those commands previously reported zero links or dropped the
  UID and score fields.
- ELink applies command-specific rules: acheck no longer narrows itself with
  db=dbfrom, ncheck/lcheck/llinks/prlinks never send db, linkname is limited to
  neighbor and neighbor_history, term is limited to same-database commands,
  holding is limited to llinks, and idtype accepts only acc.
- ECitMatch sends rettype=xml, as the manual documents.
- EFetch and the workflow tools report rettype and retmode as "default" when no
  format parameter was sent.

### Changed

- Optional parameters added: eutils_esearch history and reldate; eutils_epost
  web_env; eutils_efetch strand, seq_start, seq_stop, and complexity;
  eutils_einfo version; eutils_elink term, holding, and idtype;
  eutils_link_then_fetch retmode. eutils_efetch also accepts retmode=asn.1 for
  text ASN.1; binary ASN.1 from sequence databases is rejected.
- eutils_esearch sort examples use the manual's PubMed values: pub_date,
  Author, JournalName, and relevance.
- README and README.zh state the EFetch format defaults, the ELink command
  coverage, the deliberate db-omitted same-database behavior, and the other
  deliberate differences from the manual.

### Documentation

- New audit/2026-11-02-manual-audit.md records the manual re-audit: P1/P2/P3
  findings, page and line references, and the fix mapping.
- docs/upstream-issues.md gains a 2026-11-02 section for the measured manual
  discrepancies and the ELink and EFetch defects fixed in this release.
- skills/using-eutils-mcp/SKILL.md no longer claims a direction for
  pubmed_pmc_refs; PMC full text uses the default XML or medline/text.

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
