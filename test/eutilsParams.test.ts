import { describe, expect, it } from 'vitest';
import { EUTILS_PARAM } from '../src/services/eutilsParams.js';
describe('NCBI wire parameters', () => {
  it('keeps the exact upstream spelling and case', () => {
    expect(EUTILS_PARAM).toEqual({
      db: 'db',
      dbFrom: 'dbfrom',
      id: 'id',
      term: 'term',
      field: 'field',
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
      relDate: 'reldate',
      strand: 'strand',
      seqStart: 'seq_start',
      seqStop: 'seq_stop',
      complexity: 'complexity',
      version: 'version',
      holding: 'holding',
      idType: 'idtype',
      cmd: 'cmd',
      linkName: 'linkname',
      bdata: 'bdata',
      apiKey: 'api_key',
      tool: 'tool',
      email: 'email',
    });
  });
});
