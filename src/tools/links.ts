import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { MAX_CITATION_CHARS, MAX_CITATIONS } from '../constants.js';
import { EUtilsError, type HistoryRef, type QueryParams } from '../types.js';
import type { EUtilsClient } from '../services/eutilsClient.js';
import { errorResult, respond, type ToolTextResult } from '../services/formatters.js';
import { validateDatabase } from '../services/validate.js';
import {
  parseECitMatch,
  parseELink,
  type AvailableLink,
  type LinkCheck,
  type LinkGroup,
  type ProviderLink,
} from './parse.js';
import {
  applySource,
  READ_ONLY_ANNOTATIONS,
  requireTerm,
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
      'Target database to find links in, for example "pmc". Omit to link within dbfrom. Only the neighbor commands and acheck accept a target database; ncheck accepts only db=dbfrom, and lcheck, llinks, and prlinks reject db.',
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
      'Link command. "neighbor" returns linked UIDs immediately (default). "neighbor_score" adds similarity scores for a same-database link. "neighbor_history" stores them on the History server and returns a handle. "acheck" lists available link names, "ncheck" checks same-database links, "lcheck" checks LinkOut availability, "llinks" lists LinkOut URLs, and "prlinks" lists primary LinkOut providers.',
    ),
  linkname: z
    .string()
    .optional()
    .describe(
      'Specific link to follow, for example "pubmed_pmc". Only with cmd="neighbor" or cmd="neighbor_history". Call eutils_einfo to list valid link names.',
    ),
  term: z
    .string()
    .optional()
    .describe(
      'Entrez query that limits the linked UID set. Only with a same-database link: cmd="neighbor", "neighbor_score", or "neighbor_history", with db omitted or equal to dbfrom.',
    ),
  holding: z
    .string()
    .optional()
    .describe('LinkOut provider abbreviation, for example "CTgov". Only with cmd="llinks".'),
  idtype: z
    .enum(['acc'])
    .optional()
    .describe(
      'Return accession.version identifiers instead of GI numbers for sequence databases. Only "acc" is supported.',
    ),
  datetype: z
    .enum(['pdat', 'edat', 'mdat'])
    .optional()
    .describe(
      'Date field for reldate or mindate/maxdate. Only with cmd="neighbor" or cmd="neighbor_history" and dbfrom="pubmed".',
    ),
  reldate: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Only include linked records with a datetype date in the last N days.'),
  mindate: z
    .string()
    .optional()
    .describe('Start of a datetype date range, as YYYY, YYYY/MM, or YYYY/MM/DD. Requires maxdate.'),
  maxdate: z
    .string()
    .optional()
    .describe('End of a datetype date range, as YYYY, YYYY/MM, or YYYY/MM/DD. Requires mindate.'),
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
      scores: z
        .array(z.number().nullable())
        .optional()
        .describe('Similarity score per linked UID for cmd="neighbor_score"; null when none was returned.'),
      query_key: z.string().optional(),
    }),
  ),
  available_links: z
    .array(
      z.looseObject({
        dbto: z.string(),
        linkname: z.string(),
        menu_tag: z.string().optional(),
        html_tag: z.string().optional(),
      }),
    )
    .optional()
    .describe('Link names available for these UIDs. Present when cmd is acheck.'),
  link_checks: z
    .array(
      z.looseObject({
        uid: z.string(),
        has_linkout: z.boolean().optional(),
        has_neighbor: z.boolean().optional(),
      }),
    )
    .optional()
    .describe('Per-UID link existence flags. Present when cmd is lcheck or ncheck.'),
  provider_links: z
    .array(
      z.looseObject({
        uid: z.string(),
        urls: z.array(
          z.looseObject({
            url: z.string(),
            provider: z.string().optional(),
            provider_abbr: z.string().optional(),
            categories: z.array(z.string()),
            attributes: z.array(z.string()),
          }),
        ),
      }),
    )
    .optional()
    .describe('LinkOut provider URLs and attributes. Present when cmd is llinks or prlinks.'),
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
const LINK_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
const HOLDING_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const LINK_NAME_COMMANDS = new Set(['neighbor', 'neighbor_history']);
const TERM_COMMANDS = new Set(['neighbor', 'neighbor_score', 'neighbor_history']);
const DATE_COMMANDS = new Set(['neighbor', 'neighbor_history']);
function validateLinkName(value: string): string {
  const linkname = value.trim();
  if (!LINK_NAME_PATTERN.test(linkname)) {
    throw new EUtilsError(
      'validation',
      `'${value}' is not a valid ELink link name.`,
      'Use a lowercase name of the form dbfrom_db_subset, for example "pubmed_pmc". Call eutils_einfo to list link names.',
    );
  }
  return linkname;
}
function validateHolding(value: string): string {
  const holding = value.trim();
  if (!HOLDING_PATTERN.test(holding)) {
    throw new EUtilsError(
      'validation',
      `'${value}' is not a valid LinkOut provider abbreviation.`,
      'Use the provider abbreviation shown in the ELink output, for example "CTgov".',
    );
  }
  return holding;
}
interface ELinkReport {
  dbfrom: string;
  dbto?: string;
  command: string;
  groups: readonly LinkGroup[];
  availableLinks: readonly AvailableLink[];
  linkChecks: readonly LinkCheck[];
  providerLinks: readonly ProviderLink[];
  totalLinked: number;
}
function elinkHeading(report: ELinkReport): string {
  switch (report.command) {
    case 'acheck':
      return `# ELink acheck: \`${report.dbfrom}\`${report.dbto ? ` → \`${report.dbto}\`` : ' (all targets)'}`;
    case 'neighbor':
    case 'neighbor_score':
    case 'neighbor_history':
      return `# ELink: \`${report.dbfrom}\`${report.dbto && report.dbto !== report.dbfrom ? ` → \`${report.dbto}\`` : ' (same database)'}`;
    default:
      return `# ELink ${report.command}: \`${report.dbfrom}\``;
  }
}
function elinkSummary(report: ELinkReport): string {
  switch (report.command) {
    case 'acheck': {
      const targets = new Set(report.availableLinks.map((link) => link.dbto));
      return `${report.availableLinks.length} link name(s) available across ${targets.size} target database(s).`;
    }
    case 'lcheck':
    case 'ncheck': {
      const field = report.command === 'lcheck' ? 'has_linkout' : 'has_neighbor';
      const found = report.linkChecks.filter((check) => check[field] === true).length;
      return report.command === 'lcheck'
        ? `${report.linkChecks.length} UID(s) checked; ${found} have LinkOut providers.`
        : `${report.linkChecks.length} UID(s) checked; ${found} have related records.`;
    }
    case 'llinks':
    case 'prlinks': {
      const urlCount = report.providerLinks.reduce((sum, link) => sum + link.urls.length, 0);
      return `${report.providerLinks.length} UID(s) with ${urlCount} provider link(s).`;
    }
    default: {
      if (report.groups.length > 0 && report.groups.every((group) => group.query_key !== undefined)) {
        return `${report.groups.length} link group(s) stored on the History server. The linked UID count is only known after downloading.`;
      }
      const scoreNote = report.groups.some((group) => group.scores !== undefined)
        ? ' Similarity scores are attached to each linked UID.'
        : '';
      return `${report.groups.length} link group(s), ${report.totalLinked.toLocaleString('en-US')} linked UID(s) in total.${scoreNote}`;
    }
  }
}
function elinkNextStep(report: ELinkReport): string {
  switch (report.command) {
    case 'acheck':
      return report.availableLinks.length > 0
        ? 'Next: pass one of these link names as `linkname` with cmd="neighbor" or cmd="neighbor_history".'
        : '';
    case 'lcheck':
      return report.linkChecks.length > 0
        ? 'Next: call cmd="llinks" to list the LinkOut URLs for these UIDs.'
        : '';
    case 'ncheck':
      return report.linkChecks.length > 0
        ? `Next: call cmd="neighbor" to fetch the related UIDs, for example with db="${report.dbfrom}".`
        : '';
    case 'llinks':
    case 'prlinks':
      return report.providerLinks.length > 0
        ? 'Next: fetch the same UIDs with `eutils_efetch` for record detail, or open a provider URL.'
        : '';
    default:
      if (report.groups.length === 0) return '';
      if (report.groups.every((group) => group.query_key !== undefined)) {
        return 'Pass one of these as the `history` argument of `eutils_esummary` or `eutils_efetch` to download the linked records.';
      }
      return `Next: pass these UIDs to \`eutils_esummary\` with db="${report.groups[0]?.dbto ?? report.dbfrom}".`;
  }
}
function groupBlock(group: LinkGroup): string {
  const header = `## ${group.linkname} → **${group.dbto}**`;
  if (group.query_key) {
    return `${header}\n\nStored on the History server with query_key \`${group.query_key}\`.`;
  }
  const shown = group.ids
    .slice(0, 50)
    .map((id, index) => {
      const score = group.scores?.[index];
      return score !== undefined && score !== null ? `${id} (score ${score})` : id;
    })
    .join(', ');
  const suffix = group.ids.length > 50 ? ` … (${group.ids.length} total)` : '';
  return `${header}\n\n${shown}${suffix}`;
}
function availableLinkBlock(links: readonly AvailableLink[]): string {
  const byDb = new Map<string, AvailableLink[]>();
  for (const link of links) {
    const target = byDb.get(link.dbto);
    if (target) target.push(link);
    else byDb.set(link.dbto, [link]);
  }
  const blocks: string[] = [];
  for (const [dbto, entries] of byDb) {
    const items = entries.map(
      (entry) => `- \`${entry.linkname}\`${entry.menu_tag ? ` — ${entry.menu_tag}` : ''}`,
    );
    blocks.push([`### → **${dbto}**`, '', items.join('\n')].join('\n'));
  }
  return ['## Available links', '', blocks.join('\n\n')].join('\n');
}
function linkCheckBlock(checks: readonly LinkCheck[], command: string): string {
  const heading = command === 'lcheck' ? '## LinkOut checks' : '## Neighbor checks';
  const rows = checks.map((check) => {
    const facts: string[] = [];
    if (check.has_linkout !== undefined) facts.push(`LinkOut: ${check.has_linkout ? 'yes' : 'no'}`);
    if (check.has_neighbor !== undefined) facts.push(`Neighbor: ${check.has_neighbor ? 'yes' : 'no'}`);
    return `- **${check.uid}**${facts.length > 0 ? `: ${facts.join('; ')}` : ''}`;
  });
  return [heading, '', rows.join('\n')].join('\n');
}
function providerLinkBlock(links: readonly ProviderLink[]): string {
  const blocks = links.map((link) => {
    const items = link.urls.map((entry) => {
      const providerParts: string[] = [];
      if (entry.provider) providerParts.push(entry.provider);
      if (entry.provider_abbr) providerParts.push(`(${entry.provider_abbr})`);
      const provider = providerParts.join(' ');
      const facts = [...entry.categories, ...entry.attributes];
      const label = provider.length > 0 ? `**${provider}**: ` : '';
      const details = facts.length > 0 ? ` — ${facts.join('; ')}` : '';
      return `- ${label}${entry.url}${details}`;
    });
    return [`### UID ${link.uid}`, '', items.join('\n')].join('\n');
  });
  return ['## Provider links', '', blocks.join('\n\n')].join('\n');
}
function historyBlock(histories: readonly HistoryRef[]): string {
  return [
    '## History handles',
    '',
    histories.map((history) => `- \`${JSON.stringify(history)}\``).join('\n'),
  ].join('\n');
}
async function runELink(
  client: EUtilsClient,
  input: z.infer<typeof ELinkInput>,
  signal?: AbortSignal,
): Promise<ToolTextResult> {
  const dbfrom = validateDatabase(input.dbfrom);
  const dbto = input.db ? validateDatabase(input.db) : undefined;
  const command = input.cmd ?? 'neighbor';
  const source = resolveSource(input, dbfrom);
  if (source.db !== dbfrom) {
    throw new EUtilsError(
      'validation',
      `history.db '${source.db}' does not match dbfrom '${dbfrom}'.`,
      'Pass a history object whose db equals dbfrom, or omit history and use uids.',
    );
  }
  const params: QueryParams = { dbfrom, retmode: 'json' };
  if (input.linkname !== undefined) {
    if (!LINK_NAME_COMMANDS.has(command)) {
      throw new EUtilsError(
        'validation',
        `cmd="${command}" does not accept linkname.`,
        'Use linkname only with cmd="neighbor" or cmd="neighbor_history".',
      );
    }
    params['linkname'] = validateLinkName(input.linkname);
  }
  if (input.term !== undefined) {
    if (!TERM_COMMANDS.has(command)) {
      throw new EUtilsError(
        'validation',
        `cmd="${command}" does not accept term.`,
        'Use term only with cmd="neighbor", cmd="neighbor_score", or cmd="neighbor_history".',
      );
    }
    if (dbto !== undefined && dbto !== dbfrom) {
      throw new EUtilsError(
        'validation',
        `term requires a same-database link, but db '${dbto}' differs from dbfrom '${dbfrom}'.`,
        'Omit db so the link stays inside dbfrom, or drop term.',
      );
    }
    params['term'] = requireTerm(input.term);
  }
  if (input.holding !== undefined) {
    if (command !== 'llinks') {
      throw new EUtilsError(
        'validation',
        `cmd="${command}" does not accept holding.`,
        'Use holding only with cmd="llinks".',
      );
    }
    params['holding'] = validateHolding(input.holding);
  }
  if (input.idtype !== undefined) {
    if (input.idtype !== 'acc') {
      throw new EUtilsError(
        'validation',
        `idtype '${String(input.idtype)}' is not supported.`,
        'The only supported idtype is "acc", which returns accession.version identifiers instead of GI numbers.',
      );
    }
    params['idtype'] = 'acc';
  }
  const hasDateRange =
    input.reldate !== undefined || input.mindate !== undefined || input.maxdate !== undefined;
  if (input.datetype !== undefined || hasDateRange) {
    if (!DATE_COMMANDS.has(command)) {
      throw new EUtilsError(
        'validation',
        `cmd="${command}" does not accept date filters.`,
        'Use datetype, reldate, mindate, and maxdate only with cmd="neighbor" or cmd="neighbor_history".',
      );
    }
    if (dbfrom !== 'pubmed') {
      throw new EUtilsError(
        'validation',
        `Date filters require dbfrom="pubmed", not "${dbfrom}".`,
        'Omit the date filters, or link from PubMed.',
      );
    }
    if (input.datetype === undefined) {
      throw new EUtilsError(
        'validation',
        'Date filters require datetype.',
        'Pass datetype ("pdat", "edat", or "mdat") with reldate or mindate/maxdate.',
      );
    }
    if (!hasDateRange) {
      throw new EUtilsError(
        'validation',
        'datetype requires reldate or mindate/maxdate.',
        'Pass a date filter alongside datetype.',
      );
    }
    if ((input.mindate === undefined) !== (input.maxdate === undefined)) {
      throw new EUtilsError(
        'validation',
        'mindate and maxdate must be used together.',
        'Pass both bounds, or use reldate instead.',
      );
    }
    if (input.reldate !== undefined && (input.mindate !== undefined || input.maxdate !== undefined)) {
      throw new EUtilsError(
        'validation',
        'reldate cannot be combined with mindate/maxdate.',
        'Use either reldate or the mindate/maxdate range.',
      );
    }
    params['datetype'] = input.datetype;
    if (input.reldate !== undefined) params['reldate'] = input.reldate;
    if (input.mindate !== undefined) params['mindate'] = input.mindate;
    if (input.maxdate !== undefined) params['maxdate'] = input.maxdate;
  }
  switch (command) {
    case 'acheck':
      if (dbto !== undefined) params['db'] = dbto;
      break;
    case 'ncheck':
      if (dbto !== undefined && dbto !== dbfrom) {
        throw new EUtilsError(
          'validation',
          `cmd="ncheck" only checks links inside dbfrom, but db '${dbto}' differs from dbfrom '${dbfrom}'.`,
          'Omit db, or set db to the same value as dbfrom.',
        );
      }
      break;
    case 'lcheck':
    case 'llinks':
    case 'prlinks':
      if (dbto !== undefined) {
        throw new EUtilsError(
          'validation',
          `cmd="${command}" does not accept a target database.`,
          'Omit db; this command inspects links inside dbfrom or external LinkOut providers.',
        );
      }
      break;
    default:
      if (command === 'neighbor_score' && dbto !== undefined && dbto !== dbfrom) {
        throw new EUtilsError(
          'validation',
          `cmd="neighbor_score" only scores same-database links, but db '${dbto}' differs from dbfrom '${dbfrom}'.`,
          'Omit db, or set db to the same value as dbfrom.',
        );
      }
      params['db'] = dbto ?? dbfrom;
  }
  if (input.cmd) params['cmd'] = input.cmd;
  applySource(params, source, { setDb: false });
  const res = await client.request({ endpoint: 'elink.fcgi', params, signal });
  const { groups, histories, availableLinks, linkChecks, providerLinks } = parseELink(res.json);
  const totalLinked = groups.reduce((sum, group) => sum + group.count, 0);
  const storedGroups = groups.filter((group) => group.query_key !== undefined).length;
  const hasResults =
    groups.length > 0 || availableLinks.length > 0 || linkChecks.length > 0 || providerLinks.length > 0;
  const report: ELinkReport = {
    dbfrom,
    ...(dbto !== undefined ? { dbto } : {}),
    command,
    groups,
    availableLinks,
    linkChecks,
    providerLinks,
    totalLinked,
  };
  const structured = {
    dbfrom,
    ...(dbto !== undefined ? { dbto } : {}),
    command,
    groups_found: groups.length,
    total_linked: totalLinked,
    ...(storedGroups > 0 ? { stored_groups: storedGroups } : {}),
    groups,
    ...(availableLinks.length > 0 ? { available_links: availableLinks } : {}),
    ...(linkChecks.length > 0 ? { link_checks: linkChecks } : {}),
    ...(providerLinks.length > 0 ? { provider_links: providerLinks } : {}),
    ...(histories.length > 0 ? { histories } : {}),
  };
  const blocks: string[] = [elinkHeading(report), elinkSummary(report)];
  if (groups.length > 0) blocks.push(groups.map((group) => groupBlock(group)).join('\n\n'));
  if (availableLinks.length > 0) blocks.push(availableLinkBlock(availableLinks));
  if (linkChecks.length > 0) blocks.push(linkCheckBlock(linkChecks, command));
  if (providerLinks.length > 0) blocks.push(providerLinkBlock(providerLinks));
  if (histories.length > 0) blocks.push(historyBlock(histories));
  if (!hasResults) {
    blocks.push(
      `No links found for these UIDs. Try \`eutils_einfo\` with db="${dbfrom}" to list available link names.`,
    );
  }
  const nextStep = elinkNextStep(report);
  if (nextStep.length > 0) blocks.push(nextStep);
  return respond({ structured, markdown: blocks.join('\n\n'), format: input.response_format });
}
async function runECitMatch(
  client: EUtilsClient,
  input: z.infer<typeof ECitMatchInput>,
  signal?: AbortSignal,
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
  const bdata = cleaned.map((citation) => (citation.endsWith('|') ? citation : `${citation}|`)).join('\r');
  const res = await client.request({
    endpoint: 'ecitmatch.cgi',
    params: { db: 'pubmed', rettype: 'xml', retmode: 'xml', bdata },
    method: 'POST',
    signal,
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
  - db (string, optional): target database, for example "pmc". Omit to link within dbfrom. Only the neighbor commands and acheck accept a target; ncheck accepts only db equal to dbfrom, and lcheck, llinks, and prlinks reject db.
  - uids (string[] | string, optional): source UIDs.
  - history (object, optional): handle whose db matches dbfrom.
  - cmd (string, optional): "neighbor" (default), "neighbor_score", "neighbor_history", "acheck", "ncheck", "lcheck", "llinks", "prlinks".
  - linkname (string, optional): a specific link, for example "pubmed_pmc". Only with cmd="neighbor" or cmd="neighbor_history". Use eutils_einfo to list them.
  - term (string, optional): Entrez query that limits the linked set. Only with a same-database neighbor command.
  - holding (string, optional): LinkOut provider abbreviation, for example "CTgov". Only with cmd="llinks".
  - idtype ("acc", optional): return accession.version identifiers instead of GI numbers for sequence databases.
  - datetype ('pdat' | 'edat' | 'mdat', optional): date field for reldate or mindate/maxdate. Only with cmd="neighbor" or cmd="neighbor_history" and dbfrom="pubmed".
  - reldate (number, optional): only linked records with a datetype date in the last N days. Requires datetype.
  - mindate, maxdate (string, optional): datetype date range as YYYY, YYYY/MM, or YYYY/MM/DD. Use both bounds together.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Supply either uids or history, never both.

Returns:
  { dbfrom, dbto?, command, groups_found, total_linked,
    groups: [{ dbto, linkname, count, ids[], scores?, query_key? }],
    available_links?, link_checks?, provider_links?, histories? }

Examples:
  - Use when: "which PMC articles correspond to these PMIDs?" -> dbfrom="pubmed", db="pmc"
  - Use when: "find proteins for these gene IDs" -> dbfrom="gene", db="protein"
  - Use when: "which link names exist for these UIDs?" -> cmd="acheck"
  - Use when: "find similar articles with scores" -> cmd="neighbor_score"
  - Use when: "do these proteins have LinkOut providers?" -> cmd="lcheck"
  - Use when: chaining a download -> cmd="neighbor_history", then pass histories to eutils_efetch
  - Don't use when: you want records, not UID lists (use eutils_link_then_fetch)

Error Handling:
  - Rejects a history whose db does not match dbfrom
  - Rejects parameters the chosen cmd does not accept
  - Rejects date filters outside cmd="neighbor"/"neighbor_history" or outside dbfrom="pubmed"
  - Returns an empty result with a hint to list valid link names via eutils_einfo`,
      inputSchema: ELinkInput,
      outputSchema: ELinkOutput,
      annotations: STATEFUL_ANNOTATIONS,
    },
    async (input, ctx) => {
      try {
        return await runELink(client, input, ctx.mcpReq.signal);
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
    async (input, ctx) => {
      try {
        return await runECitMatch(client, input, ctx.mcpReq.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
