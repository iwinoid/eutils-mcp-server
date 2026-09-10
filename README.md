# eutils-mcp-server

[中文](README.zh.md) · English

An MCP server that gives an LLM the nine NCBI Entrez Programming Utilities (E-utilities) as tools.

NCBI documents the underlying API in the [E-utilities manual](https://www.ncbi.nlm.nih.gov/books/NBK25501/).

## Fits / does not fit

Use this server to let a model search and read biomedical data. It covers literature, sequences, genes, structures, and taxonomy, and it moves between those databases.

Use it when you want an answer, not a dataset. A question like "find papers about CRISPR delivery in 2024 and show me the abstracts" is the intended shape.

Do not use it for bulk download. If you need millions of records, download a local copy of [PubMed](https://www.nlm.nih.gov/databases/download/pubmed_medline.html) instead. This server obeys NCBI's rate limit, so a large job takes days.

Do not use it to change anything. It is read-only, and NCBI exposes no write path through these utilities.

## Install

```console
npm install
npm run build
```

Node.js 18 or newer.

## Configure

Every variable is optional. NCBI asks automated clients to identify themselves, and an API key raises the rate limit.

| Variable | Default | Purpose |
|---|---|---|
| `NCBI_API_KEY` | unset | Raises the ceiling from 3 to 10 requests per second. Get one from the Settings page of your [NCBI account](https://www.ncbi.nlm.nih.gov/account/). |
| `NCBI_EMAIL` | unset | Contact address sent with every request. NCBI uses it to warn you before an IP block. |
| `NCBI_TOOL` | `eutils-mcp-server` | Name that identifies this software in the NCBI logs. |

Supply the values in the `env` block of your MCP host config. Or keep them in a `.env` file at the project root, and launch the server with `--env-file-if-exists`:

```console
node --env-file-if-exists=.env dist/index.js
```

`npm start` and `npm run dev` pass that flag for you. When the file is absent, Node prints `not found. Continuing without it.` and the launch continues, so a missing `.env` cannot break startup. The path resolves against the working directory. Give an absolute path when your host launches the server from elsewhere.

`.gitignore` excludes `.env`. It does not exclude a host config file. Check that file before you commit it.

Set `NCBI_EMAIL` and `NCBI_TOOL`, then register both with NCBI by mail to <eutilities@ncbi.nlm.nih.gov>. A request that carries the values without prior registration does not satisfy the NCBI usage policy.

Subscribe to the Entrez Utilities announcement list at the same address. It is the only NCBI channel that reports known bugs. The [NCBI Insights blog](https://ncbiinsights.ncbi.nlm.nih.gov/tag/e-utilities/) reports planned changes only, and the release notes inside the [E-utilities manual](https://www.ncbi.nlm.nih.gov/books/NBK25501/) stop at 2015.

### Client configuration

Add this to your MCP host config, for example `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eutils": {
      "command": "node",
      "args": ["/absolute/path/to/E-utilities/dist/index.js"],
      "env": {
        "NCBI_API_KEY": "your-key",
        "NCBI_EMAIL": "you@example.com",
        "NCBI_TOOL": "eutils-mcp-server"
      }
    }
  }
}
```

To keep the key out of the host config, read it from `.env` instead:

```json
{
  "mcpServers": {
    "entrez": {
      "command": "node",
      "args": ["--env-file-if-exists=/absolute/path/to/E-utilities/.env", "/absolute/path/to/E-utilities/dist/index.js"]
    }
  }
}
```

## Quick start

Ask the server for the papers that match a query:

```console
npm run call eutils_esearch '{"db":"pubmed","term":"CRISPR delivery AND 2024[pdat]","retmax":3}'
```

The server answers with a count, a UID list, the translated query, and a History handle:

```text
# ESearch: `CRISPR delivery AND 2024[pdat]`

Database **pubmed** matched **412** records. Showing 3 starting at 0.

## UIDs

40123456, 40123457, 40123458

## History handle

{"db":"pubmed","web_env":"MCID_6aa2...","query_key":"1"}
```

The count changes as PubMed grows. Confirm that you see a count and three UIDs.

To drive it from a model instead, run the server and let the host call the tools.

## Tools

Eleven tools. Every tool takes `response_format` of `"markdown"` or `"json"`, and defaults to markdown. Every tool reports `readOnlyHint: true` and `destructiveHint: false`.

| Tool | Purpose |
|---|---|
| `eutils_einfo` | List databases, or describe one database: searchable fields, links, record count |
| `eutils_esearch` | Search a database. Returns UIDs and a History handle |
| `eutils_epost` | Upload a UID list to the NCBI History server |
| `eutils_esummary` | Compact summaries for a UID set: title, authors, journal, date |
| `eutils_efetch` | Full records: PubMed abstracts, FASTA sequences, other formats |
| `eutils_elink` | Follow links between databases, for example pubmed to pmc, or gene to protein |
| `eutils_egquery` | Count matches across many databases at once |
| `eutils_espell` | Spelling suggestion for a query |
| `eutils_ecitmatch` | Resolve formatted citations to PMIDs |
| `eutils_search_then_fetch` | Search and download in one call |
| `eutils_link_then_fetch` | Follow links and download the target records in one call |

### Working with large result sets

The server keeps no state. The History handle travels as an ordinary value, so you pass it back unchanged.

```text
eutils_esearch(db="pubmed", term="...", retmax=0, usehistory=true)
  -> { total: 16896, history: { db, web_env, query_key } }

eutils_efetch(history={...}, retstart=0,   retmax=500)
eutils_efetch(history={...}, retstart=500, retmax=500)
```

## Rate limits

NCBI blocks an IP that exceeds its limit. All requests, including internal batches, pass through one token bucket.

- 3 requests per second without an API key
- 10 requests per second with one

NCBI asks that large jobs run at a weekend. On a weekday, run them between 21:00 and 05:00 US Eastern time.

## Limits

- **Entrez only.** The server reads what Entrez indexes. Data that lives outside Entrez is not reachable.
- **`retmax` ceilings.** `eutils_esearch` accepts up to 10,000. `eutils_esummary` and `eutils_efetch` accept up to 500 per call. A larger UID list is split into batches of 500, and the response reports `batches`.
- **PubMed and PMC caps.** ESearch reaches only the first 10,000 records of a PubMed or PMC result set. Add date filters to segment a larger set.
- **Truncation.** The server cuts a response over 25,000 characters. The message says how to page or narrow the query.
- **Response ceiling.** The client abandons a response body over 5 MB.
- **stdio only.** No HTTP transport. To add one, bind `127.0.0.1` and validate the `Origin` and `Host` headers.
- **EGQuery coverage.** EGQuery itself is unreachable, so `eutils_egquery` covers 12 databases instead of 38. See below.

## Known upstream issue: EGQuery

NCBI's `egquery.fcgi` answers with an HTTP 301 to `ext-http-eutils.linkerd.ncbi.nlm.nih.gov`. That host is not published in public DNS.

Two independent DNSSEC-validating resolvers, Cloudflare and Google, both return NXDOMAIN for the name. A control query for `eutils.ncbi.nlm.nih.gov` resolves normally.

Every parameter combination tried redirects: GET and POST, with and without `retmode`, `retmax`, `tool`, `email`, a browser User-Agent, and HTTP/1.0.

An API key does not help. With a valid key, `esearch` returns 200 while `egquery` still returns 301 in the same session. A syntactically invalid key makes `egquery` return `400 API key invalid` instead. That result shows NCBI validates the key before it routes the request. The redirect is therefore not a credentials or rate-limit decision.

Run `npm run doctor` to reproduce the finding on your own network. The full evidence chain, and the other upstream defects found while building this server, are in [docs/upstream-issues.md](docs/upstream-issues.md).

### What the server does

`eutils_egquery` tries the real EGQuery first. Only a network failure starts the fallback, and then the server counts matches with ESearch over 12 commonly used databases. The result carries a marker:

```json
{ "degraded": true, "degraded_reason": "...", "databases_searched": 12 }
```

Read `degraded: true` as "this covers a subset, not all 38 databases". A validation error never starts the fallback, so a bad query cannot cost 12 extra requests.

The fallback is lazy. If NCBI repairs the endpoint, the real EGQuery returns and no code changes.

## Security

| Threat | Control |
|---|---|
| Prompt injection carried by record text | The server fences NCBI record text between `<<<EXTERNAL_NCBI_DATA` markers and labels it as data. It strips fence markers from the content, so the content cannot close the fence early. The server never writes, so it cannot become a deputy for a destructive action. |
| Parameter injection | The server validates `db` against a character-class guard and a 38-database allowlist. It validates UIDs, search terms, and History fields before use. It encodes every value with `URLSearchParams` and never builds a URL by concatenation. |
| API key leakage | The server masks `api_key` in every log line, error message, and response. It never echoes the constructed URL to the model. stdio logging goes to stderr only. |
| SSRF | The base URL is a constant, not an environment setting. The client follows redirects manually, at most three hops, and every hop must end with `.ncbi.nlm.nih.gov`. |
| Resource exhaustion | A token bucket, per-endpoint `retmax` ceilings, a 5 MB response ceiling, a request timeout, and bounded retries with backoff. |
| Malicious XML | Entity processing is off. The client strips DOCTYPE declarations and caps the body size before parsing. |
| Supply chain | Three runtime dependencies. The repository includes the lockfile. |

## Development

```console
npm test           # unit tests, no network
npm run build      # strict TypeScript
npm run test:live  # integration tests: every tool makes a real NCBI call
npm run verify     # protocol smoke test over stdio, no live calls
npm run verify:live
npm run doctor     # probe all nine endpoints and report which work
npm run verify:evals
npm run call eutils_esearch '{"db":"pubmed","term":"cancer","retmax":2}'
```

`npm run call` invokes one tool directly. It is the fastest way to inspect a response shape.

Run the inspector interactively:

```console
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Live tests assert only stable facts, such as a 1987 paper's PMID or a fixed journal name. Counts and dates change as PubMed grows, so the tests never assert on them.

### Refreshing the database list

NCBI adds and retires databases. When the server rejects a valid database name, run:

```console
npm run refresh:databases
```

That command rewrites `ENTREZ_DATABASES` in `src/constants.ts` from EInfo.

## Layout

```text
src/
  index.ts              server entry point, stdio transport
  constants.ts          base URL, database allowlist, caps
  types.ts              HistoryRef, pagination, EutilsError
  services/
    eutilsClient.ts     single egress point: URL building, redirects, retries, redaction
    rateLimiter.ts      token bucket
    xml.ts              hardened XML parsing
    formatters.ts       markdown and JSON rendering, untrusted-text fencing, truncation
    validate.ts         database, UID, retmax, and History validation
  tools/
    parse.ts            pure response parsers, unit tested against captured fixtures
    common.ts           shared schemas and source resolution
    discovery.ts        EInfo, EGQuery, ESpell
    search.ts           ESearch, EPost
    records.ts          ESummary, EFetch
    links.ts            ELink, ECitMatch
    workflows.ts        search_then_fetch, link_then_fetch
    registry.ts         registers all eleven tools
```

Every outbound request passes through `EutilsClient`. No tool builds a URL.

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

NCBI supplies the data. If you redistribute this software or its output, NCBI's [Disclaimer and Copyright notice](https://www.ncbi.nlm.nih.gov/About/disclaimer.html) must be evident to users. PubMed abstracts can be protected by copyright. Redistribution beyond fair use needs the permission of the copyright holder.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
