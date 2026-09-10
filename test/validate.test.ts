import { describe, expect, it } from 'vitest';
import {
  chunk,
  isKnownDatabase,
  parseUids,
  validateDatabase,
  validateHistory,
  validateRetmax,
} from '../src/services/validate.js';
import { EutilsError } from '../src/types.js';
import { ENTREZ_DATABASES } from '../src/constants.js';

describe('validateDatabase', () => {
  it('accepts every database NCBI reports', () => {
    for (const db of ENTREZ_DATABASES) {
      expect(validateDatabase(db)).toBe(db);
    }
  });

  it('normalises case and surrounding whitespace', () => {
    expect(validateDatabase('  PubMed ')).toBe('pubmed');
  });

  it('rejects a name that tries to splice an extra parameter', () => {
    expect(() => validateDatabase('pubmed&api_key=stolen')).toThrow(EutilsError);
  });

  it('rejects a name containing a path separator', () => {
    expect(() => validateDatabase('../protein')).toThrow(EutilsError);
  });

  it('rejects a name containing a fragment or query character', () => {
    expect(() => validateDatabase('pubmed#1')).toThrow(EutilsError);
    expect(() => validateDatabase('pubmed?x=1')).toThrow(EutilsError);
  });

  it('rejects an unknown but well-formed name, and suggests einfo', () => {
    try {
      validateDatabase('notarealdb');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EutilsError);
      expect((error as EutilsError).suggestion).toContain('eutils_einfo');
    }
  });

  it('rejects an empty name', () => {
    expect(() => validateDatabase('')).toThrow(EutilsError);
  });
});

describe('isKnownDatabase', () => {
  it('distinguishes known from unknown', () => {
    expect(isKnownDatabase('pubmed')).toBe(true);
    expect(isKnownDatabase('nope')).toBe(false);
  });
});

describe('parseUids', () => {
  it('splits a comma-separated string', () => {
    expect(parseUids('1,2,3')).toEqual(['1', '2', '3']);
  });

  it('accepts an array and trims entries', () => {
    expect(parseUids([' 1 ', '2'])).toEqual(['1', '2']);
  });

  it('accepts accession.version identifiers', () => {
    expect(parseUids('NP_005537.3')).toEqual(['NP_005537.3']);
  });

  it('drops empty entries', () => {
    expect(parseUids('1,,2,')).toEqual(['1', '2']);
  });

  it('rejects a UID containing URL metacharacters', () => {
    expect(() => parseUids('1&db=evil')).toThrow(EutilsError);
  });

  it('rejects an empty list', () => {
    expect(() => parseUids('')).toThrow(EutilsError);
  });
});

describe('validateRetmax', () => {
  it('applies the endpoint cap when unset', () => {
    expect(validateRetmax(undefined, 'esummary')).toBe(20);
  });

  it('accepts a value at the cap', () => {
    expect(validateRetmax(500, 'esummary')).toBe(500);
  });

  it('refuses a value above the cap instead of clamping', () => {
    expect(() => validateRetmax(501, 'esummary')).toThrow(EutilsError);
  });

  it('points at the History server in the suggestion', () => {
    try {
      validateRetmax(20_000, 'esearch');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as EutilsError).suggestion).toContain('usehistory');
    }
  });

  it('rejects a negative value', () => {
    expect(() => validateRetmax(-1, 'esearch')).toThrow(EutilsError);
  });

  it('allows zero, which fetches only the count', () => {
    expect(validateRetmax(0, 'esearch')).toBe(0);
  });
});

describe('chunk', () => {
  it('splits into even batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('rejects a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('validateHistory', () => {
  const good = { db: 'pubmed', web_env: 'MCID_6aa2fc63317d842d950f2fa1', query_key: '1' };

  it('accepts a well-formed reference', () => {
    expect(validateHistory(good)).toEqual(good);
  });

  it('rejects an empty web_env', () => {
    expect(() => validateHistory({ ...good, web_env: '' })).toThrow(EutilsError);
  });

  it('rejects a web_env containing an ampersand', () => {
    expect(() => validateHistory({ ...good, web_env: 'abc&db=evil' })).toThrow(EutilsError);
  });

  it('rejects a non-numeric query_key', () => {
    expect(() => validateHistory({ ...good, query_key: '1 OR 1' })).toThrow(EutilsError);
  });

  it('rejects an unknown database', () => {
    expect(() => validateHistory({ ...good, db: 'evil' })).toThrow(EutilsError);
  });
});
