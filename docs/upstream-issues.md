# Upstream Issues and Defect Record

Probed against live NCBI on 2026-09-11, and re-audited against the E-utilities manual on 2026-11-02. Every claim here was measured, not read.

This file records four different kinds of problem (twenty claims in total), because they are easy to confuse:

| Kind                                               | Count | Fixed here?        |
| -------------------------------------------------- | ----- | ------------------ |
| Upstream defects we cannot fix                     | 1     | No. Mitigated.     |
| Undocumented upstream behaviour we had to discover | 5     | Documented here    |
| Errors in NCBI's published documentation           | 8     | No. Reported here. |
| Defects in this server, found and fixed            | 6     | Yes                |

Fourteen claims were measured on 2026-09-11 (sections 1-4). The other six were measured on 2026-11-02 (section 5).

---

## 1. Unfixable upstream defect

### EGQuery is unreachable

`egquery.fcgi` answers every request with HTTP 301 to
`ext-http-eutils.linkerd.ncbi.nlm.nih.gov`, an internal Kubernetes service-mesh
hostname. That name is not published in public DNS.

**Evidence.**

| Test                                                             | Result                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Cloudflare DoH, type A                                           | NXDOMAIN, DNSSEC validated                                 |
| Google DoH, type A                                               | NXDOMAIN                                                   |
| Control: `eutils.ncbi.nlm.nih.gov`                               | resolves to 34.107.134.59                                  |
| GET, POST, with and without `retmode`, `retmax`, `tool`, `email` | 301 every time                                             |
| Browser User-Agent, HTTP/1.0                                     | 301 every time                                             |
| Valid API key                                                    | still 301, while `esearch` returns 200 in the same session |
| Invalid API key                                                  | `400 API key invalid`                                      |

The invalid-key result is the decisive one. It shows NCBI validates credentials
**before** it routes the request, so the redirect is not a credentials or
rate-limit decision. The endpoint is simply unreachable for public clients.

**Impact.** No global cross-database count. EGQuery is the "which database holds
this?" tool, so that question loses its one-call answer.

**Mitigation.** `eutils_egquery` tries the real endpoint first. Only a network
failure starts the fallback, which counts matches with ESearch over 12 commonly
used databases. The result carries `degraded: true` and a reason. Validation
errors never trigger the fallback, so a bad query cannot cost 12 extra requests.

**Do not** record this as a permanent fact. It depends on NCBI's routing.

**How to re-check.**

```console
npm run doctor
```

The doctor probe reports the current state in one command. If NCBI repairs the
route, the real EGQuery returns and no code changes.

---

## 2. Undocumented upstream behaviour

These are not defects. They are behaviours absent from NCBI's documentation. The
server encodes the four recorded in this section.

### ESummary caps JSON at 500 UIDs, not 10,000

The documentation states a 10,000 limit. That limit applies to XML only.

| Request                        | Result                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| POST, 501 UIDs, `retmode=json` | `{"error":"Too many UIDs in request. Maximum number of UIDs is 500 for JSON"}` |
| POST, 501 UIDs, `retmode=xml`  | 200, 1.19 MB                                                                   |

`BATCH_SIZE = 500` in `src/constants.ts` comes from this measurement, not from
the manual.

### JSON support is not uniform

| Endpoint                                | `retmode=json`                            |
| --------------------------------------- | ----------------------------------------- |
| `esearch`, `esummary`, `elink`, `einfo` | works                                     |
| `efetch`                                | no. Plain text works: `abstract`, `fasta` |
| `egquery`                               | no                                        |
| `espell`                                | no. Returns HTTP 500 when asked for JSON  |
| `epost`                                 | no. Returns HTTP 500 when asked for JSON  |
| `ecitmatch`                             | no. Returns pipe-delimited text           |

The client picks the format per endpoint. No tool passes `retmode=json` to an
endpoint that rejects it.

### Legacy sequence database names

`nucest` and `nucgss` still answer, but they are silently aliased to `nuccore`.
Both return an identical count for the same query. `popset` is gone and returns
`Invalid db name specified`.

`SEQUENCE_DATABASES` in `src/constants.ts` lists only names present in the live
EInfo allowlist.

### ECitMatch returns line feeds and pipe text

Citations are sent joined by carriage return. NCBI returns them joined by line
feed. The response is pipe-delimited text even though `retmode=xml` is
documented as the only supported value.

`parseEcitmatch` accepts `\r\n`, `\r`, and `\n`.

---

## 3. Errors in NCBI's published documentation

Measured against the E-utilities manual edition dated 2026-09-08.

| Claim                                                                                | Reality                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| "a set of **eight** server-side programs" (front matter)                             | nine. Chapter 2 says nine. The manual contradicts itself. |
| Table 1 lists `homologene`, `popset`, `probe`, `toolkit` as E-utility database names | all four return `Invalid db name specified`               |
| "records in the nuccore, nucest, nucgss, **popset**, and protein databases"          | `popset` is gone                                          |
| ESummary limit is 10,000                                                             | true for XML only. JSON caps at 500                       |
| Chapter 4 release notes                                                              | newest entry is 2015-06-24, eleven years stale            |

The JSON support matrix in section 2 does not appear anywhere in the manual.

**Consequence.** A guide distilled from this manual inherits every one of these
errors. The manual is a reliable description of mechanism, parameters, and
policy. It is not a reliable source for the database list, the release history,
or per-format limits.

---

## 4. Defects in this server, found and fixed

Recorded because each one reveals a test that was missing.

### ELink always returned zero links

`requireSection` already returns the `linksets` array. The code then indexed it
again as `root['linksets']`, which is `undefined`. `asArray(undefined)` yields
`[]`, so the tool reported zero links with no error.

