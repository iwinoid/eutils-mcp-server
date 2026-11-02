# Contributing

## Questions

Open an [issue](https://github.com/iwinoid/eutils-mcp-server/issues) for a question, a
bug report, or a feature request. Include the tool name, the arguments you passed, and
the full error text.

For a problem with NCBI's data or its API rather than with this server, run
`npm run doctor` first. It reports which endpoints answer from your network, which
separates a local fault from an upstream one.

## Pull Requests

Pull requests are accepted. Keep one change per pull request, and describe what
motivated it.

Every pull request must pass `npm run ci` locally before you open it. That command runs
lint, formatting, type checking (source and tests), coverage, and the build. GitHub
Actions additionally runs the offline protocol check and the runtime dependency audit, so
read the job list as well as the local result. A pull request that lowers a coverage
threshold instead of raising coverage will be sent back.

## Requirements

- Node.js 22.9 or newer, as pinned in `.nvmrc`.
- `npm run ci` passes: lint, format check, type check, coverage, and build.
- New behaviour comes with a test. A bug fix comes with a test that fails before the fix.
- Live tests are separate. They call NCBI, so they are not part of `npm run ci`.

## Development

```console
git clone https://github.com/iwinoid/eutils-mcp-server.git
cd eutils-mcp-server
npm install
npm run build
npm test
```

| Command                        | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `npm run ci`                   | Lint, formatting, typecheck, coverage, and build      |
| `npm test`                     | Unit tests. No network.                               |
| `npm run test:coverage`        | Unit tests with a coverage report and thresholds      |
| `npm run test:live`            | Integration tests. Every tool makes a real NCBI call. |
| `npm run lint`                 | ESLint                                                |
| `npm run format`               | Prettier, writes                                      |
| `npm run typecheck`            | `tsc` for src, then `tsconfig.test.json` for tests    |
| `npm run verify`               | Protocol smoke test over stdio. No live calls.        |
| `npm run doctor`               | Probe all nine endpoints and report which answer      |
| `npm run call <tool> '<json>'` | Invoke one tool directly                              |

Set `NCBI_API_KEY` in `.env` before `npm run test:live`; that script loads `.env` explicitly.
Without a key NCBI allows three requests per second, and the live suite takes noticeably longer.

## Reading the Coverage Number

Statement coverage sits near 77% and branch coverage near 80%. The `src/tools/` handlers
are exercised in-process through `test/toolHarness.ts`, which registers the real tools
with a stub `EUtilsClient`; the remaining gaps are mostly error paths in the HTTP client
and the live-only branches. Do not lower the thresholds in `vitest.config.ts`.

## Naming and API conventions

- MCP protocol symbols use the SDK spelling: `McpServer`, `inputSchema`, `outputSchema`,
  `structuredContent`, `isError`, `ToolAnnotations`, `readOnlyHint`, `idempotentHint`,
  `openWorldHint`, `CallToolResult`, `serverInfo`, `protocolVersion`.
- NCBI wire parameters use the upstream spelling exactly, and only the map in
  `src/services/eutilsParams.ts` may define them: `db`, `dbfrom`, `id`, `term`, `retmax`,
  `retstart`, `usehistory`, `WebEnv`, `query_key`, `rettype`, `retmode`, `mindate`,
  `maxdate`, `datetype`, `sort`, `cmd`, `linkname`, `bdata`, `api_key`, `tool`, `email`.
- Internal TypeScript uses `EUtils` spelling for the API and camelCase for variables: `ESearch`,
  `EPost`, `ESummary`, `EFetch`, `ELink`, `EGQuery`, `ESpell`, `ECitMatch`, `EInfo`.
- `HistoryRef` and the `groups` fields in `parseELink` are wire DTOs: their snake_case field
  names are part of the MCP result contract and are deliberately not renamed.
- ESLint enforces camelCase/PascalCase/UPPER_CASE for variables, functions, parameters, and
  types. It does not rename protocol or wire properties.

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
scripts/                operator tooling
test/                   unit tests, live tests, and captured NCBI fixtures
docs/                   upstream defect log
evals/                  evaluation question set
```

## Code of Conduct

This project follows the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/),
version 2.1. Report unacceptable behaviour to the maintainer listed in the README.
