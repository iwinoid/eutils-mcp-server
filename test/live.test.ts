/**
 * Live integration tests: every tool makes at least one real NCBI round trip.
 *
 * Opt in with EUTILS_LIVE=1. The built server is required, so run
 * `npm run build` first (the `test:live` script does it for you).
 *
 * Assertions deliberately avoid counts and dates that change over time.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultText, serverIsBuilt, StdioMcpClient, type JsonSchema } from './mcpClient.js';

const live = process.env['EUTILS_LIVE'] === '1';
const ready = live && serverIsBuilt();

if (live && !serverIsBuilt()) {
  throw new Error('dist/index.js is missing. Run `npm run build` before `npm run test:live`.');
}

describe.skipIf(!ready)('live E-utilities round trips', () => {
  let client: StdioMcpClient;

  beforeAll(async () => {
    client = new StdioMcpClient();
    await client.initialize();
  }, 60_000);

  afterAll(() => {
    client?.close();
  });

  it('lists all eleven tools', async () => {
    const tools = await client.listTools();
    expect(tools).toHaveLength(11);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'eutils_ecitmatch',
        'eutils_efetch',
        'eutils_einfo',
        'eutils_egquery',
        'eutils_elink',
        'eutils_epost',
        'eutils_esearch',
        'eutils_espell',
        'eutils_esummary',
        'eutils_link_then_fetch',
        'eutils_search_then_fetch',
      ].sort(),
    );
  });

  it('eutils_einfo lists every Entrez database', async () => {
    const result = await client.callTool('eutils_einfo', { response_format: 'json' });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { count: number; databases: string[] };
    expect(data.count).toBe(38);
    expect(data.databases).toContain('pubmed');
    expect(data.databases).toContain('protein');
  });

  it('eutils_einfo describes a database with fields and links', async () => {
    const result = await client.callTool('eutils_einfo', { db: 'pubmed', response_format: 'json' });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      database: string;
      field_count: number;
      fields: Array<{ name: string }>;
      links: Array<{ dbto: string }>;
    };
    expect(data.database).toBe('pubmed');
    expect(data.field_count).toBeGreaterThan(10);
    expect(data.fields.map((f) => f.name)).toContain('ALL');
    expect(data.links.map((l) => l.dbto)).toContain('protein');
  });

  it('eutils_esearch returns UIDs and a History handle', async () => {
    const result = await client.callTool('eutils_esearch', {
      db: 'pubmed',
      term: 'science[journal] AND breast cancer AND 2008[pdat]',
      retmax: 3,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      total: number;
      uids: string[];
      has_more: boolean;
      history?: { db: string; web_env: string; query_key: string };
    };
    expect(data.total).toBeGreaterThan(0);
    expect(data.uids).toHaveLength(3);
    expect(data.uids.every((uid) => /^\d+$/.test(uid))).toBe(true);
    expect(data.history?.db).toBe('pubmed');
    expect(data.history?.web_env).toBeTruthy();
  });

  it('eutils_esearch stores a set that eutils_esummary can read back', async () => {
    const search = await client.callTool('eutils_esearch', {
      db: 'pubmed',
      term: 'CRISPR AND 2019[pdat]',
      retmax: 0,
      response_format: 'json',
    });
    const history = (
      search.structuredContent as { history: { db: string; web_env: string; query_key: string } }
    ).history;
    expect(history.web_env).toBeTruthy();

    const summary = await client.callTool('eutils_esummary', {
      history,
      retmax: 2,
      response_format: 'json',
    });
    expect(summary.isError).toBeFalsy();
    const data = summary.structuredContent as { records: Array<{ uid: string; title: string }> };
    expect(data.records.length).toBeGreaterThan(0);
    expect(data.records[0]!.uid).toMatch(/^\d+$/);
    expect(data.records[0]!.title.length).toBeGreaterThan(0);
  });

  it('eutils_epost uploads UIDs and returns a usable handle', async () => {
    const result = await client.callTool('eutils_epost', {
      db: 'gene',
      uids: ['7173', '22018', '54314'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      uploaded: number;
      history: { db: string; web_env: string; query_key: string };
    };
    expect(data.uploaded).toBe(3);
    expect(data.history.db).toBe('gene');
    expect(data.history.web_env).toBeTruthy();

    const summary = await client.callTool('eutils_esummary', {
      history: data.history,
      retmax: 3,
      response_format: 'json',
    });
    expect(summary.isError).toBeFalsy();
    expect((summary.structuredContent as { records: unknown[] }).records.length).toBeGreaterThan(0);
  });

  it('eutils_esummary returns a known PubMed record', async () => {
    const result = await client.callTool('eutils_esummary', {
      db: 'pubmed',
      uids: ['31452104'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { records: Array<Record<string, unknown>> };
    const record = data.records[0]!;
    expect(record['uid']).toBe('31452104');
    expect(String(record['title'])).toContain('Molegro Virtual Docker');
    // `journal` carries the full journal name and `source` the abbreviation.
    expect(`${record['journal']} ${record['source']}`).toContain('Methods Mol Biol');
    expect(String(record['doi'])).toContain('10.1007/978-1-4939-9752-7_10');
  });

  it('eutils_efetch returns a PubMed abstract as fenced text', async () => {
    const result = await client.callTool('eutils_efetch', {
      db: 'pubmed',
      uids: ['31452104'],
      rettype: 'abstract',
    });
    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toContain('EXTERNAL_NCBI_DATA');
    expect(text).toMatch(/31452104|Molegro/);
  });

  it('eutils_efetch returns a protein FASTA by accession', async () => {
    const result = await client.callTool('eutils_efetch', {
      db: 'protein',
      uids: ['NP_005537.3'],
      rettype: 'fasta',
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toMatch(/>NP_005537\.3/);
  });

  it('eutils_elink finds PMC records linked to a PMID', async () => {
    const result = await client.callTool('eutils_elink', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['31452104'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { groups_found: number; groups: Array<{ dbto: string }> };
    expect(data.groups_found).toBeGreaterThan(0);
    expect(data.groups.map((g) => g.dbto)).toContain('pmc');
  });

  it('eutils_elink with neighbor_history returns history handles', async () => {
    const result = await client.callTool('eutils_elink', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['31452104'],
      cmd: 'neighbor_history',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      histories?: Array<{ db: string; web_env: string; query_key: string }>;
    };
    expect(data.histories?.length).toBeGreaterThan(0);
    expect(data.histories?.[0]?.db).toBe('pmc');
  });

  it('eutils_egquery searches every database at once', async () => {
    const result = await client.callTool('eutils_egquery', {
      term: 'breast cancer',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      databases_searched: number;
      hits: Array<{ db: string; count: number }>;
    };
    expect(data.databases_searched).toBeGreaterThan(10);
    const pubmed = data.hits.find((h) => h.db === 'pubmed');
    expect(pubmed?.count).toBeGreaterThan(0);
  });

  it('eutils_espell corrects a misspelling', async () => {
    const result = await client.callTool('eutils_espell', {
      db: 'pubmed',
      term: 'breast cancr',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { corrected_query: string; changed: boolean };
    expect(data.corrected_query.toLowerCase()).toContain('breast cancer');
    expect(data.changed).toBe(true);
  });

  it('eutils_ecitmatch resolves a citation to a PMID', async () => {
    const result = await client.callTool('eutils_ecitmatch', {
      citations: ['science|1987|235|182|palmenberg ac|Art2|'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      matched: number;
      records: Array<{ pmid: string; matched: boolean }>;
    };
    expect(data.matched).toBe(1);
    expect(data.records[0]!.pmid).toBe('3026048');
  });

  it('eutils_search_then_fetch runs the whole pipeline in one call', async () => {
    const result = await client.callTool('eutils_search_then_fetch', {
      db: 'pubmed',
      term: 'Molegro Virtual Docker',
      retmax: 1,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { total: number; text: string; history: unknown };
    expect(data.total).toBeGreaterThan(0);
    expect(data.text.length).toBeGreaterThan(0);
    expect(data.history).toBeTruthy();
  });

  it('eutils_link_then_fetch walks from a gene to its protein records', async () => {
    const result = await client.callTool('eutils_link_then_fetch', {
      dbfrom: 'gene',
      db: 'protein',
      uids: ['7173'],
      retmax: 2,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { dbto: string; text: string };
    expect(data.dbto).toBe('protein');
    expect(data.text).toMatch(/^>/m);
  });

  it('rejects a database name carrying an injected parameter', async () => {
    const result = await client.callTool('eutils_esearch', {
      db: 'pubmed&api_key=stolen',
      term: 'cancer',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('not a valid Entrez database name');
  });

  it('refuses to combine uids and history in one call', async () => {
    const result = await client.callTool('eutils_esummary', {
      db: 'pubmed',
      uids: ['31452104'],
      history: { db: 'pubmed', web_env: 'MCID_x', query_key: '1' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('not both');
  });

  it('never leaks the API key into a response', async () => {
    const result = await client.callTool('eutils_esearch', {
      db: 'pubmed',
      term: 'cancer',
      retmax: 0,
    });
    expect(resultText(result)).not.toContain('api_key=');
  });
});

/**
 * Contract tests: every tool must return structured content that satisfies the
 * outputSchema it advertises.
 *
 * Declaring an output schema and then drifting from it is worse than declaring
 * nothing, because clients trust the declaration. These tests make the
 * declaration binding.
 */
