import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DEFAULT_RETMAX } from '../constants.js';
import { EutilsError } from '../types.js';
import type { EutilsClient } from '../services/eutilsClient.js';
import { errorResult, pageInfo, respond, type ToolTextResult } from '../services/formatters.js';
import { parseUids, validateDatabase, validateRetmax } from '../services/validate.js';
import { parseXml } from '../services/xml.js';
import { parseEpost, parseEsearch, requireSection } from './parse.js';
import {
  READ_ONLY_ANNOTATIONS,
  ResponseFormatSchema,
  requireTerm,
  STATEFUL_ANNOTATIONS,
} from './common.js';

const EsearchInput = z.object({
  db: z.string().min(1).describe('Entrez database to search, for example "pubmed" or "protein".'),
  term: z
    .string()
    .min(1)
    .describe(
      'Entrez query. Field tags go in square brackets, for example "breast cancer AND 2008[pdat]" or "mouse[orgn]".',
    ),
  retmax: z
    .number()
    .int()
    .min(0)
    .max(10_000, 'retmax must be 10000 or fewer. Use retmax=0 for a count only, or keep the set on the History server and page with retstart.')
    .optional()
    .describe(`Maximum UIDs to return (default ${DEFAULT_RETMAX}). Use 0 to fetch only the count.`),
  retstart: z.number().int().min(0).optional().describe('Index of the first UID to return. Use for paging.'),
  sort: z
    .string()
    .optional()
    .describe('Sort order, for example "pub_date", "relevance", or "first_author". Valid values vary by database.'),
  datetype: z
    .enum(['pdat', 'edat', 'mdat'])
    .optional()
    .describe('Which date field mindate/maxdate apply to: pdat (publication), edat (Entrez), mdat (modification).'),
  mindate: z.string().optional().describe('Start date, as YYYY, YYYY/MM, or YYYY/MM/DD. Requires datetype.'),
  maxdate: z.string().optional().describe('End date, as YYYY, YYYY/MM, or YYYY/MM/DD. Requires datetype.'),
  usehistory: z
    .boolean()
    .optional()
    .describe(
      'Store the result set on the NCBI History server and return a history handle (default true). Set false to skip it.',
    ),
  response_format: ResponseFormatSchema,
});

const EpostInput = z.object({
  db: z.string().min(1).describe('Entrez database the UIDs belong to, for example "pubmed".'),
  uids: z
    .union([z.string(), z.array(z.string())])
    .describe('UIDs or accessions to upload, as an array or a comma-separated string.'),
  response_format: ResponseFormatSchema,
});

