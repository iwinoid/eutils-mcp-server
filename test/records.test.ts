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
