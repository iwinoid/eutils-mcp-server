# eutils-mcp-server

A stdio MCP server for the NCBI Entrez E-utilities. It exposes 11 tools covering search, summaries, records, links, discovery, citation matching, and two multi-step workflows.

## Architecture

```text
MCP client
  -> src/index.ts            stdio transport, server instructions
  -> src/tools/*             11 tool handlers and Zod schemas
  -> src/services/*          request client, rate limiter, validation,
                             formatters, XML helpers, wire parameter map
  -> EUtilsClient            one egress point for every NCBI request
  -> NCBI E-utilities        https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
```

- Every request goes through one client, so rate limiting, retries, redirects, response limits, and API-key redaction are shared.
- The server keeps no local state. History handles are ordinary values returned to the caller and passed back unchanged.
- The base URL is fixed. Redirects must stay on `ncbi.nlm.nih.gov`; record text is treated as untrusted data.
- The server never writes to disk and never listens on a port.

## Tools

| Tool                       | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `eutils_einfo`             | List databases or describe one database         |
| `eutils_esearch`           | Search a database and return UIDs               |
| `eutils_epost`             | Upload UIDs to the NCBI History server          |
| `eutils_esummary`          | Compact summaries for a UID set                 |
| `eutils_efetch`            | Full records, abstracts, sequences, and formats |
| `eutils_elink`             | Follow links between databases                  |
| `eutils_egquery`           | Count matches across databases                  |
| `eutils_espell`            | Spelling suggestion for a query                 |
| `eutils_ecitmatch`         | Resolve formatted citations to PMIDs            |
| `eutils_search_then_fetch` | Search and download in one call                 |
| `eutils_link_then_fetch`   | Follow links and download the target records    |

## Run

Node.js 22.9 or newer.

```console
npm install
npm run build
NCBI_EMAIL=you@example.com NCBI_API_KEY=... npm start
```

Optional environment variables: `NCBI_EMAIL`, `NCBI_API_KEY`, `NCBI_TOOL`. `.env` is loaded by the npm scripts that talk to NCBI.

Useful commands:

```console
npm test          # offline unit tests
npm run ci        # lint, format, typecheck, coverage, build
npm run verify    # offline MCP protocol smoke test
npm run doctor    # live endpoint probe
```

## References

- NCBI E-utilities manual: https://www.ncbi.nlm.nih.gov/books/NBK25501/
- MCP specification: https://modelcontextprotocol.io/specification
- Local extracted manual (gitignored): `scratch/eutilities-manual.txt`

## License

MIT
