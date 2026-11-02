import { describe, expect, it } from 'vitest';
import { createHarness, json, text } from './toolHarness.js';
const HISTORY = { db: 'pubmed', web_env: 'MCID_existing', query_key: '1' };
const EPOST_XML = '<ePostResult><QueryKey>1</QueryKey><WebEnv>MCID_post</WebEnv></ePostResult>';
function esearchBody(): unknown {
  return {
    esearchresult: {
      count: '42',
      idlist: ['31452104', '31452105'],
      webenv: 'MCID_new',
      querykey: '2',
      querytranslation: 'cancer',
    },
  };
}
describe('ESearch History and date limits', () => {
  it('stores the result set on the History server by default', async () => {
    const harness = createHarness(() => json(esearchBody()));
    const result = await harness.call('eutils_esearch', {
      db: 'pubmed',
      term: 'cancer',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.params['usehistory']).toBe('y');
    expect(result.structuredContent.history).toEqual({
      db: 'pubmed',
      web_env: 'MCID_new',
      query_key: '2',
    });
  });
  it('appends the search to a supplied History environment', async () => {
    const harness = createHarness(() => json(esearchBody()));
    const result = await harness.call('eutils_esearch', {
      db: 'pubmed',
      term: 'asthma',
      history: HISTORY,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.params).toMatchObject({
      db: 'pubmed',
      WebEnv: 'MCID_existing',
      query_key: '1',
      usehistory: 'y',
    });
  });
  it('sends reldate with datetype', async () => {
    const harness = createHarness(() => json(esearchBody()));
    const result = await harness.call('eutils_esearch', {
      db: 'pubmed',
      term: 'cancer',
      datetype: 'edat',
      reldate: 60,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]?.params['datetype']).toBe('edat');
    expect(harness.calls[0]?.params['reldate']).toBe(60);
  });
  it('rejects a History reference from another database without a request', async () => {
    const harness = createHarness(() => json(esearchBody()));
    const result = await harness.call('eutils_esearch', {
      db: 'pubmed',
      term: 'cancer',
      history: { ...HISTORY, db: 'gene' },
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('does not match history.db');
    expect(harness.calls).toHaveLength(0);
  });
  it('rejects usehistory=false alongside a History reference without a request', async () => {
    const harness = createHarness(() => json(esearchBody()));
    const result = await harness.call('eutils_esearch', {
      db: 'pubmed',
      term: 'cancer',
      history: HISTORY,
      usehistory: false,
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('usehistory=false');
    expect(harness.calls).toHaveLength(0);
  });
  it('rejects reldate without datetype without a request', async () => {
    const harness = createHarness(() => json(esearchBody()));
    const result = await harness.call('eutils_esearch', {
      db: 'pubmed',
      term: 'cancer',
      reldate: 60,
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('reldate requires datetype');
    expect(harness.calls).toHaveLength(0);
  });
  it('documents the PubMed sort values', () => {
    const harness = createHarness(() => json(esearchBody()));
    const description = String(harness.configs.get('eutils_esearch').description);
    expect(description).toContain('"Author"');
    expect(description).toContain('"JournalName"');
    expect(description).not.toContain('first_author');
  });
});
describe('EPost WebEnv', () => {
  it('posts UIDs into a supplied WebEnv', async () => {
    const harness = createHarness(() => text(EPOST_XML, 200, 'text/xml'));
    const result = await harness.call('eutils_epost', {
      db: 'gene',
      uids: ['7173'],
      web_env: 'MCID_existing',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.params).toMatchObject({
      db: 'gene',
      id: '7173',
      WebEnv: 'MCID_existing',
    });
    expect(result.structuredContent).toEqual({
      database: 'gene',
      uploaded: 1,
      history: { db: 'gene', web_env: 'MCID_post', query_key: '1' },
    });
  });
  it('omits WebEnv when web_env is not supplied', async () => {
    const harness = createHarness(() => text(EPOST_XML, 200, 'text/xml'));
    const result = await harness.call('eutils_epost', {
      db: 'gene',
      uids: ['7173'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]?.params['WebEnv']).toBeUndefined();
  });
  it('rejects a malformed web_env without a request', async () => {
    const harness = createHarness(() => text(EPOST_XML, 200, 'text/xml'));
    const result = await harness.call('eutils_epost', {
      db: 'gene',
      uids: ['7173'],
      web_env: 'MCID_bad&db=evil',
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('web_env');
    expect(harness.calls).toHaveLength(0);
  });
  it('rejects a web_env containing whitespace without a request', async () => {
    const harness = createHarness(() => text(EPOST_XML, 200, 'text/xml'));
    const result = await harness.call('eutils_epost', {
      db: 'gene',
      uids: ['7173'],
      web_env: 'MCID space',
      response_format: 'json',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});