Silent wrong answers are worse than crashes. Fixed, and `test/parse.test.ts` now
asserts that `linksets` is an array at the top level.

### History validation was never called

`validateHistory` existed and had unit tests, but no caller invoked it. A
malformed `web_env` travelled to NCBI untouched, so History-field validation was
documentation rather than code.

Fixed by routing `resolveSource` through `validateHistory`, and `test/common.test.ts`
now covers the tool layer that was previously untested.

### ECitMatch separator assumption

The parser split on `\r?\n` only. Fixed to accept `\r`, `\n`, and `\r\n`.

### Dead names in the sequence database list

`nucest`, `nucgss`, and `popset` were listed as FASTA-capable. None is
addressable. Found by `npm run refresh:databases`.

---

## 5. Manual re-audit, 2026-11-02

Re-checked the E-utilities manual (edition 2026-09-08, 206 pages) against the live API, tool by tool. Sections compared: EInfo, ESearch, EPost, ESummary, EFetch (including Table 1), ELink, EGQuery, ESpell, and ECitMatch. No manual body text is copied here. Locations are given as a page and as a line in the local extracted text; the page form is PDF page / printed page.

Six claims were added in this round: three errors in the manual, one undocumented behaviour, and two server defects that were fixed in 0.2.0.

### 5.1 Errors in the published manual (3)

| Claim and manual location                                                    | Reality on 2026-11-02                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESummary `retstart` defaults to 1 (p52/46)                                   | It is 0-based. `retstart=0` returns the first DocSum, 1 the second, 2 the third. EFetch documents `retstart` as defaulting to 0 (p58/52), so the manual contradicts itself. The server passes `retstart` explicitly and keeps the 0-based behavior. |
| ELink lists `llinkslib` in the `cmd` values (p62/56)                         | Live returns `Exception: llinkslib command not supported`, even with `holding=CTgov`. The command stays out of the tool's enum.                                                                                                                     |
| ECitMatch requires `rettype`, and `xml` is the only supported value (p66/60) | `retmode=xml` alone returns 200, so `rettype` is not required. The manual's own example sends `retmode` and no `rettype`. The client now sends `rettype=xml` as well, for alignment, but does not depend on it.                                     |

### 5.2 Undocumented upstream behaviour (1)

#### EFetch accepts and ignores `rettype=full` for PMC

Table 1 lists only the default XML and MEDLINE for `db=pmc` (p56/50). A request that adds `rettype=full` returns 200 and the default XML; the value is ignored, not rejected. Do not promise `rettype=full` for PMC. The default XML is what `eutils_efetch` sends when `rettype` is omitted.

### 5.3 Defects in this server, found and fixed (2)

#### ELink display commands returned zero results

For `cmd=acheck` the response carries `idchecklist.idlinksets[].linkinfos[]`. One protein UID returned 28 link names across 18 target databases; adding `db=protein` reduced that to 4 names across 2 databases. For `lcheck` and `ncheck` the response carries `linksets[0].idchecklist.ids[]` with `haslinkout` and `hasneighbor` flags. For `llinks` and `prlinks` it carries `linksets[0].idurllist[].objurls[]`. For `neighbor_score`, `linksetdbs[].links[]` entries are `{id, score}` objects, not strings.

The parser only read `linksetdbs` and `linksetdbhistories`, so all of these commands reported zero links. `acheck` was also narrowed by an unconditional `db=dbfrom`. Fixed in 0.2.0: command-specific request policy and parsers for `available_links`, `link_checks`, `provider_links`, and `scores`. `acheck` now omits `db` when the caller omits it, and an explicit `db` acts only as a filter.

#### EFetch refused databases without a hard-coded default format

Before 0.2.0 the server defined defaults only for PubMed (abstract/text) and the sequence databases (FASTA/text) and threw for every other database. Table 1 says an omitted `rettype` returns that database's default: PMC returned the default XML (75,348 bytes for one record) and gene returned ASN.1 text (665,431 bytes for one record).

Fixed in 0.2.0: a format resolver chooses the request for each database. With no `rettype`, PubMed returns abstract/text, sequence databases return FASTA/text, and every other database sends no format parameters so NCBI returns its native default. With `retmode=text` and no `rettype`, PMC becomes MEDLINE/text. Both workflows use the same resolver.

### 5.4 Deliberate differences from the manual

These are choices, not defects. The README documents them under the API section.

- **ELink without `db`.** The manual assigns `pubmed` to an omitted `db` (p61/55). This server sends `db=dbfrom` for `neighbor`, `neighbor_score`, and `neighbor_history`, so "omit db" means same-database neighbors. `acheck` omits `db` instead of supplying one.
- **`db` is required.** ESearch, EPost, and ESpell require `db`; ELink requires `dbfrom`; ESummary and EFetch accept an omitted `db` only when a History handle carries it. The manual defaults these to `pubmed`.
- **`usehistory` defaults to true.** The manual treats it as opt-in.
- **`retmax` ceilings.** ESearch accepts up to 10,000. ESummary and EFetch accept up to 500 per call and split larger UID lists internally; the manual allows 10,000 for EFetch.
- **`llinkslib` and `retmode=ref` are not exposed.** The first is unsupported live; the second redirects the client to a non-NCBI host.
- **`asn.1` is text-only.** The manual lists `asn.1` as a valid `retmode` for EFetch, but `protein`, `nuccore`, and `nucleotide` return binary ASN.1, which the text response path cannot carry. The server rejects that combination; the text ASN.1 returned by gene, homologene, and snp works.
