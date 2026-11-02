import { describe, expect, it } from 'vitest';
import { EUTILS_PARAM } from '../src/services/eutilsParams.js';

describe('NCBI wire parameters', () => {
  it('keeps the exact upstream spelling and case', () => {
    expect(EUTILS_PARAM).toEqual({
      db: 'db',
      dbFrom: 'dbfrom',
      id: 'id',
      term: 'term',
      retMax: 'retmax',
      retStart: 'retstart',
      useHistory: 'usehistory',
      webEnv: 'WebEnv',
      queryKey: 'query_key',
      retType: 'rettype',
      retMode: 'retmode',
      minDate: 'mindate',
      maxDate: 'maxdate',
      dateType: 'datetype',
      sort: 'sort',
      cmd: 'cmd',
      linkName: 'linkname',
      bdata: 'bdata',
      apiKey: 'api_key',
      tool: 'tool',
      email: 'email',
    });
  });
});
