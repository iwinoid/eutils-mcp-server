import { describe, expect, it } from 'vitest';
import { createHarness, json, text } from './toolHarness.js';

const HISTORY = { db: 'pubmed', web_env: 'MCID_x', query_key: '1' };

function esummaryBody(count: number): unknown {
  const uids: string[] = [];
  const result: Record<string, unknown> = {};
  for (let i = 1; i <= count; i += 1) {
    const uid = String(30000000 + i);
    uids.push(uid);
    result[uid] = { title: 'Title ' + i, authors: [{ name: 'Author ' + i }] };
  }
  return { result: { uids, ...result } };
}

describe('ESummary History paging', () => {
  it('marks a full page as having more and gives a real next_offset', async () => {
    const harness = createHarness(() => json(esummaryBody(20)));
    const result = await harness.call('eutils_esummary', {
      history: HISTORY,
      retmax: 20,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.count).toBe(20);
    expect(result.structuredContent.has_more).toBe(true);
    expect(result.structuredContent.next_offset).toBe(20);
    expect(result.structuredContent.total).toBeUndefined();
  });

  it('uses retstart for the next offset', async () => {
    const harness = createHarness(() => json(esummaryBody(20)));
    const result = await harness.call('eutils_esummary', {
      history: HISTORY,
      retstart: 100,
      retmax: 20,
      response_format: 'json',
    });
    expect(result.structuredContent.offset).toBe(100);
    expect(result.structuredContent.has_more).toBe(true);
    expect(result.structuredContent.next_offset).toBe(120);
  });

  it('does not invent a next page for explicit UIDs with a missing record', async () => {
    const harness = createHarness(() => json({ result: { uids: ['1'], '1': { title: 'One' } } }));
    const result = await harness.call('eutils_esummary', {
      db: 'pubmed',
      uids: ['1', '2'],
      response_format: 'json',
    });
    expect(result.structuredContent.has_more).toBe(false);
    expect(result.structuredContent.next_offset).toBeUndefined();
  });
});

describe('EFetch truncation', () => {
  const LONG_BODY = 'H'.repeat(20000) + 'T'.repeat(10000);

  it('keeps head and tail for a single record fetched through history', async () => {
    const harness = createHarness(() => text(LONG_BODY));
    const result = await harness.call('eutils_efetch', {
      db: 'pubmed',
      history: HISTORY,
      retmax: 1,
      response_format: 'markdown',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.truncated).toBe(true);
    expect(String(result.structuredContent.text).length).toBeLessThanOrEqual(25000);
    expect(String(result.content[0].text)).toContain('head and tail');
    expect(String(result.content[0].text)).toContain('characters omitted');
  });

  it('keeps head and tail for a single explicit UID', async () => {
    const harness = createHarness(() => text(LONG_BODY));
    const result = await harness.call('eutils_efetch', {
      db: 'pubmed',
      uids: ['31452104'],
      response_format: 'markdown',
    });
    expect(result.structuredContent.truncated).toBe(true);
    expect(String(result.content[0].text)).toContain('head and tail');
  });
});

describe('EFetch database format defaults', () => {
  it('sends no format parameters for PMC and reports the default', async () => {
    const harness = createHarness(() => text('<pmc-articleset />'));
    const result = await harness.call('eutils_efetch', {
      db: 'pmc',
      uids: ['1'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).not.toHaveProperty('rettype');
    expect(harness.calls[0]!.params).not.toHaveProperty('retmode');
    expect(result.structuredContent.rettype).toBe('default');
    expect(result.structuredContent.retmode).toBe('default');
  });

  it('fetches gene records without a format instead of throwing', async () => {
    const harness = createHarness(() => text('<Entrezgene />'));
    const result = await harness.call('eutils_efetch', {
      db: 'gene',
      uids: ['2'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).not.toHaveProperty('rettype');
    expect(harness.calls[0]!.params).not.toHaveProperty('retmode');
    expect(result.structuredContent.rettype).toBe('default');
    expect(result.structuredContent.retmode).toBe('default');
  });

  it('keeps PubMed abstracts as the default', async () => {
    const harness = createHarness(() => text('Abstract text'));
    const result = await harness.call('eutils_efetch', {
      db: 'pubmed',
      uids: ['31452104'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).toMatchObject({ rettype: 'abstract', retmode: 'text' });
    expect(result.structuredContent.rettype).toBe('abstract');
    expect(result.structuredContent.retmode).toBe('text');
  });

  it('maps a PMC text request to MEDLINE', async () => {
    const harness = createHarness(() => text('PMID- 1'));
    const result = await harness.call('eutils_efetch', {
      db: 'pmc',
      uids: ['1'],
      retmode: 'text',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).toMatchObject({ rettype: 'medline', retmode: 'text' });
    expect(result.structuredContent.rettype).toBe('medline');
  });

  it('sends only retmode when XML is requested without a rettype', async () => {
    const harness = createHarness(() => text('<PubmedArticleSet />'));
    const result = await harness.call('eutils_efetch', {
      db: 'pubmed',
      uids: ['31452104'],
      retmode: 'xml',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).not.toHaveProperty('rettype');
    expect(harness.calls[0]!.params['retmode']).toBe('xml');
    expect(result.structuredContent.rettype).toBe('default');
    expect(result.structuredContent.retmode).toBe('xml');
  });

  it('sends FASTA with the sequence options for a sequence database', async () => {
    const harness = createHarness(() => text('>seq\nMAAA'));
    const result = await harness.call('eutils_efetch', {
      db: 'nuccore',
      uids: ['21614549'],
      strand: 1,
      seq_start: 1,
      seq_stop: 100,
      complexity: 3,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).toMatchObject({
      rettype: 'fasta',
      retmode: 'text',
      strand: 1,
      seq_start: 1,
      seq_stop: 100,
      complexity: 3,
    });
    expect(result.structuredContent.rettype).toBe('fasta');
  });
});

describe('EFetch sequence option validation', () => {
  it('rejects sequence options for a non-sequence database before any request', async () => {
    const harness = createHarness(() => text('unexpected'));
    const result = await harness.call('eutils_efetch', {
      db: 'pubmed',
      uids: ['31452104'],
      seq_start: 1,
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('Sequence options');
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects strand on a sequence database other than nuccore and nucleotide', async () => {
    const harness = createHarness(() => text('unexpected'));
    const result = await harness.call('eutils_efetch', {
      db: 'protein',
      uids: ['NP_005537.3'],
      strand: 1,
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('strand is only supported');
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects seq_stop before seq_start', async () => {
    const harness = createHarness(() => text('unexpected'));
    const result = await harness.call('eutils_efetch', {
      db: 'nuccore',
      uids: ['21614549'],
      seq_start: 100,
      seq_stop: 50,
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('seq_stop');
    expect(harness.calls).toHaveLength(0);
  });
});
