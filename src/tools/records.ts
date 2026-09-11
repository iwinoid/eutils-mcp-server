import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { BATCH_SIZE, DEFAULT_RETMAX, SEQUENCE_DATABASES } from '../constants.js';
import { EutilsError } from '../types.js';
import type { EutilsClient } from '../services/eutilsClient.js';
import {
  errorResult,
  fenceUntrusted,
  pageInfo,
  respond,
  type ToolTextResult,
} from '../services/formatters.js';
import { chunk, validateRetmax } from '../services/validate.js';
import { parseEsummary, type CompactRecord } from './parse.js';
import {
  applySource,
  HistorySchema,
  READ_ONLY_ANNOTATIONS,
  resolveDbAndSource,
  ResponseFormatSchema,
  UidSourceShape,
} from './common.js';

const EsummaryInput = z.object({
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

const EfetchInput = z.object({
  db: z
    .string()
    .optional()
    .describe('Entrez database, for example "pubmed". May be omitted when history is given.'),
  ...UidSourceShape,
  rettype: z
    .string()
    .optional()
    .describe(
      'Record format. Defaults to "abstract" for pubmed and "fasta" for sequence databases. Other databases need an explicit value, for example "gb" or "docsum".',
    ),
  retmode: z
    .enum(['text', 'xml'])
    .optional()
    .describe('Response encoding. Default "text", which is what you want for abstracts and FASTA.'),
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

const EsummaryOutput = z.looseObject({
  database: z.string(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  batches: z.number().optional().describe('Present when the UID list needed more than one request.'),
  records: z.array(z.looseObject({ uid: z.string(), title: z.string().optional() })),
});

const EfetchOutput = z.looseObject({
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

  // Any remaining scalar fields, for non-PubMed databases.
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

async function runEsummary(
  client: EutilsClient,
  input: z.infer<typeof EsummaryInput>,
): Promise<ToolTextResult> {
  const source = resolveDbAndSource(input);
  const db = source.db;
  const retstart = input.retstart ?? 0;

  const batches =
    source.id !== undefined ? chunk(source.id.split(','), BATCH_SIZE) : [null as string[] | null];

  const allRecords: CompactRecord[] = [];
  let total = source.count ?? 0;

  for (const batch of batches) {
    const params: Record<string, unknown> = { retmode: 'json' };
    if (batch === null) {
      applySource(params, source);
      params['retstart'] = retstart;
      params['retmax'] = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'esummary');
    } else {
      params['db'] = db;
      params['id'] = batch.join(',');
    }

    const res = await client.request({ endpoint: 'esummary.fcgi', params });
    const { uids, records } = parseEsummary(res.json, db);
    allRecords.push(...records);

    if (batches.length === 1) total = source.count ?? uids.length;
  }

  const offset = source.id !== undefined ? 0 : retstart;
  const page = pageInfo(total === 0 ? allRecords.length : total, allRecords.length, offset);

  const structured = {
    database: db,
    ...page,
    ...(batches.length > 1 ? { batches: batches.length } : {}),
    records: allRecords,
  };

  const markdown = [
    `# ESummary: ${allRecords.length} summary record(s) from \`${db}\``,
    '',
    total > 0 ? `${total.toLocaleString('en-US')} record(s) in this set.` : '',
    batches.length > 1 ? `Fetched in ${batches.length} batches of up to ${BATCH_SIZE} UIDs.` : '',
    '',
    allRecords.length > 0
      ? allRecords.map(renderRecordMarkdown).join('\n\n')
      : `No summaries found for these UIDs in \`${db}\`. Check the UIDs, or confirm the database with \`eutils_einfo\`.`,
    '',
    page.has_more
      ? `Next: call again with retstart=${page.next_offset} to see more.`
      : 'Next: call `eutils_efetch` with the UIDs you want in full.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

/** Choose a sensible default record format for a database. */
export function defaultRettype(db: string, requested: string | undefined): string {
  if (requested) return requested;
  if (db === 'pubmed') return 'abstract';
  if (SEQUENCE_DATABASES.includes(db)) return 'fasta';

  throw new EutilsError(
    'validation',
    `No default record format is defined for database '${db}'.`,
    'Pass rettype explicitly, for example "gb" for nuccore, "docsum" for a summary-style record, or "xml" for the native record.',
  );
}

async function runEfetch(client: EutilsClient, input: z.infer<typeof EfetchInput>): Promise<ToolTextResult> {
  const source = resolveDbAndSource(input);
  const db = source.db;
  const rettype = defaultRettype(db, input.rettype);
  const retmode = input.retmode ?? 'text';
  const retstart = input.retstart ?? 0;

  const batches = source.id !== undefined ? chunk(source.id.split(','), BATCH_SIZE) : [null];

  const parts: string[] = [];
  let total = source.count ?? 0;

  for (const batch of batches) {
    const params: Record<string, unknown> = { rettype, retmode };
    if (batch === null) {
      applySource(params, source);
      params['retstart'] = retstart;
      params['retmax'] = validateRetmax(input.retmax ?? DEFAULT_RETMAX, 'efetch');
    } else {
      params['db'] = db;
      params['id'] = batch.join(',');
    }

    const res = await client.request({ endpoint: 'efetch.fcgi', params });
    const body = res.text.trim();

    if (/^error[:\s]/i.test(body)) {
      throw new EutilsError(
        'validation',
        `EFetch reported: ${body.slice(0, 300)}`,
        'Check that the UIDs exist in this database and that rettype is valid for it. Use eutils_einfo to inspect the database.',
      );
    }

    if (body.length > 0) parts.push(body);
    if (batches.length === 1) total = source.count ?? NaN;
  }

  const body = parts.join('\n\n');
  const recordCount = Number.isNaN(total) ? undefined : total;

  const structured = {
    database: db,
    rettype,
    retmode,
    ...(recordCount !== undefined ? { record_count: recordCount } : {}),
    ...(batches.length > 1 ? { batches: batches.length } : {}),
    text: body,
  };

  const markdown = [
    `# EFetch: \`${db}\` records as ${rettype}/${retmode}`,
    '',
    body.length > 0 ? fenceUntrusted(body) : `No records returned. Verify the UIDs exist in \`${db}\`.`,
    '',
    body.length > 0
      ? 'Next: use `eutils_elink` to find records in other databases linked to these.'
      : 'Next: confirm the UIDs with `eutils_esearch` in the same database.',
  ].join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

/** Register ESummary and EFetch. */
export function registerRecordTools(server: McpServer, client: EutilsClient): void {
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
      inputSchema: EsummaryInput,
      outputSchema: EsummaryOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEsummary(client, input);
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

Defaults are chosen for readability: PubMed returns plain-text abstracts, and
sequence databases return FASTA. Returned record text is external data and is
fenced with an explicit marker.

Args:
  - db (string, optional): database, for example "pubmed". Required unless history is given.
  - uids (string[] | string, optional): UIDs or accession.version identifiers.
  - history (object, optional): handle from eutils_esearch, eutils_epost, or eutils_elink.
  - rettype (string, optional): "abstract" (pubmed default), "fasta" (sequence default),
    "gb", "docsum", "medline", ...
  - retmode ('text' | 'xml', optional): default "text".
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
  - Asks for an explicit rettype when the database has no default
  - Detects an error message returned as record text and reports it as a tool error
  - Refuses retmax above 500; larger sets are batched internally`,
      inputSchema: EfetchInput,
      outputSchema: EfetchOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEfetch(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export { HistorySchema };
