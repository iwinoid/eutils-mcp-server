import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { EutilsError } from '../types.js';
import type { EutilsClient } from '../services/eutilsClient.js';
import { errorResult, respond, type ToolTextResult } from '../services/formatters.js';
import { validateDatabase } from '../services/validate.js';
import { asArray, parseXml, textOf } from '../services/xml.js';
import { parseEgquery, parseEspell, requireSection, type EgqueryEntry } from './parse.js';
import { READ_ONLY_ANNOTATIONS, ResponseFormatSchema, requireTerm } from './common.js';

const EinfoInput = z.object({
  db: z
    .string()
    .optional()
    .describe('Entrez database to describe, for example "pubmed" or "protein". Omit to list all databases.'),
  response_format: ResponseFormatSchema,
});

const EgqueryInput = z.object({
  term: z.string().min(1).describe('Entrez text query to run against every database at once.'),
  response_format: ResponseFormatSchema,
});

const EspellInput = z.object({
  db: z.string().min(1).describe('Entrez database to check the spelling against, for example "pubmed".'),
  term: z.string().min(1).describe('Query whose spelling should be checked, for example "breast cancr".'),
  response_format: ResponseFormatSchema,
});

/**
 * Output contracts.
 *
 * Loose objects: they name the fields a caller can rely on and permit the
 * rest. A strict schema would break clients whenever NCBI adds a field.
 */
const EinfoOutput = z.looseObject({
  count: z.number().optional().describe('Number of Entrez databases, when no db was given.'),
  databases: z.array(z.string()).optional().describe('Database names, when no db was given.'),
  database: z.string().optional().describe('Database name, when db was given.'),
  record_count: z.number().optional(),
  field_count: z.number().optional(),
  fields: z.array(z.looseObject({ name: z.string(), fullname: z.string() })).optional(),
  link_count: z.number().optional(),
  links: z.array(z.looseObject({ name: z.string(), dbto: z.string() })).optional(),
});

const EgqueryOutput = z.looseObject({
  term: z.string(),
  databases_searched: z.number(),
  databases_with_hits: z.number(),
  hits: z.array(z.looseObject({ db: z.string(), count: z.number() })),
  empty_databases: z.array(z.string()),
  degraded: z.boolean().optional().describe('True when the fallback produced this result.'),
  degraded_reason: z.string().optional(),
});

const EspellOutput = z.looseObject({
  database: z.string(),
  query: z.string(),
  corrected_query: z.string(),
  changed: z.boolean(),
});

interface DbField {
  name: string;
  fullname: string;
  description: string;
  termcount?: string;
}

interface DbLink {
  name: string;
  dbto: string;
  menu: string;
}

function readFields(dbinfo: Record<string, unknown>): DbField[] {
  return (asArray(dbinfo['fieldlist']) as Record<string, unknown>[]).map((field) => ({
    name: textOf(field['name']),
    fullname: textOf(field['fullname']),
    description: textOf(field['description']),
    ...(textOf(field['termcount']) ? { termcount: textOf(field['termcount']) } : {}),
  }));
}

function readLinks(dbinfo: Record<string, unknown>): DbLink[] {
  return (asArray(dbinfo['linklist']) as Record<string, unknown>[]).map((link) => ({
    name: textOf(link['name']),
    dbto: textOf(link['dbto']),
    menu: textOf(link['menu']),
  }));
}

