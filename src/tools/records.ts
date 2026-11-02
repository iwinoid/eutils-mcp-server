import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { BATCH_SIZE, DEFAULT_RETMAX } from '../constants.js';
import { EUtilsError, type QueryParams } from '../types.js';
import type { EUtilsClient } from '../services/eutilsClient.js';
import { EUTILS_PARAM } from '../services/eutilsParams.js';
import { resolveFetchFormat, resolveSequenceOptions } from '../services/fetchFormats.js';
import { errorResult, fenceUntrusted, respond, type ToolTextResult } from '../services/formatters.js';
import { chunk, validateRetmax } from '../services/validate.js';
import { parseESummary, type CompactRecord } from './parse.js';
import {
  applySource,
  HistorySchema,
  READ_ONLY_ANNOTATIONS,
  resolveDbAndSource,
  ResponseFormatSchema,
  UidSourceShape,
} from './common.js';
const ESummaryInput = z.object({
  db: z
    .string()
    .optional()
    .describe('Entrez database, for example "pubmed". May be omitted when history is given.'),
  ...UidSourceShape,
  retstart: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Index of the first summary to return. Use with history.'),
  retmax: z
    .number()
    .int()
    .min(1)
    .max(BATCH_SIZE, `retmax must be ${BATCH_SIZE} or fewer. Page with retstart, or split the UID list.`)
    .optional()
    .describe(
      `Maximum summaries to return when using history (default ${DEFAULT_RETMAX}, max ${BATCH_SIZE}).`,
    ),
  response_format: ResponseFormatSchema,
});
const EFetchInput = z.object({
  db: z
    .string()
    .optional()
    .describe('Entrez database, for example "pubmed". May be omitted when history is given.'),
  ...UidSourceShape,
  rettype: z
    .string()
    .optional()
    .describe(
      'Record format. When omitted, PubMed returns abstracts, sequence databases return FASTA, and other databases use their native default.',
    ),
  retmode: z
    .enum(['text', 'xml', 'asn.1'])
    .optional()
    .describe(
      'Response encoding. When omitted, the database default applies; PubMed and sequence databases are sent as text. asn.1 is textual only; binary ASN.1 for sequence databases is rejected.',
    ),
  strand: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe('Sequence strand: 1 for plus, 2 for minus. Only for nuccore and nucleotide.'),
  seq_start: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('First sequence base to return, 1-based. Requires a sequence database.'),
  seq_stop: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Last sequence base to return. Requires a sequence database and must not precede seq_start.'),
  complexity: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe('Sequence record content: 0 returns the entire blob, 4 the minimal publication set.'),
  retstart: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Index of the first record to return. Use with history.'),
  retmax: z
    .number()
    .int()
    .min(1)
    .max(BATCH_SIZE, `retmax must be ${BATCH_SIZE} or fewer. Page with retstart, or split the UID list.`)
    .optional()
    .describe(`Maximum records to return when using history (default ${DEFAULT_RETMAX}, max ${BATCH_SIZE}).`),
  response_format: ResponseFormatSchema,
});
const ESummaryOutput = z.looseObject({
  database: z.string(),
  total: z
    .number()
    .optional()
    .describe(
      'Total records in the set when known; omitted for History reads because ESummary does not report a total.',
    ),
  count: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  batches: z.number().optional().describe('Present when the UID list needed more than one request.'),
  records: z.array(z.looseObject({ uid: z.string(), title: z.string().optional() })),
});
const EFetchOutput = z.looseObject({
  database: z.string(),
  rettype: z.string(),
  retmode: z.string(),
  record_count: z.number().optional(),
  batches: z.number().optional(),
  text: z.string().describe('Raw record text. The markdown rendering fences it as external data.'),
});
function renderRecordMarkdown(record: CompactRecord, index: number): string {
  const title = typeof record['title'] === 'string' ? record['title'] : '(no title)';
  const lines = [`### ${index + 1}. ${title}`, '', `- **UID**: ${record['uid']}`];
  const authors = record['authors'];
  if (Array.isArray(authors) && authors.length > 0) {
    const shown = authors.slice(0, 6).join(', ');
    lines.push(`- **Authors**: ${shown}${authors.length > 6 ? `, et al. (${authors.length} total)` : ''}`);
  }
  for (const key of ['journal', 'pubdate', 'volume', 'issue', 'pages', 'doi', 'pmcid']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      lines.push(`- **${key}**: ${value}`);
    }
  }
  const pubtype = record['pubtype'];
  if (Array.isArray(pubtype) && pubtype.length > 0) {
    lines.push(`- **Type**: ${pubtype.join('; ')}`);
  }
  const known = new Set([
    'uid',
    'title',
    'authors',
    'journal',
    'pubdate',
    'volume',
    'issue',
    'pages',
    'doi',
    'pmcid',
    'pubtype',
    'lang',
    'source',
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (known.has(key)) continue;
    if (typeof value === 'string') lines.push(`- **${key}**: ${value}`);
    else if (Array.isArray(value)) lines.push(`- **${key}**: ${value.join('; ')}`);
  }
  return lines.join('\n');
}
async function runESummary(
  client: EUtilsClient,
  input: z.infer<typeof ESummaryInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const source = resolveDbAndSource(input);
  const db = source.db;
  const retstart = input.retstart ?? 0;
  const batches =
    source.id !== undefined ? chunk(source.id.split(','), BATCH_SIZE) : [null as string[] | null];
  const allRecords: CompactRecord[] = [];
  const pageSize = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'esummary');
  for (const batch of batches) {
    const params: QueryParams = { retmode: 'json' };
    if (batch === null) {
      applySource(params, source);
      params['retstart'] = retstart;
      params['retmax'] = pageSize;
    } else {
      params['db'] = db;
      params['id'] = batch.join(',');
    }
    const res = await client.request({ endpoint: 'esummary.fcgi', params, signal });
    const { records } = parseESummary(res.json, db);
    allRecords.push(...records);
  }
  const offset = source.id !== undefined ? 0 : retstart;
  const count = allRecords.length;
  const total = source.id !== undefined ? count : undefined;
  const hasMore = source.id === undefined && pageSize > 0 && count === pageSize;
  const nextOffset = hasMore ? retstart + count : undefined;
  const structured = {
    database: db,
    ...(total !== undefined ? { total } : {}),
    count,
    offset,
    has_more: hasMore,
    ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
    ...(batches.length > 1 ? { batches: batches.length } : {}),
    records: allRecords,
  };
  const markdown = [
    `# ESummary: ${allRecords.length} summary record(s) from \`${db}\``,
    '',
    total !== undefined
      ? `${total.toLocaleString('en-US')} record(s) in this set.`
      : count > 0
        ? `Showing ${count} summary record(s) starting at ${offset}. A full page can mean more are available.`
        : '',
    batches.length > 1 ? `Fetched in ${batches.length} batches of up to ${BATCH_SIZE} UIDs.` : '',
    '',
    allRecords.length > 0
      ? allRecords.map(renderRecordMarkdown).join('\n\n')
      : `No summaries found for these UIDs in \`${db}\`. Check the UIDs, or confirm the database with \`eutils_einfo\`.`,
    '',
    hasMore
      ? `Next: call again with retstart=${nextOffset} to see more.`
      : 'Next: call `eutils_efetch` with the UIDs you want in full.',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return respond({ structured, markdown, format: input.response_format });
}
async function runEFetch(
  client: EUtilsClient,
  input: z.infer<typeof EFetchInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const source = resolveDbAndSource(input);
  const db = source.db;
  const format = resolveFetchFormat(db, input.rettype, input.retmode);
  const sequence = resolveSequenceOptions(db, {
    strand: input.strand,
    seq_start: input.seq_start,
    seq_stop: input.seq_stop,
    complexity: input.complexity,
  });
  const retstart = input.retstart ?? 0;
  const pageSize = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'efetch');
  const singleRecord = source.id !== undefined ? source.count === 1 : pageSize === 1;
  const batches = source.id !== undefined ? chunk(source.id.split(','), BATCH_SIZE) : [null];
  const parts: string[] = [];
  const formatParams: QueryParams = {};
  if (format.rettype !== undefined) formatParams[EUTILS_PARAM.retType] = format.rettype;
  if (format.retmode !== undefined) formatParams[EUTILS_PARAM.retMode] = format.retmode;
  if (sequence.strand !== undefined) formatParams[EUTILS_PARAM.strand] = sequence.strand;
  if (sequence.seq_start !== undefined) formatParams[EUTILS_PARAM.seqStart] = sequence.seq_start;
  if (sequence.seq_stop !== undefined) formatParams[EUTILS_PARAM.seqStop] = sequence.seq_stop;
  if (sequence.complexity !== undefined) formatParams[EUTILS_PARAM.complexity] = sequence.complexity;
  for (const batch of batches) {
    const params: QueryParams = { ...formatParams };
    if (batch === null) {
      applySource(params, source);
      params['retstart'] = retstart;
      params['retmax'] = pageSize;
    } else {
      params['db'] = db;
      params['id'] = batch.join(',');
    }
    const res = await client.request({ endpoint: 'efetch.fcgi', params, signal });
    const body = res.text.trim();
    if (/^error[:\s]/i.test(body)) {
      throw new EUtilsError(
        'validation',
        `EFetch reported: ${body.slice(0, 300)}`,
        'Check that the UIDs exist in this database and that rettype is valid for it. Use eutils_einfo to inspect the database.',
      );
    }
    if (body.length > 0) parts.push(body);
  }
  const body = parts.join('\n\n');
  const recordCount = source.id !== undefined ? source.count : undefined;
  const structured = {
    database: db,
    rettype: format.rettype ?? 'default',
    retmode: format.retmode ?? 'default',
    ...(recordCount !== undefined ? { record_count: recordCount } : {}),
    ...(batches.length > 1 ? { batches: batches.length } : {}),
    text: body,
  };
  const markdown = [
    `# EFetch: \`${db}\` records (${format.label})`,
    '',
    body.length > 0 ? fenceUntrusted(body) : `No records returned. Verify the UIDs exist in \`${db}\`.`,
    '',
    body.length > 0
      ? 'Next: use `eutils_elink` to find records in other databases linked to these.'
      : 'Next: confirm the UIDs with `eutils_esearch` in the same database.',
  ].join('\n');
  return respond({
    structured,
    markdown,
    format: input.response_format,
    ...(singleRecord
      ? {
          truncate: {
            strategy: 'head-tail' as const,
            guidance:
              'This is a single record larger than the limit: retstart pages between records, ' +
              'not within one. Read the abstract first (rettype="abstract" for pubmed), ' +
              'or fetch fewer records per call.',
          },
        }
      : {}),
  });
}
export function registerRecordTools(server: McpServer, client: EUtilsClient): void {
  server.registerTool(
    'eutils_esummary',
    {
      title: 'Entrez Document Summaries',
      description: `Fetch compact summaries (DocSums) for a set of UIDs.

Use this to screen records by title, authors, journal, and date before paying the
cost of downloading full records.

Args:
  - db (string, optional): database, for example "pubmed". Required unless history is given.
  - uids (string[] | string, optional): UIDs or accessions.
  - history (object, optional): handle from eutils_esearch, eutils_epost, or eutils_elink.
  - retstart (number, optional): first record index, for history sets. Default 0.
  - retmax (number, optional): records to return for a history set. Default 20, max 500.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Supply either uids or history, never both.

Returns:
  { database, total, count, offset, has_more, next_offset?, batches?,
    records: [{ uid, title, authors[], journal, source, pubdate, volume, issue,
                pages, doi?, pmcid?, pubtype[], lang[] }] }

  Non-PubMed databases return whichever scalar fields the DocSum carries.

Examples:
  - Use when: "show me the titles of these PMIDs" -> db="pubmed", uids=["31452104"]
  - Use when: screening a large result set -> pass history from eutils_esearch
  - Don't use when: you need the full abstract or sequence (use eutils_efetch)

Error Handling:
  - Refuses more than 500 UIDs per call and batches larger lists internally
  - Refuses to combine uids and history in one call
  - Rejects retmax above 500 rather than silently truncating`,
      inputSchema: ESummaryInput,
      outputSchema: ESummaryOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runESummary(client, input, ctx.mcpReq.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'eutils_efetch',
    {
      title: 'Entrez Full Records',
      description: `Download full records in a chosen format.

Defaults follow the database: PubMed returns plain-text abstracts, sequence
databases return FASTA, and every other database uses its native default format
(PMC returns XML). Returned record text is external data and is fenced with an
explicit marker.

Args:
  - db (string, optional): database, for example "pubmed". Required unless history is given.
  - uids (string[] | string, optional): UIDs or accession.version identifiers.
  - history (object, optional): handle from eutils_esearch, eutils_epost, or eutils_elink.
  - rettype (string, optional): explicit record format, for example "abstract", "fasta",
    "gb", "docsum", or "medline". Omit for the database default.
  - retmode ('text' | 'xml' | 'asn.1', optional): response encoding. Omit for the database default.
  - strand (1 | 2, optional): sequence strand. Only for nuccore and nucleotide.
  - seq_start, seq_stop (number, optional): 1-based base range for sequence databases.
  - complexity (0 | 1 | 2 | 3 | 4, optional): amount of sequence record content.
  - retstart (number, optional): first record index, for history sets.
  - retmax (number, optional): records to return for a history set. Default 20, max 500.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Supply either uids or history, never both.

Returns:
  { database, rettype, retmode, record_count?, batches?, text }

Examples:
  - Use when: "give me the abstract for PMID 31452104" -> db="pubmed", uids=["31452104"]
  - Use when: "fetch the protein sequence" -> db="protein", uids=["NP_005537.3"], rettype="fasta"
  - Use when: downloading a large set -> pass history and page with retstart/retmax
  - Don't use when: you only need titles and dates (use eutils_esummary, which is far cheaper)

Error Handling:
  - Rejects sequence options outside sequence databases, strand outside nuccore/nucleotide,
    and seq_stop before seq_start
  - Detects an error message returned as record text and reports it as a tool error
  - Refuses retmax above 500; larger sets are batched internally`,
      inputSchema: EFetchInput,
      outputSchema: EFetchOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runEFetch(client, input, ctx.mcpReq.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
export { HistorySchema };
