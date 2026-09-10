import { describe, expect, it } from 'vitest';
import { asArray, parseXml, stripDoctype, textOf } from '../src/services/xml.js';

const EGQUERY_SAMPLE = `<?xml version="1.0"?>
<!DOCTYPE eGQueryResult PUBLIC "-//NLM//DTD eGQueryResult, 23 May 2005//EN" "https://www.ncbi.nlm.nih.gov/entrez/query/DTD/eGQuery_050523.dtd">
<eGQueryResult>
  <ResultItem>
    <DbName>pubmed</DbName>
    <MenuName>PubMed</MenuName>
    <Count>42</Count>
    <Status>Ok</Status>
  </ResultItem>
  <ResultItem>
    <DbName>protein</DbName>
    <MenuName>Protein</MenuName>
    <Count>0</Count>
    <Status>Ok</Status>
  </ResultItem>
</eGQueryResult>`;

const ESPELL_SAMPLE = `<?xml version="1.0"?>
<eSpellResult>
  <Database>pubmed</Database>
  <Query>breast cancr</Query>
  <CorrectedQuery>breast cancer</CorrectedQuery>
  <SpelledQuery><Replaced>breast </Replaced><Original>cancr</Original></SpelledQuery>
</eSpellResult>`;

describe('stripDoctype', () => {
  it('removes a DOCTYPE declaration', () => {
    expect(stripDoctype(EGQUERY_SAMPLE)).not.toContain('<!DOCTYPE');
  });

  it('removes a DOCTYPE carrying an internal subset', () => {
    const hostile = '<!DOCTYPE foo [<!ENTITY x "y">]><foo/>';
    expect(stripDoctype(hostile)).toBe('<foo/>');
  });
});

describe('parseXml', () => {
  it('parses an egquery document', () => {
    const parsed = parseXml(EGQUERY_SAMPLE) as Record<string, any>;
    const items = asArray(parsed['eGQueryResult']?.ResultItem);
    expect(items).toHaveLength(2);
    expect(textOf(items[0]?.DbName)).toBe('pubmed');
    expect(textOf(items[0]?.Count)).toBe('42');
  });

  it('parses an espell document', () => {
    const parsed = parseXml(ESPELL_SAMPLE) as Record<string, any>;
    expect(textOf(parsed['eSpellResult']?.CorrectedQuery)).toBe('breast cancer');
  });

  it('returns undefined instead of throwing on malformed input', () => {
    expect(parseXml('<a><b></a>')).toBeUndefined();
  });

  it('returns undefined instead of throwing on an empty document', () => {
    expect(parseXml('')).toBeUndefined();
  });

  it('does not expand entities', () => {
    const hostile = '<!DOCTYPE foo [<!ENTITY xxe "SECRET">]><foo>&xxe;</foo>';
    const result = JSON.stringify(parseXml(hostile) ?? {});
    expect(result).not.toContain('SECRET');
  });
});

describe('asArray', () => {
  it('wraps a single node', () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
  });

  it('passes an array through', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
  });

  it('returns an empty array for undefined and null', () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });
});

describe('textOf', () => {
  it('reads strings and numbers', () => {
    expect(textOf('x')).toBe('x');
    expect(textOf(7)).toBe('7');
  });

  it('unwraps a #text node', () => {
    expect(textOf({ '#text': 'hello', '@_Type': 'String' })).toBe('hello');
  });

  it('returns an empty string for structured nodes', () => {
    expect(textOf({ nested: 'x' })).toBe('');
    expect(textOf(undefined)).toBe('');
  });
});