async function runEinfo(client: EutilsClient, input: z.infer<typeof EinfoInput>): Promise<ToolTextResult> {
  const params: Record<string, unknown> = { retmode: 'json' };
  if (input.db) params['db'] = validateDatabase(input.db);

  const res = await client.request({ endpoint: 'einfo.fcgi', params });
  const root = requireSection<Record<string, unknown>>(res.json, 'einforesult', 'EInfo');

  if (!input.db) {
    const dblist = asArray(root['dblist'])
      .map((entry) => textOf(entry))
      .filter((name) => name.length > 0);

    const markdown = [
      `# Entrez databases (${dblist.length})`,
      '',
      'Call this tool again with a specific `db` to list its searchable fields and links.',
      '',
      dblist.map((name) => `- ${name}`).join('\n'),
    ].join('\n');

    return respond({
      structured: { count: dblist.length, databases: dblist },
      markdown,
      format: input.response_format,
    });
  }

  const dbinfo = (asArray(root['dbinfo'])[0] ?? {}) as Record<string, unknown>;
  const dbname = textOf(dbinfo['dbname']) || input.db;
  const fields = readFields(dbinfo);
  const links = readLinks(dbinfo);

  const structured = {
    database: dbname,
    menu_name: textOf(dbinfo['menuname']),
    description: textOf(dbinfo['description']),
    record_count: Number(textOf(dbinfo['count'])) || 0,
    last_update: textOf(dbinfo['lastupdate']),
    build: textOf(dbinfo['dbbuild']),
    field_count: fields.length,
    fields,
    link_count: links.length,
    links,
  };

  const markdown = [
    `# ${structured.menu_name || dbname} (\`${dbname}\`)`,
    '',
    structured.description,
    '',
    `- Records: ${structured.record_count.toLocaleString('en-US')}`,
    `- Last update: ${structured.last_update || 'unknown'}`,
    `- Build: ${structured.build || 'unknown'}`,
    '',
    `## Searchable fields (${fields.length})`,
    '',
    'Use these inside square brackets in a query, for example `breast cancer[tiab]`.',
    '',
    fields
      .map((f) => `- **${f.name}** — ${f.fullname}${f.description ? `: ${f.description}` : ''}`)
      .join('\n'),
    '',
    `## Links to other databases (${links.length})`,
    '',
    'Pass a link name to `eutils_elink` as `linkname`.',
    '',
    links.map((l) => `- \`${l.name}\` → **${l.dbto}**${l.menu ? ` (${l.menu})` : ''}`).join('\n'),
  ].join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

async function runEgquery(
  client: EutilsClient,
  input: z.infer<typeof EgqueryInput>,
): Promise<ToolTextResult> {
  const term = requireTerm(input.term);

  let entries: EgqueryEntry[];
  let degradedReason: string | undefined;
  let degradedHint: string | undefined;

  try {
    entries = await queryEgquery(client, term);
  } catch (error) {
    // EGQuery answers unauthenticated requests with a 301 to an NCBI-internal
    // service-mesh host that is not published in public DNS. When that happens
    // the feature is still useful, so fall back to per-database ESearch counts.
    // Only a network failure degrades; validation errors propagate.
    if (!(error instanceof EutilsError) || error.kind !== 'network') throw error;
    degradedReason = error.message;
    degradedHint = client.hasApiKey
      ? 'EGQuery still redirected with a valid API key, so this is confirmed as an NCBI-side problem, not a credentials one.'
      : 'EGQuery redirected before any credential check, so an API key would not help; this is an NCBI-side problem.';
    entries = await egqueryFallback(client, term);
  }

  const hits = entries.filter((e) => e.count > 0).sort((a, b) => b.count - a.count);
  const empty = entries.filter((e) => e.count === 0);

  const structured = {
    term,
    databases_searched: entries.length,
    databases_with_hits: hits.length,
    hits,
    empty_databases: empty.map((e) => e.db),
    ...(degradedReason
      ? {
          degraded: true,
          degraded_reason: degradedReason,
          degraded_note:
            'The real EGQuery could not be reached, so this result covers a curated subset of databases using ESearch instead of all 38.',
          ...(degradedHint ? { degraded_hint: degradedHint } : {}),
        }
      : {}),
  };

  const markdown = [
    `# Global Entrez query: \`${term}\``,
    '',
    degradedReason
      ? [
          '> **Degraded result.** NCBI EGQuery is unreachable from the public internet:',
          `> ${degradedReason}`,
          `> Counts below come from ESearch over ${entries.length} commonly used databases, not all 38.`,
          `> ${degradedHint}`,
        ].join('\n')
      : `Searched ${entries.length} databases. ${hits.length} have matches.`,
    '',
    hits.length > 0 ? '## Databases with matches' : '## No database matched this query',
    '',
    hits
      .map((h) => `- **${h.db}**${h.menu ? ` (${h.menu})` : ''}: ${h.count.toLocaleString('en-US')}`)
      .join('\n'),
    '',
    `Databases with no matches: ${empty.length > 0 ? empty.map((e) => e.db).join(', ') : 'none'}`,
    '',
    hits.length > 0
      ? `Next: run \`eutils_esearch\` with db="${hits[0]!.db}" to retrieve UIDs.`
      : 'Next: check the spelling with `eutils_espell`, or broaden the query.',
  ].join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

/** Ask EGQuery directly. Returns one entry per Entrez database. */
async function queryEgquery(client: EutilsClient, term: string): Promise<EgqueryEntry[]> {
  const res = await client.request({ endpoint: 'egquery.fcgi', params: { term } });

  const parsed = parseXml(res.text);
  if (parsed === undefined) {
    throw new EutilsError(
      'parse',
      'EGQuery returned a body that could not be parsed as XML.',
      'Retry. If it persists, the endpoint may be under maintenance.',
    );
  }

  return parseEgquery(parsed);
}

/**
 * Databases used when EGQuery itself is unavailable.
 *
 * Chosen to cover the questions EGQuery is normally asked. Individual
 * failures are tolerated so one bad database cannot fail the whole call.
 */
const EGQUERY_FALLBACK_DATABASES = [
  'pubmed',
  'pmc',
  'protein',
  'nuccore',
  'gene',
  'snp',
  'structure',
  'taxonomy',
  'bioproject',
  'biosample',
  'mesh',
  'gds',
] as const;

/** Count matches per database with ESearch, as a stand-in for EGQuery. */
async function egqueryFallback(client: EutilsClient, term: string): Promise<EgqueryEntry[]> {
  const entries: EgqueryEntry[] = [];

  for (const db of EGQUERY_FALLBACK_DATABASES) {
    try {
      const res = await client.request({
        endpoint: 'esearch.fcgi',
        params: { db, term, retmax: 0, retmode: 'json' },
      });
      const root = requireSection<Record<string, unknown>>(res.json, 'esearchresult', 'ESearch');
      entries.push({ db, menu: '', count: Number(textOf(root['count'])) || 0, status: 'Ok' });
    } catch (error) {
      entries.push({
        db,
        menu: '',
        count: 0,
        status: error instanceof Error ? `Error: ${error.message}` : 'Error',
      });
    }
  }

  return entries;
}

async function runEspell(client: EutilsClient, input: z.infer<typeof EspellInput>): Promise<ToolTextResult> {
  const db = validateDatabase(input.db);
  const term = requireTerm(input.term);

  const res = await client.request({ endpoint: 'espell.fcgi', params: { db, term } });

  const parsed = parseXml(res.text);
  if (parsed === undefined) {
    throw new EutilsError(
      'parse',
      'ESpell returned a body that could not be parsed as XML.',
      'Retry. If it persists, the endpoint may be under maintenance.',
    );
  }

  const { query, corrected, changed } = parseEspell(parsed, term);

  const structured = {
    database: db,
    query,
    corrected_query: corrected,
    changed,
  };

  const markdown = [
    `# Spelling check in \`${db}\``,
    '',
    `Query: \`${query}\``,
    '',
    changed
      ? `Suggested correction: **${corrected}**\n\nNext: run \`eutils_esearch\` with term="${corrected}".`
      : 'No correction suggested. The query appears to be spelled correctly.',
  ].join('\n');

  return respond({ structured, markdown, format: input.response_format });
}

/** Register EInfo, EGQuery, and ESpell. */
export function registerDiscoveryTools(server: McpServer, client: EutilsClient): void {
  server.registerTool(
    'eutils_einfo',
    {
      title: 'Entrez Database Info',
      description: `List Entrez databases, or describe one database's searchable fields and links.

Call with no arguments to list all Entrez databases. Call with db to get that database's
record count, last update time, searchable field names, and the links available to other
databases.

Args:
  - db (string, optional): database to describe, for example "pubmed". Omit to list all.
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  Without db: { count, databases: string[] }
  With db: { database, menu_name, description, record_count, last_update, build,
             field_count, fields: [{ name, fullname, description, termcount? }],
             link_count, links: [{ name, dbto, menu }] }

Examples:
  - Use when: "what fields can I search in PubMed?" -> db="pubmed"
  - Use when: "which Entrez databases exist?" -> no arguments
  - Use when: "what databases link from a gene record?" -> db="gene"
  - Don't use when: you want record counts for a query (use eutils_egquery instead)

Error Handling:
  - Rejects a database name that is not one of the known Entrez databases, and lists samples
  - Returns a parse error if NCBI changes the response shape`,
      inputSchema: EinfoInput,
      outputSchema: EinfoOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEinfo(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'eutils_egquery',
    {
      title: 'Global Entrez Query',
      description: `Search every Entrez database at once and report how many records each one matches.

Use this to find which database holds data for a topic before committing to a search.
It returns counts only, never records.

Args:
  - term (string): Entrez text query, for example "CRISPR base editing".
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { term, databases_searched, databases_with_hits,
    hits: [{ db, menu, count, status }] (sorted by count, descending),
    empty_databases: string[] }

Examples:
  - Use when: "which database has information about BRCA1 variants?" -> term="BRCA1 variants"
  - Don't use when: you already know the database (use eutils_esearch instead)

Error Handling:
  - Returns "The search term was empty" when term is blank
  - NCBI EGQuery redirects to an internal host that is not published in public DNS, for
    every client including ones with a valid API key. When the real EGQuery is
    unreachable this tool falls back to per-database ESearch counts over 12 commonly used
    databases, and says so in a "degraded" field. Counts are then a subset, not all 38.
  - The fallback triggers only on a network failure, never on a validation error.`,
      inputSchema: EgqueryInput,
      outputSchema: EgqueryOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEgquery(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'eutils_espell',
    {
      title: 'Spelling Suggestion',
      description: `Get NCBI's spelling suggestion for a query in one database.

Args:
  - db (string): database to check against, for example "pubmed".
  - term (string): query to check, for example "breast cancr".
  - response_format ('markdown' | 'json'): output format. Default 'markdown'.

Returns:
  { database, query, corrected_query, changed }

Examples:
  - Use when: a search returned no results and you suspect a typo
  - Use when: "did you mean" for a query -> term="diabetis"
  - Don't use when: the query is a structured field search; ESpell works on plain terms

Error Handling:
  - Reports changed=false when NCBI has no correction, rather than an error`,
      inputSchema: EspellInput,
      outputSchema: EspellOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return await runEspell(client, input);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