describe.skipIf(!ready)('outputSchema contract', () => {
  let client: StdioMcpClient;
  let schemas: Map<string, JsonSchema>;

  beforeAll(async () => {
    client = new StdioMcpClient();
    await client.initialize();
    const tools = await client.listTools();
    schemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema ?? {}]));
  }, 60_000);

  afterAll(() => client?.close());

  /** Collect schema violations as readable paths. */
  function violations(value: unknown, schema: JsonSchema, path: string): string[] {
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    const out: string[] = [];

    if (type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return [`${path}: expected object`];
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) out.push(`${path}.${key}: missing`);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (record[key] !== undefined) out.push(...violations(record[key], sub, `${path}.${key}`));
      }
      return out;
    }

    if (type === 'array') {
      if (!Array.isArray(value)) return [`${path}: expected array`];
      if (schema.items) {
        value.forEach((item, index) => out.push(...violations(item, schema.items!, `${path}[${index}]`)));
      }
      return out;
    }

    if (type === 'string' && typeof value !== 'string') out.push(`${path}: expected string`);
    if (type === 'number' && typeof value !== 'number') out.push(`${path}: expected number`);
    if (type === 'boolean' && typeof value !== 'boolean') out.push(`${path}: expected boolean`);
    return out;
  }

  /** Call a tool and assert its structured content matches its own schema. */
  async function check(name: string, args: Record<string, unknown>): Promise<void> {
    const result = await client.callTool(name, args);
    expect(result.isError, `${name} returned an error`).toBeFalsy();

    const schema = schemas.get(name);
    expect(schema, `${name} declares no outputSchema`).toBeTruthy();

    const found = violations(result.structuredContent, schema!, name);
    expect(found, `${name} violates its outputSchema:\n  ${found.join('\n  ')}`).toEqual([]);
  }

  it('eutils_einfo (list mode) satisfies its schema', async () => {
    await check('eutils_einfo', {});
  });

  it('eutils_einfo (describe mode) satisfies its schema', async () => {
    await check('eutils_einfo', { db: 'pubmed' });
  });

  it('eutils_esearch satisfies its schema', async () => {
    await check('eutils_esearch', { db: 'pubmed', term: 'CRISPR', retmax: 2 });
  });

  it('eutils_epost satisfies its schema', async () => {
    await check('eutils_epost', { db: 'gene', uids: ['7173'] });
  });

  it('eutils_esummary satisfies its schema', async () => {
    await check('eutils_esummary', { db: 'pubmed', uids: ['31452104'] });
  });

  it('eutils_efetch satisfies its schema', async () => {
    await check('eutils_efetch', { db: 'protein', uids: ['NP_005537.3'], rettype: 'fasta' });
  });

  it('eutils_elink satisfies its schema', async () => {
    await check('eutils_elink', { dbfrom: 'gene', db: 'protein', uids: ['7173'] });
  });

  it('eutils_egquery satisfies its schema', async () => {
    await check('eutils_egquery', { term: 'mengo virus' });
  });

  it('eutils_espell satisfies its schema', async () => {
    await check('eutils_espell', { db: 'pubmed', term: 'breast cancr' });
  });

  it('eutils_ecitmatch satisfies its schema', async () => {
    await check('eutils_ecitmatch', { citations: ['science|1987|235|182|palmenberg ac|Art2|'] });
  });

  it('eutils_search_then_fetch satisfies its schema', async () => {
    await check('eutils_search_then_fetch', { db: 'pubmed', term: 'Molegro Virtual Docker', retmax: 1 });
  });

  it('eutils_link_then_fetch satisfies its schema', async () => {
    await check('eutils_link_then_fetch', { dbfrom: 'gene', db: 'protein', uids: ['7173'], retmax: 1 });
  });
});
