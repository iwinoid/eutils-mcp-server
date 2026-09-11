# Upstream Issues and Defect Record

Probed against live NCBI on 2026-09-11. Every claim here was measured, not read.

This file records four different kinds of problem, because they are easy to confuse:

| Kind                                               | Count | Fixed here?        |
| -------------------------------------------------- | ----- | ------------------ |
| Upstream defects we cannot fix                     | 1     | No. Mitigated.     |
| Undocumented upstream behaviour we had to discover | 4     | Documented here    |
| Errors in NCBI's published documentation           | 4     | No. Reported here. |
| Defects in this server, found and fixed            | 4     | Yes                |

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
server encodes all four.

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
