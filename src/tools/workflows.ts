import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DEFAULT_RETMAX } from '../constants.js';
import { EUtilsError, type HistoryRef, type QueryParams } from '../types.js';
import type { EUtilsClient } from '../services/eutilsClient.js';
import { EUTILS_PARAM } from '../services/eutilsParams.js';
import { resolveFetchFormat, type FetchFormat } from '../services/fetchFormats.js';
import { errorResult, fenceUntrusted, respond, type ToolTextResult } from '../services/formatters.js';
import { parseUids, validateDatabase, validateRetmax } from '../services/validate.js';
import { parseXml } from '../services/xml.js';
import { parseELink, parseEPost, parseESearch } from './parse.js';
import { ResponseFormatSchema, requireTerm, STATEFUL_ANNOTATIONS } from './common.js';
const SearchThenFetchInput = z.object({
  db: z.string().min(1).describe('Entrez database to search, for example "pubmed".'),
  term: z.string().min(1).describe('Entrez query, for example "CRISPR AND 2024[pdat]".'),
  retmax: z
    .number()
    .int()
    .min(1)
    .max(500, 'retmax must be 500 or fewer. Page with the returned history handle instead.')
    .optional()
    .describe(`Records to download (default ${DEFAULT_RETMAX}, max 500).`),
  rettype: z
    .string()
    .optional()
    .describe(
      'Record format. When omitted, PubMed returns abstracts, sequence databases return FASTA, and other databases use their native default.',
    ),
  retmode: z
    .enum(['text', 'xml', 'asn.1'])
    .optional()
    .describe('Response encoding. Omit for the database default.'),
  response_format: ResponseFormatSchema,
});
const LinkThenFetchInput = z.object({
  dbfrom: z.string().min(1).describe('Source database, for example "gene".'),
  db: z.string().min(1).describe('Target database to download from, for example "protein".'),
  term: z.string().optional().describe('Query in dbfrom. Use instead of uids to select the source records.'),
  uids: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Source UIDs in dbfrom. Use instead of term.'),
  linkname: z.string().optional().describe('Specific link to follow. Use eutils_einfo to list valid names.'),
  retmax: z
    .number()
    .int()
    .min(1)
    .max(500, 'retmax must be 500 or fewer. Page with the returned history handle instead.')
    .optional()
    .describe(`Records to download from the target database (default ${DEFAULT_RETMAX}, max 500).`),
  rettype: z
    .string()
    .optional()
    .describe('Record format for the target database. When omitted, the database default applies.'),
  retmode: z
    .enum(['text', 'xml', 'asn.1'])
    .optional()
    .describe('Response encoding for the target database. Omit for the database default.'),
  response_format: ResponseFormatSchema,
});
const HistoryRefOutput = z.looseObject({
  db: z.string(),
  web_env: z.string(),
  query_key: z.string(),
});
const SearchThenFetchOutput = z.looseObject({
  database: z.string(),
  term: z.string(),
  total: z.number(),
  retrieved: z.number(),
  rettype: z.string().optional(),
  retmode: z.string().optional(),
  history: HistoryRefOutput,
  text: z.string(),
});
const LinkThenFetchOutput = z.looseObject({
  dbfrom: z.string(),
  dbto: z.string(),
  source_total: z.number(),
  requested: z.number().optional().describe('Records requested from the target set.'),
  retrieved: z
    .number()
    .optional()
    .describe('Records counted in the returned text, when the format allows counting.'),
  linkname: z.string().optional(),
  rettype: z.string().optional(),
  retmode: z.string().optional(),
  source_history: HistoryRefOutput.optional(),
  history: HistoryRefOutput.optional(),
  text: z.string(),
});
async function searchToHistory(
  client: EUtilsClient,
  db: string,
  term: string,
  signal?: AbortSignal,
): Promise<{
  count: number;
  history: HistoryRef;
}> {
  const res = await client.request({
    endpoint: 'esearch.fcgi',
    params: { db, term, retmax: 0, usehistory: 'y', retmode: 'json' },
    signal,
  });
  const { total: count, history } = parseESearch(res.json, db, true);
  if (!history) {
    throw new EUtilsError(
      'upstream',
      'ESearch did not return a History handle, so the pipeline cannot continue.',
      'Retry. If it persists, run eutils_esearch on its own to inspect the response.',
    );
  }
  return { count, history };
}
async function postToHistory(
  client: EUtilsClient,
  db: string,
  uids: string[],
  signal?: AbortSignal,
): Promise<HistoryRef> {
  const res = await client.request({
    endpoint: 'epost.fcgi',
    params: { db, id: uids.join(',') },
    signal,
  });
  const parsed = parseXml(res.text);
  const history = parsed === undefined ? undefined : parseEPost(parsed, db);
  if (!history) {
    throw new EUtilsError(
      'upstream',
      'EPost did not return a usable History handle.',
      'Verify the UIDs exist in the source database, then retry.',
    );
  }
  return history;
}
async function fetchFromHistory(
  client: EUtilsClient,
  db: string,
  history: HistoryRef,
  format: FetchFormat,
  retmax: number,
  signal?: AbortSignal,
): Promise<string> {
  const params: QueryParams = {
    db,
    WebEnv: history.web_env,
    query_key: history.query_key,
    retstart: 0,
    retmax,
  };
  if (format.rettype !== undefined) params[EUTILS_PARAM.retType] = format.rettype;
  if (format.retmode !== undefined) params[EUTILS_PARAM.retMode] = format.retmode;
  const res = await client.request({ endpoint: 'efetch.fcgi', params, signal });
  const body = res.text.trim();
  if (/^error[:\s]/i.test(body)) {
    throw new EUtilsError(
      'validation',
      `EFetch reported: ${body.slice(0, 300)}`,
      'Check that the UIDs exist in this database and that rettype is valid for it.',
    );
  }
  return body;
}
async function runSearchThenFetch(
  client: EUtilsClient,
  input: z.infer<typeof SearchThenFetchInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const term = requireTerm(input.term);
  const retmax = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'efetch');
  const format = resolveFetchFormat(db, input.rettype, input.retmode);
  const { count, history } = await searchToHistory(client, db, term, signal);
  if (count === 0) {
    const structured = { database: db, term, total: 0, retrieved: 0, history, text: '' };
    const markdown = [
      `# No records found`,
      '',
      `\`${term}\` matched nothing in \`${db}\`.`,
      '',
      'Next: check the spelling with `eutils_espell`, or try `eutils_egquery` to find a database that has matches.',
    ].join('\n');
    return respond({ structured, markdown, format: input.response_format });
  }
  const body = await fetchFromHistory(client, db, history, format, retmax, signal);
  const structured = {
    database: db,
    term,
    total: count,
    retrieved: Math.min(count, retmax),
    rettype: format.rettype ?? 'default',
    retmode: format.retmode ?? 'default',
    history,
    text: body,
  };
  const markdown = [
    `# Search and fetch: \`${term}\``,
    '',
    `\`${db}\` matched **${count.toLocaleString('en-US')}** records. Downloaded the first ${Math.min(count, retmax)} as ${format.label}.`,
    '',
    body.length > 0 ? fenceUntrusted(body) : 'No record text was returned for this page.',
    '',
    count > retmax
      ? `More records remain. Re-run with a larger retmax, or use the history handle below with \`eutils_efetch\` and retstart to page.`
      : 'This is the complete set.',
    '',
    '## History handle',
    '',
    '```json',
    JSON.stringify(history),
    '```',
  ].join('\n');
  return respond({ structured, markdown, format: input.response_format });
}
function countFastaRecords(body: string): number {
  if (body.length === 0) return 0;
  return body.split(/\r?\n(?=>)/).filter((part) => part.startsWith('>')).length;
}
async function runLinkThenFetch(
  client: EUtilsClient,
  input: z.infer<typeof LinkThenFetchInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const dbfrom = validateDatabase(input.dbfrom);
  const dbto = validateDatabase(input.db);
  const retmax = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'efetch');
  const format = resolveFetchFormat(dbto, input.rettype, input.retmode);
  const hasTerm = input.term !== undefined && input.term.trim().length > 0;
  const hasUids = input.uids !== undefined && String(input.uids).trim().length > 0;
  if (hasTerm === hasUids) {
    throw new EUtilsError(
      'validation',
      hasTerm ? 'Both term and uids were supplied.' : 'Neither term nor uids was supplied.',
      'Pass exactly one: term to search the source database, or uids to select source records directly.',
    );
  }
  const sourceUids = hasUids ? parseUids(input.uids!) : undefined;
  const source = hasTerm
    ? await searchToHistory(client, dbfrom, requireTerm(input.term), signal)
    : { count: sourceUids!.length, history: await postToHistory(client, dbfrom, sourceUids!, signal) };
  const linkParams: QueryParams = {
    dbfrom,
    db: dbto,
    WebEnv: source.history.web_env,
    query_key: source.history.query_key,
    cmd: 'neighbor_history',
    retmode: 'json',
  };
  if (input.linkname) linkParams['linkname'] = input.linkname;
  const linkRes = await client.request({ endpoint: 'elink.fcgi', params: linkParams, signal });
  const { groups, webEnv, histories } = parseELink(linkRes.json);
  const candidates = groups.filter((group) => group.dbto === dbto && group.query_key !== undefined);
  const preferred = input.linkname
    ? candidates.find((group) => group.linkname === input.linkname)
    : (candidates.find((group) => group.linkname === dbfrom + '_' + dbto) ?? candidates[0]);
  const target: HistoryRef | undefined =
    preferred?.query_key !== undefined && webEnv !== undefined
      ? { db: dbto, web_env: webEnv, query_key: preferred.query_key }
      : (histories.find((candidate) => candidate.db === dbto) ?? histories[0]);
  if (target === undefined) {
    const structured = {
      dbfrom,
      dbto,
      source_total: source.count,
      requested: retmax,
      linked: 0,
      text: '',
    };
    const markdown = [
      `# No links from \`${dbfrom}\` to \`${dbto}\``,
      '',
      'The source set produced no linked records in the target database.',
      '',
      `Next: call \`eutils_einfo\` with db="${dbfrom}" to list the link names that do exist.`,
    ].join('\n');
    return respond({ structured, markdown, format: input.response_format });
  }
  const targetHistory: HistoryRef = target;
  const body = await fetchFromHistory(client, dbto, targetHistory, format, retmax, signal);
  const retrieved = format.rettype === 'fasta' ? countFastaRecords(body) : undefined;
  const structured = {
    dbfrom,
    dbto,
    source_total: source.count,
    requested: retmax,
    ...(retrieved !== undefined ? { retrieved } : {}),
    ...(preferred?.linkname ? { linkname: preferred.linkname } : {}),
    rettype: format.rettype ?? 'default',
    retmode: format.retmode ?? 'default',
    source_history: source.history,
    history: targetHistory,
    text: body,
  };
  const markdown = [
    `# Link and fetch: \`${dbfrom}\` → \`${dbto}\``,
    '',
    `Found links in \`${dbto}\` and downloaded up to ${retmax} record(s) as ${format.label}.`,
    '',
    body.length > 0 ? fenceUntrusted(body) : `The linked set was empty in \`${dbto}\`.`,
    '',
    '## History handles',
    '',
    `Source (\`${dbfrom}\`):`,
    '',
    '```json',
    JSON.stringify(source.history),
    '```',
    '',
    `Target (\`${dbto}\`):`,
    '',
    '```json',
    JSON.stringify(targetHistory),
    '```',
    '',
    `Next: page the target set with \`eutils_efetch\` and retstart, or follow a further link with \`eutils_elink\`.`,
  ].join('\n');
  return respond({ structured, markdown, format: input.response_format });
}
export function registerWorkflowTools(server: McpServer, client: EUtilsClient): void {
  server.registerTool(
    'eutils_search_then_fetch',
    {
      title: 'Search and Fetch',
      description: `Search a database and download the matching records in one call.

This is the shortcut for the common "find me the papers about X" request. It runs
ESearch with a History handle, then EFetch, saving a round trip. Use the individual
tools when you want to screen titles before downloading.

Args:
  - db (string): database to search, for example "pubmed".
  - term (string): Entrez query.
  - retmax (number, optional): records to download. Default 20, max 500.
  - rettype (string, optional): explicit record format. Omit for the database default.
  - retmode ('text' | 'xml' | 'asn.1', optional): response encoding. Omit for the database default.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { database, term, total, retrieved, rettype, retmode, history, text }

Examples:
  - Use when: "summarize recent papers on CRISPR delivery" -> db="pubmed", term="CRISPR delivery AND 2024[pdat]"
  - Use when: "get the sequences for these gene records" -> db="nuccore", term="..."
  - Don't use when: you want to inspect titles first (use eutils_esearch then eutils_esummary)
  - Don't use when: the result set is huge; search with retmax=0 first to see the count

Error Handling:
  - Returns a friendly empty result, with spelling advice, when nothing matches
  - Refuses retmax above 500
  - Reports the ESearch count so you can judge whether to page`,
      inputSchema: SearchThenFetchInput,
      outputSchema: SearchThenFetchOutput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runSearchThenFetch(client, input, ctx.mcpReq.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'eutils_link_then_fetch',
    {
      title: 'Link and Fetch Across Databases',
      description: `Follow links from one database to another and download the target records in one call.

Typical uses: gene IDs to protein sequences, PMIDs to PMC full text, nucleotide
records to SNPs. Give it either a query or a UID list in the source database, and it
returns records from the target database.

Args:
  - dbfrom (string): source database, for example "gene".
  - db (string): target database to download from, for example "protein".
  - term (string, optional): query in dbfrom. Pass exactly one of term or uids.
  - uids (string[] | string, optional): source UIDs in dbfrom.
  - linkname (string, optional): specific link to follow.
  - retmax (number, optional): target records to download. Default 20, max 500.
  - rettype (string, optional): record format for the target database. Omit for the database default.
  - retmode ('text' | 'xml' | 'asn.1', optional): response encoding for the target database.
    Omit for the database default.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { dbfrom, dbto, source_total, retrieved, rettype, retmode, source_history, history, text }

Examples:
  - Use when: "get the protein sequences for these gene IDs" -> dbfrom="gene", db="protein", uids=[...]
  - Use when: "find PMC full text for papers about X" -> dbfrom="pubmed", db="pmc", term="..."
  - Don't use when: you only need the linked UIDs (use eutils_elink, which is cheaper)

Error Handling:
  - Rejects passing both term and uids, or neither
  - Returns an empty result with a hint to list link names when no links exist
  - Refuses retmax above 500`,
      inputSchema: LinkThenFetchInput,
      outputSchema: LinkThenFetchOutput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runLinkThenFetch(client, input, ctx.mcpReq.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
