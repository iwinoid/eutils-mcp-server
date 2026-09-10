import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DEFAULT_RETMAX } from '../constants.js';
import { EutilsError, type HistoryRef } from '../types.js';
import type { EutilsClient } from '../services/eutilsClient.js';
import { errorResult, fenceUntrusted, respond, type ToolTextResult } from '../services/formatters.js';
import { parseUids, validateDatabase, validateRetmax } from '../services/validate.js';
import { parseXml } from '../services/xml.js';
import { parseElink, parseEpost, parseEsearch } from './parse.js';
import { READ_ONLY_ANNOTATIONS, ResponseFormatSchema, requireTerm } from './common.js';
import { defaultRettype } from './records.js';

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
    .describe('Record format. Defaults to "abstract" for pubmed, "fasta" for sequences.'),
  retmode: z.enum(['text', 'xml']).optional().describe('Response encoding. Default "text".'),
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
  rettype: z.string().optional().describe('Record format for the target database.'),
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
  retrieved: z.number().optional(),
  rettype: z.string().optional(),
  source_history: HistoryRefOutput.optional(),
  history: HistoryRefOutput.optional(),
  text: z.string(),
});

/** ESearch for a query, storing the set on the History server. */
async function searchToHistory(
  client: EutilsClient,
  db: string,
  term: string,
): Promise<{ count: number; history: HistoryRef }> {
  const res = await client.request({
    endpoint: 'esearch.fcgi',
    params: { db, term, retmax: 0, usehistory: 'y', retmode: 'json' },
  });

  const { total: count, history } = parseEsearch(res.json, db, true);

  if (!history) {
    throw new EutilsError(
      'upstream',
      'ESearch did not return a History handle, so the pipeline cannot continue.',
      'Retry. If it persists, run eutils_esearch on its own to inspect the response.',
    );
  }

  return { count, history };
}

/** Upload explicit UIDs to the History server. */
async function postToHistory(client: EutilsClient, db: string, uids: string[]): Promise<HistoryRef> {
  const res = await client.request({ endpoint: 'epost.fcgi', params: { db, id: uids.join(',') } });

  const parsed = parseXml(res.text);
  const history = parsed === undefined ? undefined : parseEpost(parsed, db);

  if (!history) {
    throw new EutilsError(
      'upstream',
      'EPost did not return a usable History handle.',
      'Verify the UIDs exist in the source database, then retry.',
    );
  }

  return history;
}

/** Download a page of records from a History set. */
async function fetchFromHistory(
  client: EutilsClient,
  db: string,
  history: HistoryRef,
  rettype: string,
  retmode: string,
  retmax: number,
): Promise<string> {
  const res = await client.request({
    endpoint: 'efetch.fcgi',
    params: {
      db,
      WebEnv: history.web_env,
      query_key: history.query_key,
      rettype,
      retmode,
      retstart: 0,
      retmax,
    },
  });

  const body = res.text.trim();
  if (/^error[:\s]/i.test(body)) {
    throw new EutilsError(
      'validation',
      `EFetch reported: ${body.slice(0, 300)}`,
      'Check that the UIDs exist in this database and that rettype is valid for it.',
    );
  }

  return body;
}

async function runSearchThenFetch(
  client: EutilsClient,
  input: z.infer<typeof SearchThenFetchInput>,
): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const term = requireTerm(input.term);
  const retmax = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'efetch');
  const rettype = defaultRettype(db, input.rettype);
  const retmode = input.retmode ?? 'text';

  const { count, history } = await searchToHistory(client, db, term);

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

  const body = await fetchFromHistory(client, db, history, rettype, retmode, retmax);

  const structured = {
    database: db,
    term,
    total: count,
    retrieved: Math.min(count, retmax),
    rettype,
    retmode,
    history,
    text: body,
  };

  const markdown = [
    `# Search and fetch: \`${term}\``,
    '',
    `\`${db}\` matched **${count.toLocaleString('en-US')}** records. Downloaded the first ${Math.min(count, retmax)} as ${rettype}/${retmode}.`,
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

async function runLinkThenFetch(
  client: EutilsClient,
  input: z.infer<typeof LinkThenFetchInput>,
): Promise<ToolTextResult> {
  const dbfrom = validateDatabase(input.dbfrom);
  const dbto = validateDatabase(input.db);
  const retmax = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'efetch');
  const rettype = defaultRettype(dbto, input.rettype);

  const hasTerm = input.term !== undefined && input.term.trim().length > 0;
  const hasUids = input.uids !== undefined && String(input.uids).trim().length > 0;

  if (hasTerm === hasUids) {
    throw new EutilsError(
      'validation',
      hasTerm ? 'Both term and uids were supplied.' : 'Neither term nor uids was supplied.',
      'Pass exactly one: term to search the source database, or uids to select source records directly.',
    );
  }

  const source = hasTerm
    ? await searchToHistory(client, dbfrom, requireTerm(input.term))
    : { count: 0, history: await postToHistory(client, dbfrom, parseUids(input.uids!)) };

  const linkParams: Record<string, unknown> = {
    dbfrom,
    db: dbto,
    WebEnv: source.history.web_env,
    query_key: source.history.query_key,
    cmd: 'neighbor_history',
    retmode: 'json',
  };
  if (input.linkname) linkParams['linkname'] = input.linkname;

  const linkRes = await client.request({ endpoint: 'elink.fcgi', params: linkParams });
  const { histories } = parseElink(linkRes.json);

  const target = histories.find((candidate) => candidate.db === dbto) ?? histories[0];

  if (target === undefined) {
    const structured = {
      dbfrom,
      dbto,
      source_total: source.count,
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
  const body = await fetchFromHistory(client, dbto, targetHistory, rettype, 'text', retmax);

  const structured = {
    dbfrom,
    dbto,
    source_total: source.count,
    retrieved: retmax,
    rettype,
    source_history: source.history,
    history: targetHistory,
    text: body,
  };

  const markdown = [
    `# Link and fetch: \`${dbfrom}\` → \`${dbto}\``,
    '',
    `Found links in \`${dbto}\` and downloaded up to ${retmax} record(s) as ${rettype}/text.`,
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

/** Register the two convenience pipelines. */
export function registerWorkflowTools(server: McpServer, client: EutilsClient): void {
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
  - rettype (string, optional): "abstract" (pubmed default), "fasta" (sequence default), ...
  - retmode ('text' | 'xml', optional): default "text".
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
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runSearchThenFetch(client, input);
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
  - rettype (string, optional): record format for the target database.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { dbfrom, dbto, source_total, retrieved, rettype, source_history, history, text }

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
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runLinkThenFetch(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
