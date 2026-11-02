import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { MAX_CITATION_CHARS, MAX_CITATIONS } from '../constants.js';
import { EUtilsError, type QueryParams } from '../types.js';
import type { EUtilsClient } from '../services/eutilsClient.js';
import { errorResult, respond, type ToolTextResult } from '../services/formatters.js';
import { validateDatabase } from '../services/validate.js';
import { parseECitMatch, parseELink } from './parse.js';
import {
  applySource,
  READ_ONLY_ANNOTATIONS,
  resolveSource,
  ResponseFormatSchema,
  STATEFUL_ANNOTATIONS,
  UidSourceShape,
} from './common.js';

const ELinkInput = z.object({
  dbfrom: z.string().min(1).describe('Source database holding the input UIDs, for example "pubmed".'),
  db: z
    .string()
    .optional()
    .describe(
      'Target database to find links in, for example "pmc". Omit to find related records in the same database.',
    ),
  ...UidSourceShape,
  cmd: z
    .enum([
      'neighbor',
      'neighbor_score',
      'neighbor_history',
      'acheck',
      'ncheck',
      'lcheck',
      'llinks',
      'prlinks',
    ])
    .optional()
    .describe(
      'Link command. "neighbor" returns linked UIDs immediately (default). "neighbor_history" stores them on the History server and returns a handle.',
    ),
  linkname: z
    .string()
    .optional()
    .describe(
      'Specific link to follow, for example "pubmed_pmc". Call eutils_einfo to list valid link names.',
    ),
  response_format: ResponseFormatSchema,
});

const ECitMatchInput = z.object({
  citations: z
    .array(z.string())
    .min(1)
    .describe(
      'Citation strings, each formatted as journal_title|year|volume|first_page|author_name|your_key|. Example: "science|1987|235|182|palmenberg ac|Art2|".',
    ),
  response_format: ResponseFormatSchema,
});

const ELinkOutput = z.looseObject({
  dbfrom: z.string(),
  dbto: z.string().optional(),
  command: z.string(),
  groups_found: z.number(),
  total_linked: z.number(),
  stored_groups: z
    .number()
    .optional()
    .describe('History-backed link groups; their counts are only known after downloading.'),
  groups: z.array(
    z.looseObject({
      dbto: z.string(),
      linkname: z.string(),
      count: z.number(),
      ids: z.array(z.string()),
      query_key: z.string().optional(),
    }),
  ),
  histories: z
    .array(z.looseObject({ db: z.string(), web_env: z.string(), query_key: z.string() }))
    .optional()
    .describe('Present when cmd is neighbor_history.'),
});

const ECitMatchOutput = z.looseObject({
  submitted: z.number(),
  matched: z.number(),
  records: z.array(
    z.looseObject({
      journal: z.string(),
      year: z.string(),
      volume: z.string(),
      first_page: z.string(),
      key: z.string(),
      pmid: z.string(),
      matched: z.boolean(),
    }),
  ),
});