async function runEsearch(
  client: EutilsClient,
  input: z.infer<typeof EsearchInput>,
): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const term = requireTerm(input.term);
  const retmax = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'esearch');
  const retstart = input.retstart ?? 0;
  const useHistory = input.usehistory ?? true;

  const params: Record<string, unknown> = { db, term, retmax, retstart, retmode: 'json' };
  if (input.sort) params['sort'] = input.sort;
  if (input.datetype) params['datetype'] = input.datetype;
  if (input.mindate) params['mindate'] = input.mindate;
  if (input.maxdate) params['maxdate'] = input.maxdate;
  if (useHistory) params['usehistory'] = 'y';

  const res = await client.request({ endpoint: 'esearch.fcgi', params });
  const { total, uids, queryTranslation, translations, history } = parseEsearch(
    res.json,
    db,
    useHistory,
  );

  const page = pageInfo(total, uids.length, retstart);
  const structured = {
    database: db,
    term,
    ...page,
    uids,
    query_translation: queryTranslation,
    term_translations: translations,
    ...(history ? { history } : {}),
  };

  const markdown = [
    `# ESearch: \`${term}\``,
    '',
    `Database **${db}** matched **${total.toLocaleString('en-US')}** records. Showing ${uids.length} starting at ${retstart}.`,
    '',
    queryTranslation ? `Query translated to: \`${queryTranslation}\`` : '',
    translations.length > 0
      ? ['', '## How terms were expanded', '', translations.map((t) => `- \`${t.from}\` → ${t.to}`).join('\n')].join('\n')
      : '',
    '',
    uids.length > 0 ? `## UIDs\n\n${uids.join(', ')}` : 'No UIDs returned for this page.',
    '',
    page.has_more
      ? `More results available. Either call again with retstart=${page.next_offset}, or pass the history handle below to eutils_esummary / eutils_efetch.`
      : 'This is the last page.',
    history
      ? [
          '',
          '## History handle',
          '',
          'Pass this object unchanged as the `history` argument of `eutils_esummary`, `eutils_efetch`, or `eutils_elink` to work with the whole result set.',
          '',
          '```json',
          JSON.stringify(history),
          '```',
        ].join('\n')
      : '',
    '',
    uids.length > 0
      ? `Next: call \`eutils_esummary\` with db="${db}" and these UIDs to screen titles before fetching full records.`
      : total > 0
        ? 'Next: the page is empty but matches exist. Lower retstart.'
        : 'Next: check the spelling with `eutils_espell`, or try `eutils_egquery` to find a database that has matches.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

async function runEpost(
  client: EutilsClient,
  input: z.infer<typeof EpostInput>,
): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const uids = parseUids(input.uids);

  // EPost answers JSON requests with HTTP 500, so the request stays XML and
  // is parsed locally.
  const res = await client.request({
    endpoint: 'epost.fcgi',
    params: { db, id: uids.join(',') },
  });

  const parsed = parseXml(res.text);
  if (parsed === undefined) {
    throw new EutilsError(
      'parse',
      'EPost returned a body that could not be parsed as XML.',
      'Retry. If it persists, validate the UIDs with eutils_esearch first.',
    );
  }

  const history = parseEpost(parsed, db);

  if (!history) {
    throw new EutilsError(
      'upstream',
      'EPost did not return a usable History handle.',
      'Verify the UIDs exist in this database, then retry.',
    );
  }

  const structured = { database: db, uploaded: uids.length, history };

  const markdown = [
    `# EPost: uploaded ${uids.length} UID(s) to \`${db}\``,
    '',
    'The set is now held on the NCBI History server.',
    '',
    '```json',
    JSON.stringify(history),
    '```',
    '',
    'Next: pass this object as the `history` argument of `eutils_esummary`, `eutils_efetch`, `eutils_elink`, or `eutils_esearch` (`term="%23<query_key> AND ..."`).',
  ].join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

/** Register ESearch and EPost. */
export function registerSearchTools(server: McpServer, client: EutilsClient): void {
  server.registerTool(
    'eutils_esearch',
    {
      title: 'Entrez Text Search',
      description: `Search an Entrez database and return matching UIDs.

This is the entry point for a retrieval pipeline. It returns UIDs, never records.
By default it also stores the result set on the NCBI History server and returns a
history handle, so later calls can page through the whole set without re-searching.

Entrez field tags go in square brackets: gene[tiab], 2008[pdat], mouse[orgn].
Boolean operators AND, OR, NOT must be uppercase.

Args:
  - db (string): database to search, for example "pubmed".
  - term (string): Entrez query, for example "breast cancer AND 2008[pdat]".
  - retmax (number, optional): UIDs to return, 0-10000. Default 20. Use 0 for count only.
  - retstart (number, optional): index of the first UID. Default 0.
  - sort (string, optional): "pub_date", "relevance", "first_author", ...
  - datetype ('pdat' | 'edat' | 'mdat', optional): date field for mindate/maxdate.
  - mindate, maxdate (string, optional): YYYY, YYYY/MM, or YYYY/MM/DD.
  - usehistory (boolean, optional): return a History handle. Default true.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { database, term, total, count, offset, has_more, next_offset,
    uids: string[], query_translation, term_translations: [{ from, to }], history? }

Examples:
  - Use when: "find papers about CRISPR in Nature" -> db="pubmed", term="CRISPR AND nature[journal]"
  - Use when: "how many records mention this gene?" -> retmax=0
  - Don't use when: you already have UIDs (use eutils_esummary or eutils_efetch)
  - Don't use when: you don't know which database (use eutils_egquery first)

Error Handling:
  - Rejects retmax above 10000 with advice to use the History server
  - Rejects an unknown database and lists valid ones
  - Returns an empty result with spelling advice rather than an error`,
      inputSchema: EsearchInput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEsearch(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'eutils_epost',
    {
      title: 'Upload UIDs to Entrez History',
      description: `Upload a list of UIDs to the NCBI History server and get a reusable handle.

Use this when you already have UIDs from somewhere other than an ESearch, or when you
want to combine several sets. Many thousands of UIDs fit in one call.

Args:
  - db (string): database the UIDs belong to, for example "gene".
  - uids (string[] | string): UIDs or accessions, as an array or comma-separated string.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { database, uploaded, history: { db, web_env, query_key } }

Examples:
  - Use when: "fetch these five gene IDs" -> db="gene", uids=["7173","22018","54314"]
  - Use when: combining UID lists from two sources before one download
  - Don't use when: you are about to search; ESearch with usehistory already posts its own results

Error Handling:
  - Rejects UIDs containing URL metacharacters
  - Reports an upstream error if NCBI returns no History handle`,
      inputSchema: EpostInput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEpost(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
