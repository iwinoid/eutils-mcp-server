import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DEFAULT_RETMAX } from '../constants.js';
import { EUtilsError, type QueryParams } from '../types.js';
import type { EUtilsClient } from '../services/eutilsClient.js';
import { errorResult, pageInfo, respond, type ToolTextResult } from '../services/formatters.js';
import {
  parseUids,
  validateDatabase,
  validateHistory,
  validateRetmax,
  validateWebEnv,
} from '../services/validate.js';
import { parseXml } from '../services/xml.js';
import { parseEPost, parseESearch } from './parse.js';
import { HistorySchema, ResponseFormatSchema, requireTerm, STATEFUL_ANNOTATIONS } from './common.js';
const ESearchInput = z.object({
  db: z.string().min(1).describe('Entrez database to search, for example "pubmed" or "protein".'),
  term: z
    .string()
    .min(1)
    .describe(
      'Entrez query. Field tags go in square brackets, for example "breast cancer AND 2008[pdat]" or "mouse[orgn]".',
    ),
  field: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'field must be a single Entrez field name, for example "title" or "tiab".')
    .max(64)
    .optional()
    .describe(
      'Restrict the whole term to one Entrez field, for example "title" or "tiab". Equivalent to wrapping the term in that field tag.',
    ),
  idtype: z
    .enum(['acc'])
    .optional()
    .describe(
      'Return accession.version identifiers instead of GI numbers for sequence databases. Only "acc" is supported.',
    ),
  rettype: z
    .enum(['uilist', 'count'])
    .optional()
    .describe(
      'Retrieval type: "uilist" (default) returns UIDs; "count" returns only the total count and no UIDs.',
    ),
  retmax: z
    .number()
    .int()
    .min(0)
    .max(
      10000,
      'retmax must be 10000 or fewer. Use retmax=0 for a count only, or keep the set on the History server and page with retstart.',
    )
    .optional()
    .describe(`Maximum UIDs to return (default ${DEFAULT_RETMAX}). Use 0 to fetch only the count.`),
  retstart: z.number().int().min(0).optional().describe('Index of the first UID to return. Use for paging.'),
  sort: z
    .string()
    .optional()
    .describe(
      'Sort order. PubMed accepts "pub_date", "Author", "JournalName", or "relevance"; other databases accept different values.',
    ),
  datetype: z
    .enum(['pdat', 'edat', 'mdat'])
    .optional()
    .describe(
      'Which date field mindate/maxdate apply to: pdat (publication), edat (Entrez), mdat (modification).',
    ),
  mindate: z.string().optional().describe('Start date, as YYYY, YYYY/MM, or YYYY/MM/DD. Requires datetype.'),
  maxdate: z.string().optional().describe('End date, as YYYY, YYYY/MM, or YYYY/MM/DD. Requires datetype.'),
  reldate: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only include records whose datetype date falls within the last N days. Requires datetype.'),
  usehistory: z
    .boolean()
    .optional()
    .describe(
      'Store the result set on the NCBI History server and return a history handle (default true). Set false to skip it.',
    ),
  history: HistorySchema.optional().describe(
    'History handle from an earlier call. The search appends its result set to that Web Environment, so a later call can combine the two sets. db must match history.db.',
  ),
  response_format: ResponseFormatSchema,
});
const EPostInput = z.object({
  db: z.string().min(1).describe('Entrez database the UIDs belong to, for example "pubmed".'),
  uids: z
    .union([z.string(), z.array(z.string())])
    .describe('UIDs or accessions to upload, as an array or a comma-separated string.'),
  web_env: z
    .string()
    .min(1)
    .optional()
    .describe(
      'WebEnv cookie from an earlier call. When set, the UIDs are appended to that Web Environment as a new query key.',
    ),
  response_format: ResponseFormatSchema,
});
const HistoryOutput = z.looseObject({
  db: z.string().describe('Database the set belongs to.'),
  web_env: z.string().describe('WebEnv cookie for the History server.'),
  query_key: z.string().describe('Query key inside that web environment.'),
});
const ESearchOutput = z.looseObject({
  database: z.string(),
  term: z.string(),
  rettype: z.string().optional().describe('Retrieval type requested; "uilist" when omitted.'),
  total: z.number().describe('Records matching the whole query, not just this page.'),
  count: z.number().describe('Records returned on this page.'),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  uids: z.array(z.string()),
  query_translation: z.string().describe('How Entrez rewrote the query.'),
  term_translations: z.array(z.looseObject({ from: z.string(), to: z.string() })),
  history: HistoryOutput.optional().describe('Present when usehistory is true.'),
});
const EPostOutput = z.looseObject({
  database: z.string(),
  uploaded: z.number(),
  history: HistoryOutput,
});
async function runESearch(
  client: EUtilsClient,
  input: z.infer<typeof ESearchInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const term = requireTerm(input.term);
  const retmax = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'esearch');
  const retstart = input.retstart ?? 0;
  const rettype = input.rettype ?? 'uilist';
  const countOnly = rettype === 'count';
  const historyRef = input.history ? validateHistory(input.history) : undefined;
  if (historyRef !== undefined && historyRef.db !== db) {
    throw new EUtilsError(
      'validation',
      `db '${db}' does not match history.db '${historyRef.db}'.`,
      'Omit history, or pass a history object belonging to the same database.',
    );
  }
  if (historyRef !== undefined && input.usehistory === false) {
    throw new EUtilsError(
      'validation',
      'A history reference was supplied with usehistory=false.',
      'Omit usehistory, or set it to true: ESearch must append to the History server when a history reference is given.',
    );
  }
  if (input.reldate !== undefined && input.datetype === undefined) {
    throw new EUtilsError(
      'validation',
      'reldate requires datetype.',
      'Pass datetype ("pdat", "edat", or "mdat") alongside reldate.',
    );
  }
  const useHistory = historyRef !== undefined ? true : (input.usehistory ?? !countOnly);
  const params: QueryParams = { db, term, retmax, retstart, retmode: 'json' };
  if (input.field) params['field'] = input.field;
  if (input.idtype) params['idtype'] = input.idtype;
  if (input.rettype) params['rettype'] = input.rettype;
  if (historyRef !== undefined) {
    params['WebEnv'] = historyRef.web_env;
    params['query_key'] = historyRef.query_key;
  }
  if (input.sort) params['sort'] = input.sort;
  if (input.datetype) params['datetype'] = input.datetype;
  if (input.mindate) params['mindate'] = input.mindate;
  if (input.maxdate) params['maxdate'] = input.maxdate;
  if (input.reldate !== undefined) params['reldate'] = input.reldate;
  if (useHistory) params['usehistory'] = 'y';
  const res = await client.request({ endpoint: 'esearch.fcgi', params, signal });
  const { total, uids, queryTranslation, translations, history } = parseESearch(res.json, db, useHistory);
  const page = countOnly
    ? { total, count: 0, offset: retstart, has_more: false }
    : pageInfo(total, uids.length, retstart);
  const structured = {
    database: db,
    term,
    rettype,
    ...page,
    uids: countOnly ? [] : uids,
    query_translation: countOnly ? '' : queryTranslation,
    term_translations: countOnly ? [] : translations,
    ...(history && !countOnly ? { history } : {}),
  };
  const markdown = countOnly
    ? [
        `# ESearch: \`${term}\``,
        '',
        `Database **${db}** matched **${total.toLocaleString('en-US')}** records.`,
        '',
        'Count-only request (rettype="count"); no UIDs were returned.',
        '',
        'Next: repeat the call without rettype, or with retmax greater than 0, to get UIDs.',
      ].join('\n')
    : [
        `# ESearch: \`${term}\``,
        '',
        `Database **${db}** matched **${total.toLocaleString('en-US')}** records. Showing ${uids.length} starting at ${retstart}.`,
        '',
        queryTranslation ? `Query translated to: \`${queryTranslation}\`` : '',
        translations.length > 0
          ? [
              '',
              '## How terms were expanded',
              '',
              translations.map((t) => `- \`${t.from}\` → ${t.to}`).join('\n'),
            ].join('\n')
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
async function runEPost(
  client: EUtilsClient,
  input: z.infer<typeof EPostInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const uids = parseUids(input.uids);
  const webEnv = input.web_env !== undefined ? validateWebEnv(input.web_env) : undefined;
  const params: QueryParams = { db, id: uids.join(',') };
  if (webEnv !== undefined) params['WebEnv'] = webEnv;
  const res = await client.request({
    endpoint: 'epost.fcgi',
    params,
    signal,
  });
  const parsed = parseXml(res.text);
  if (parsed === undefined) {
    throw new EUtilsError(
      'parse',
      'EPost returned a body that could not be parsed as XML.',
      'Retry. If it persists, validate the UIDs with eutils_esearch first.',
    );
  }
  const history = parseEPost(parsed, db);
  if (!history) {
    throw new EUtilsError(
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
export function registerSearchTools(server: McpServer, client: EUtilsClient): void {
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
  - field (string, optional): restrict the whole term to one field, for example "title" or "tiab".
  - idtype ("acc", optional): return accession.version identifiers instead of GI numbers for sequence databases.
  - rettype ("uilist" | "count", optional): "count" returns only the total count and no UIDs.
  - retmax (number, optional): UIDs to return, 0-10000. Default 20. Use 0 for count only.
  - retstart (number, optional): index of the first UID. Default 0.
  - sort (string, optional): "pub_date", "Author", "JournalName", or "relevance" for PubMed; other databases differ.
  - datetype ('pdat' | 'edat' | 'mdat', optional): date field for mindate/maxdate/reldate.
  - mindate, maxdate (string, optional): YYYY, YYYY/MM, or YYYY/MM/DD.
  - reldate (number, optional): only records with a datetype date in the last N days. Requires datetype.
  - usehistory (boolean, optional): return a History handle. Default true.
  - history (object, optional): append this search to an existing Web Environment. db must match history.db.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { database, term, rettype, total, count, offset, has_more, next_offset,
    uids: string[], query_translation, term_translations: [{ from, to }], history? }

Examples:
  - Use when: "find papers about CRISPR in Nature" -> db="pubmed", term="CRISPR AND nature[journal]"
  - Use when: "how many records mention this gene?" -> retmax=0 or rettype="count"
  - Don't use when: you already have UIDs (use eutils_esummary or eutils_efetch)
  - Don't use when: you don't know which database (use eutils_egquery first)

Error Handling:
  - Rejects retmax above 10000 with advice to use the History server
  - Rejects an unknown database and lists valid ones
  - Returns an empty result with spelling advice rather than an error`,
      inputSchema: ESearchInput,
      outputSchema: ESearchOutput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runESearch(client, input, ctx.mcpReq.signal);
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
  - web_env (string, optional): WebEnv cookie of an earlier call. Appends the UIDs to that Web Environment.
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
      inputSchema: EPostInput,
      outputSchema: EPostOutput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runEPost(client, input, ctx.mcpReq.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
