/**
 * The exact parameter names NCBI E-utilities accept on the wire.
 *
 * Internal code may use the camelCase keys, but every outbound request must
 * carry the literal string on the right. Keeping the map in one place makes a
 * casing mistake a compile error instead of a silently ignored parameter.
 */
export const EUTILS_PARAM = {
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
} as const;

export type EutilsParamName = (typeof EUTILS_PARAM)[keyof typeof EUTILS_PARAM];