async function runELink(client: EUtilsClient, input: z.infer<typeof ELinkInput>): Promise<ToolTextResult> {
  const dbfrom = validateDatabase(input.dbfrom);
  const dbto = input.db ? validateDatabase(input.db) : undefined;
  const source = resolveSource(input, dbfrom);

  if (source.db !== dbfrom) {
    throw new EUtilsError(
      'validation',
      `history.db '${source.db}' does not match dbfrom '${dbfrom}'.`,
      'Pass a history object whose db equals dbfrom, or omit history and use uids.',
    );
  }

  const params: QueryParams = { dbfrom, db: dbto ?? dbfrom, retmode: 'json' };
  if (input.cmd) params['cmd'] = input.cmd;
  if (input.linkname) params['linkname'] = input.linkname;
  applySource(params, source, { setDb: false });

  const res = await client.request({ endpoint: 'elink.fcgi', params });
  const { groups, histories } = parseELink(res.json);

  const totalLinked = groups.reduce((sum, group) => sum + group.count, 0);

  const structured = {
    dbfrom,
    ...(dbto ? { dbto } : {}),
    command: input.cmd ?? 'neighbor',
    groups_found: groups.length,
    total_linked: totalLinked,
    ...(groups.some((group) => group.query_key !== undefined)
      ? { stored_groups: groups.filter((group) => group.query_key !== undefined).length }
      : {}),
    groups,
    ...(histories.length > 0 ? { histories } : {}),
  };

  const markdown = [
    `# ELink: \`${dbfrom}\`${dbto ? ` → \`${dbto}\`` : ' (same database)'}`,
    '',
    groups.length === 0
      ? `No links found for these UIDs. Try \`eutils_einfo\` with db="${dbfrom}" to list available link names.`
      : groups.every((group) => group.query_key !== undefined)
        ? `${groups.length} link group(s) stored on the History server. The linked UID count is only known after downloading.`
        : `${groups.length} link group(s), ${totalLinked.toLocaleString('en-US')} linked UID(s) in total.`,
    '',
    groups
      .map((group) => {
        const header = `## ${group.linkname} → **${group.dbto}**`;
        if (group.query_key) {
          return `${header}\n\nStored on the History server with query_key \`${group.query_key}\`.`;
        }
        const shown = group.ids.slice(0, 50).join(', ');
        const suffix = group.ids.length > 50 ? ` … (${group.ids.length} total)` : '';
        return `${header}\n\n${shown}${suffix}`;
      })
      .join('\n\n'),
    '',
    histories.length > 0
      ? [
          '## History handles',
          '',
          histories.map((history) => `- \`${JSON.stringify(history)}\``).join('\n'),
          '',
          'Pass one of these as the `history` argument of `eutils_esummary` or `eutils_efetch` to download the linked records.',
        ].join('\n')
      : groups.length > 0
        ? `Next: pass these UIDs to \`eutils_esummary\` with db="${groups[0]!.dbto}".`
        : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

async function runECitMatch(
  client: EUtilsClient,
  input: z.infer<typeof ECitMatchInput>,
): Promise<ToolTextResult> {
  const cleaned = input.citations
    .map((citation) => citation.trim())
    .filter((citation) => citation.length > 0);

  if (cleaned.length === 0) {
    throw new EUtilsError(
      'validation',
      'No citation strings were supplied.',
      'Pass at least one string formatted as journal|year|volume|first_page|author|key|.',
    );
  }
  if (cleaned.length > MAX_CITATIONS) {
    throw new EUtilsError(
      'validation',
      `The call contains ${cleaned.length} citations, over the ${MAX_CITATIONS}-citation ceiling.`,
      'Split the citations into smaller calls.',
    );
  }
  const tooLong = cleaned.find((citation) => citation.length > MAX_CITATION_CHARS);
  if (tooLong !== undefined) {
    throw new EUtilsError(
      'validation',
      `Citation string is over the ${MAX_CITATION_CHARS}-character ceiling.`,
      'Shorten the citation fields; each one should be a single line.',
    );
  }

  const malformed = cleaned.filter((citation) => citation.split('|').length < 6);
  if (malformed.length > 0) {
    throw new EUtilsError(
      'validation',
      `Citation string is missing fields: "${malformed[0]}"`,
      'Each citation needs five pipe-separated fields plus a key: journal|year|volume|first_page|author|key|.',
    );
  }

  // NCBI wants the citation strings separated by carriage returns.
  const bdata = cleaned.map((citation) => (citation.endsWith('|') ? citation : `${citation}|`)).join('\r');

  const res = await client.request({
    endpoint: 'ecitmatch.cgi',
    params: { db: 'pubmed', retmode: 'xml', bdata },
    method: 'POST',
  });

  const records = parseECitMatch(res.text, cleaned);

  const matched = records.filter((record) => record.matched);

  const structured = {
    submitted: cleaned.length,
    matched: matched.length,
    records,
  };

  const markdown = [
    `# ECitMatch: ${matched.length} of ${cleaned.length} citation(s) resolved`,
    '',
    records
      .map((record) =>
        record.matched
          ? `- **${record.key || record.journal}** → PMID **${record.pmid}** (${record.journal} ${record.year};${record.volume}:${record.first_page})`
          : `- **${record.key || record.journal}** → no match (${record.journal} ${record.year};${record.volume}:${record.first_page})`,
      )
      .join('\n'),
    '',
    matched.length > 0
      ? `Next: call \`eutils_esummary\` with db="pubmed" and uids=[${matched.map((r) => `"${r.pmid}"`).join(', ')}].`
      : 'Next: check the citation fields. Volume, first page, and author surname must match the published record.',
  ].join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

/** Register ELink and ECitMatch. */
export function registerLinkTools(server: McpServer, client: EUtilsClient): void {
  server.registerTool(
    'eutils_elink',
    {
      title: 'Entrez Cross-Database Links',
      description: `Find records linked to a set of UIDs, either in another database or within the same one.

This is how you move between databases: gene to protein, pubmed to pmc, nucleotide
to snp, and so on. With cmd="neighbor_history" the linked set is stored on the NCBI
History server and returned as a handle you can feed straight into eutils_efetch.

Args:
  - dbfrom (string): source database, for example "pubmed".
  - db (string, optional): target database, for example "pmc". Omit for same-database links.
  - uids (string[] | string, optional): source UIDs.
  - history (object, optional): handle whose db matches dbfrom.
  - cmd (string, optional): "neighbor" (default), "neighbor_score", "neighbor_history", "acheck", "ncheck", "lcheck", "llinks", "prlinks".
  - linkname (string, optional): a specific link, for example "pubmed_pmc". Use eutils_einfo to list them.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Supply either uids or history, never both.

Returns:
  { dbfrom, dbto?, command, groups_found, total_linked,
    groups: [{ dbto, linkname, count, ids[], query_key? }], histories? }

Examples:
  - Use when: "which PMC articles correspond to these PMIDs?" -> dbfrom="pubmed", db="pmc"
  - Use when: "find proteins for these gene IDs" -> dbfrom="gene", db="protein"
  - Use when: chaining a download -> cmd="neighbor_history", then pass histories to eutils_efetch
  - Don't use when: you want records, not UID lists (use eutils_link_then_fetch)

Error Handling:
  - Rejects a history whose db does not match dbfrom
  - Returns an empty result with a hint to list valid link names via eutils_einfo`,
      inputSchema: ELinkInput,
      outputSchema: ELinkOutput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runELink(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'eutils_ecitmatch',
    {
      title: 'Batch Citation to PMID Lookup',
      description: `Resolve formatted citation strings to PubMed IDs.

Use this when you have a reference list but no PMIDs. It is far more reliable than
free-text searching for a specific article.

Args:
  - citations (string[]): each string formatted as
    journal_title|year|volume|first_page|author_name|your_key|
    A trailing pipe is optional and is added for you.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { submitted, matched,
    records: [{ input, journal, year, volume, first_page, author, key, pmid, matched }] }

Examples:
  - Use when: "find the PMID for Mann BJ, Proc Natl Acad Sci USA 1991;88:3248"
    -> citations=["proc natl acad sci u s a|1991|88|3248|mann bj|Art1|"]
  - Use when: converting a bibliography into PMIDs before fetching abstracts
  - Don't use when: you are searching by topic (use eutils_esearch)

Error Handling:
  - Rejects a citation string with fewer than six pipe-separated fields
  - Reports matched=false per citation when NCBI finds no corresponding record`,
      inputSchema: ECitMatchInput,
      outputSchema: ECitMatchOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runECitMatch(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
