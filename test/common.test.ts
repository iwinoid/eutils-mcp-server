/**
 * Tests for the shared tool-layer helpers.
 *
 * These cover source resolution, which decides whether a request uses an
 * explicit UID list or a History handle — and which guards the History
 * fields before they reach a URL.
 */

import { describe, expect, it } from 'vitest';
import { applySource, resolveDbAndSource, resolveSource, requireTerm } from '../src/tools/common.js';
import { EutilsError } from '../src/types.js';

const GOOD_HISTORY = { db: 'pubmed', web_env: 'MCID_abc123', query_key: '1' };

describe('resolveSource', () => {
  it('accepts an array of UIDs', () => {
    const source = resolveSource({ uids: ['1', '2'] }, 'pubmed');
    expect(source.id).toBe('1,2');
    expect(source.count).toBe(2);
    expect(source.db).toBe('pubmed');
  });

  it('accepts a comma-separated UID string', () => {
    expect(resolveSource({ uids: '1,2,3' }, 'gene').id).toBe('1,2,3');
  });

  it('accepts a History reference', () => {
    const source = resolveSource({ history: GOOD_HISTORY }, 'pubmed');
    expect(source.webEnv).toBe('MCID_abc123');
    expect(source.queryKey).toBe('1');
    expect(source.id).toBeUndefined();
  });

  it('refuses to combine uids and history', () => {
    expect(() => resolveSource({ uids: ['1'], history: GOOD_HISTORY }, 'pubmed')).toThrow(EutilsError);
  });

  it('refuses an empty request', () => {
    expect(() => resolveSource({}, 'pubmed')).toThrow(EutilsError);
  });

  it('refuses a blank UID list', () => {
    expect(() => resolveSource({ uids: '  ' }, 'pubmed')).toThrow(EutilsError);
  });

  // Regression: validateHistory existed and was unit tested, but nothing
  // called it, so a malformed web_env travelled all the way to NCBI.
  it('rejects a web_env containing an ampersand', () => {
    expect(() => resolveSource({ history: { ...GOOD_HISTORY, web_env: 'abc&db=evil' } }, 'pubmed')).toThrow(
      EutilsError,
    );
  });

  it('rejects a web_env containing whitespace', () => {
    expect(() => resolveSource({ history: { ...GOOD_HISTORY, web_env: 'abc def' } }, 'pubmed')).toThrow(
      EutilsError,
    );
  });

  it('rejects a non-numeric query_key', () => {
    expect(() => resolveSource({ history: { ...GOOD_HISTORY, query_key: '1 OR 1' } }, 'pubmed')).toThrow(
      EutilsError,
    );
  });

  it('rejects a UID containing URL metacharacters', () => {
    expect(() => resolveSource({ uids: ['1&db=evil'] }, 'pubmed')).toThrow(EutilsError);
  });
});

describe('resolveDbAndSource', () => {
  it('takes the database from an explicit db argument', () => {
    expect(resolveDbAndSource({ db: 'gene', uids: ['1'] }).db).toBe('gene');
  });

  it('takes the database from the History handle when db is omitted', () => {
    expect(resolveDbAndSource({ history: GOOD_HISTORY }).db).toBe('pubmed');
  });

  it('accepts a matching db and history pair', () => {
    expect(resolveDbAndSource({ db: 'pubmed', history: GOOD_HISTORY }).db).toBe('pubmed');
  });

  it('rejects a db that contradicts the History handle', () => {
    try {
      resolveDbAndSource({ db: 'gene', history: GOOD_HISTORY });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EutilsError);
      expect((error as EutilsError).message).toContain('does not match');
    }
  });

  it('rejects a request with no database at all', () => {
    expect(() => resolveDbAndSource({ uids: ['1'] })).toThrow(EutilsError);
  });

  it('normalises the database name', () => {
    expect(resolveDbAndSource({ db: ' PubMed ', uids: ['1'] }).db).toBe('pubmed');
  });

  it('rejects an unknown database', () => {
    expect(() => resolveDbAndSource({ db: 'nope', uids: ['1'] })).toThrow(EutilsError);
  });
});

describe('applySource', () => {
  it('writes db and id for a UID source', () => {
    const params: Record<string, unknown> = {};
    applySource(params, { db: 'pubmed', id: '1,2', count: 2 });
    expect(params).toEqual({ db: 'pubmed', id: '1,2' });
  });

  it('writes WebEnv and query_key for a History source', () => {
    const params: Record<string, unknown> = {};
    applySource(params, { db: 'pubmed', webEnv: 'MCID_x', queryKey: '1' });
    expect(params).toEqual({ db: 'pubmed', WebEnv: 'MCID_x', query_key: '1' });
  });

  it('leaves db alone when setDb is false, so a target db survives', () => {
    const params: Record<string, unknown> = { db: 'protein' };
    applySource(params, { db: 'gene', id: '1' }, { setDb: false });
    expect(params['db']).toBe('protein');
    expect(params['id']).toBe('1');
  });
});

describe('requireTerm', () => {
  it('returns a trimmed term', () => {
    expect(requireTerm('  cancer  ')).toBe('cancer');
  });

  it('rejects a blank term', () => {
    expect(() => requireTerm('   ')).toThrow(EutilsError);
    expect(() => requireTerm(undefined)).toThrow(EutilsError);
  });

  it('rejects an over-long term', () => {
    expect(() => requireTerm('x'.repeat(2001))).toThrow(EutilsError);
  });

  it('accepts a term at the limit', () => {
    expect(requireTerm('x'.repeat(2000))).toHaveLength(2000);
  });
});
