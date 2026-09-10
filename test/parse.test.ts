/**
 * Parser tests against real NCBI responses captured on 2026-09-11.
 *
 * These guard the response-shape layer, where reading the wrong envelope
 * level silently produces empty results instead of an error.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compactGeneric,
  compactPubmed,
  parseEcitmatch,
  parseEgquery,
  parseElink,
  parseEpost,
  parseEsearch,
  parseEsummary,
  parseEspell,
  requireSection,
} from '../src/tools/parse.js';
import { EutilsError } from '../src/types.js';
import { parseXml } from '../src/services/xml.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): string => readFileSync(join(fixtures, name), 'utf8');
const loadJson = (name: string): unknown => JSON.parse(load(name));

describe('requireSection', () => {
  it('returns the named section', () => {
    expect(requireSection({ a: { b: 1 } }, 'a', 'X')).toEqual({ b: 1 });
  });

  it('throws a parse error when the section is missing', () => {
    expect(() => requireSection({ a: 1 }, 'missing', 'X')).toThrow(EutilsError);
  });

  it('throws a parse error for a non-object body', () => {
    expect(() => requireSection('<xml/>', 'a', 'X')).toThrow(EutilsError);
  });
});

describe('parseEsearch', () => {
  const json = loadJson('esearch.json');

  it('reads the count, UIDs, and query translation', () => {
    const parsed = parseEsearch(json, 'pubmed', true);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.uids).toHaveLength(3);
    expect(parsed.uids.every((uid) => /^\d+$/.test(uid))).toBe(true);
    expect(parsed.queryTranslation).toContain('Journal');
  });

  it('expands term translations', () => {
    const parsed = parseEsearch(json, 'pubmed', false);
    expect(parsed.translations.length).toBeGreaterThan(0);
    expect(parsed.translations[0]!.from).toBeTruthy();
    expect(parsed.translations[0]!.to).toBeTruthy();
  });

  it('returns a history handle when asked', () => {
    const parsed = parseEsearch(json, 'pubmed', true);
    expect(parsed.history?.db).toBe('pubmed');
    expect(parsed.history?.web_env).toMatch(/^MCID_/);
    expect(parsed.history?.query_key).toBe('1');
  });

  it('omits the history handle when not asked', () => {
    expect(parseEsearch(json, 'pubmed', false).history).toBeUndefined();
  });
});

describe('parseEsummary', () => {
  it('compacts a PubMed record', () => {
    const { uids, records } = parseEsummary(loadJson('esummary-pubmed.json'), 'pubmed');
    expect(uids).toHaveLength(2);

    const record = records.find((r) => r['uid'] === '31452104')!;
    expect(record['title']).toBe('Molegro Virtual Docker for Docking.');
    expect(record['journal']).toBe('Methods in molecular biology (Clifton, N.J.)');
    expect(record['source']).toBe('Methods Mol Biol');
    expect(record['doi']).toBe('10.1007/978-1-4939-9752-7_10');
    expect(record['authors']).toEqual(['Bitencourt-Ferreira G', 'de Azevedo WF Jr']);
    expect(record['pubtype']).toContain('Journal Article');
  });

  it('does not leak verbose PubMed structures', () => {
    const { records } = parseEsummary(loadJson('esummary-pubmed.json'), 'pubmed');
    expect(records[0]).not.toHaveProperty('references');
    expect(records[0]).not.toHaveProperty('articleids');
  });

  it('compacts a non-PubMed record with generic fields', () => {
    const { uids, records } = parseEsummary(loadJson('esummary-protein.json'), 'protein');
    expect(uids).toHaveLength(1);
    expect(records[0]!['uid']).toBe('15718680');
    expect(String(records[0]!['title'])).toContain('ITK');
    expect(records[0]).not.toHaveProperty('references');
  });

  it('tolerates a UID with no matching record', () => {
    const { records } = parseEsummary({ result: { uids: ['999'] } }, 'pubmed');
    expect(records).toEqual([{ uid: '999' }]);
  });
});

describe('compactPubmed', () => {
  it('omits doi and pmcid when the record has none', () => {
    const record = compactPubmed('1', { title: 'x', articleids: [] });
    expect(record).not.toHaveProperty('doi');
    expect(record).not.toHaveProperty('pmcid');
  });

  it('finds a pmcid when present', () => {
    const record = compactPubmed('1', {
      articleids: [
        { idtype: 'pubmed', value: '1' },
        { idtype: 'pmc', value: 'PMC123' },
      ],
    });
    expect(record['pmcid']).toBe('PMC123');
  });
});

describe('compactGeneric', () => {
  it('caps the number of fields kept', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) wide[`field${i}`] = `value${i}`;
    expect(Object.keys(compactGeneric('1', wide))).toHaveLength(16); // uid + 15
  });

  it('drops verbose keys', () => {
    expect(compactGeneric('1', { references: ['a'], title: 'x' })).toEqual({ uid: '1', title: 'x' });
  });

  it('keeps arrays of strings', () => {
    expect(compactGeneric('1', { tags: ['a', 'b'] })['tags']).toEqual(['a', 'b']);
  });
});

describe('parseElink', () => {
  it('reads link groups from the linksetdbs form', () => {
    const parsed = parseElink(loadJson('elink-links.json'));
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]!.dbto).toBe('pmc');
    expect(parsed.groups[0]!.linkname).toBe('pubmed_pmc_refs');
    expect(parsed.groups[0]!.count).toBe(70);
    expect(parsed.groups[0]!.ids).toContain('13547197');
  });

  it('reads history handles from the linksetdbhistories form', () => {
    const parsed = parseElink(loadJson('elink-history.json'));
    expect(parsed.histories).toHaveLength(1);
    expect(parsed.histories[0]!.db).toBe('pmc');
    expect(parsed.histories[0]!.web_env).toMatch(/^MCID_/);
    expect(parsed.histories[0]!.query_key).toBeTruthy();
  });

  it('regression: linksets is an array at the top level, not an envelope', () => {
    // Reading `json.linksets.linksets` yields zero groups with no error, which
    // is how this bug shipped once.
    expect(Array.isArray((loadJson('elink-links.json') as Record<string, unknown>)['linksets'])).toBe(true);
    expect(parseElink(loadJson('elink-links.json')).groups.length).toBeGreaterThan(0);
  });

  it('throws a parse error when linksets is absent', () => {
    expect(() => parseElink({ header: {} })).toThrow(EutilsError);
  });
});

describe('parseEgquery', () => {
  const xml = `<?xml version="1.0"?>
<eGQueryResult>
  <ResultItem><DbName>pubmed</DbName><MenuName>PubMed</MenuName><Count>42</Count><Status>Ok</Status></ResultItem>
  <ResultItem><DbName>protein</DbName><MenuName>Protein</MenuName><Count>0</Count><Status>Ok</Status></ResultItem>
</eGQueryResult>`;

  it('reads one entry per database', () => {
    const entries = parseEgquery(parseXml(xml));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ db: 'pubmed', menu: 'PubMed', count: 42, status: 'Ok' });
  });

  it('returns an empty list for a body without results', () => {
    expect(parseEgquery(parseXml('<eGQueryResult/>'))).toEqual([]);
  });
});

describe('parseEspell', () => {
  it('reads the corrected query from the captured response', () => {
    const result = parseEspell(parseXml(load('espell.xml')), 'breast cancr');
    expect(result.query).toBe('breast cancr');
    expect(result.corrected).toBe('breast cancer');
    expect(result.changed).toBe(true);
  });

  it('reports no change when NCBI offers no correction', () => {
    const xml = '<eSpellResult><Query>cancer</Query><CorrectedQuery></CorrectedQuery></eSpellResult>';
    expect(parseEspell(parseXml(xml), 'cancer').changed).toBe(false);
  });

  it('falls back to the supplied term when NCBI echoes no query', () => {
    expect(parseEspell(parseXml('<eSpellResult/>'), 'fallback').query).toBe('fallback');
  });
});

describe('parseEpost', () => {
  it('builds a history reference from the captured response', () => {
    const history = parseEpost(parseXml(load('epost.xml')), 'pubmed');
    expect(history?.db).toBe('pubmed');
    expect(history?.web_env).toBeTruthy();
    expect(history?.query_key).toBeTruthy();
  });

  it('returns undefined for a body without a web environment', () => {
    expect(parseEpost(parseXml('<ePostResult/>'), 'pubmed')).toBeUndefined();
  });
});

describe('parseEcitmatch', () => {
  it('reads the PMID appended as the seventh field', () => {
    const body = 'science|1987|235|182|palmenberg ac|Art2|3026048';
    const [record] = parseEcitmatch(body, ['science|1987|235|182|palmenberg ac|Art2|']);
    expect(record!.pmid).toBe('3026048');
    expect(record!.matched).toBe(true);
    expect(record!.journal).toBe('science');
    expect(record!.year).toBe('1987');
  });

  it('marks an unmatched citation', () => {
    const body = 'fake journal|1900|1|1|nobody|X1|';
    const [record] = parseEcitmatch(body, ['fake journal|1900|1|1|nobody|X1|']);
    expect(record!.matched).toBe(false);
    expect(record!.pmid).toBe('');
  });

  it('handles the line feed NCBI actually returns', () => {
    // Captured behaviour: a request joined with \r comes back joined with \n.
    const body = [
      'proc natl acad sci u s a|1991|88|3248|mann bj|Art1|2014248',
      'science|1987|235|182|palmenberg ac|Art2|3026048',
    ].join('\n');
    const records = parseEcitmatch(body, ['a', 'b']);
    expect(records).toHaveLength(2);
    expect(records[0]!.pmid).toBe('2014248');
    expect(records[1]!.pmid).toBe('3026048');
  });

  it('also tolerates carriage returns and CRLF', () => {
    const two = 'a|1|2|3|p|K1|11111111\rb|1|2|3|p|K2|22222222';
    expect(parseEcitmatch(two, ['x', 'y'])).toHaveLength(2);

    const crlf = 'a|1|2|3|p|K1|11111111\r\nb|1|2|3|p|K2|22222222';
    expect(parseEcitmatch(crlf, ['x', 'y'])).toHaveLength(2);
  });

  it('ignores empty lines', () => {
    expect(parseEcitmatch('science|1987|235|182|p|K|3026048\n\n', ['x'])).toHaveLength(1);
  });
});
