/**
 * Pure parsers for E-utilities responses.
 *
 * Kept free of I/O so the response-shape logic — the layer where a wrong
 * envelope index silently yields empty results — can be unit tested against
 * captured NCBI fixtures.
 */

import { EutilsError, type HistoryRef } from '../types.js';
import { asArray, textOf } from '../services/xml.js';

/** Databases whose DocSums carry article metadata rather than sequence metadata. */
const PUBMED = 'pubmed';

/** Keys dropped from generic DocSums because they are verbose or internal. */
const GENERIC_DROP = new Set([
  'references',
  'doccontriblist',
  'srccontriblist',
  'attributes',
  'history',
  'availablefromurl',
  'recordstatus',
  'vernaculartitle',
  'sorttitle',
  'sortpubdate',
  'sortfirstauthor',
  'nlmuniqueid',
  'locationlabel',
  'reportnumber',
  'publisherlocation',
]);

const GENERIC_FIELD_LIMIT = 15;

export interface CompactRecord {
  uid: string;
  [key: string]: unknown;
}

export interface EgqueryEntry {
  db: string;
  menu: string;
  count: number;
  status: string;
}

export interface TranslationEntry {
  from: string;
  to: string;
}

export interface EsearchParsed {
  total: number;
  uids: string[];
  queryTranslation: string;
  translations: TranslationEntry[];
  history?: HistoryRef;
}

export interface LinkGroup {
  dbto: string;
  linkname: string;
  count: number;
  ids: string[];
  query_key?: string;
}

export interface ElinkParsed {
  groups: LinkGroup[];
  webEnv?: string;
  histories: HistoryRef[];
}

/** Read a required top-level section out of a parsed JSON body. */
export function requireSection<T>(json: unknown, key: string, endpoint: string): T {
  if (json === null || typeof json !== 'object') {
    throw new EutilsError(
      'parse',
      `${endpoint} returned a body that is not JSON.`,
      'Retry. If it persists, the NCBI response format may have changed.',
    );
  }
  const section = (json as Record<string, unknown>)[key];
  if (section === undefined || section === null) {
    throw new EutilsError(
      'parse',
      `${endpoint} JSON had no '${key}' section.`,
      'Retry. If it persists, the NCBI response format may have changed.',
    );
  }
  return section as T;
}

/** Build a History reference from the ESearch fields that carry it. */
export function historyFrom(db: string, webEnv: unknown, queryKey: unknown): HistoryRef | undefined {
  if (typeof webEnv !== 'string' || webEnv.length === 0) return undefined;
  if (typeof queryKey !== 'string' && typeof queryKey !== 'number') return undefined;
  const key = String(queryKey);
  if (key.length === 0) return undefined;
  return { db, web_env: webEnv, query_key: key };
}

/** Parse an ESearch JSON body. */
export function parseEsearch(json: unknown, db: string, includeHistory: boolean): EsearchParsed {
  const root = requireSection<Record<string, unknown>>(json, 'esearchresult', 'ESearch');

  const history = includeHistory ? historyFrom(db, root['webenv'], root['querykey']) : undefined;

  return {
    total: Number(textOf(root['count'])) || 0,
    uids: asArray(root['idlist'])
      .map((uid) => textOf(uid))
      .filter((uid) => uid.length > 0),
    queryTranslation: textOf(root['querytranslation']),
    translations: (asArray(root['translationset']) as Record<string, unknown>[]).map((entry) => ({
      from: textOf(entry['from']),
      to: textOf(entry['to']),
    })),
    ...(history ? { history } : {}),
  };
}

/** Reduce a PubMed DocSum to the fields a reader actually needs. */
export function compactPubmed(uid: string, rec: Record<string, unknown>): CompactRecord {
  const articleIds = asArray(rec['articleids']) as Record<string, unknown>[];
  const findId = (type: string): string | undefined => {
    const found = articleIds.find((entry) => textOf(entry['idtype']) === type);
    const value = found ? textOf(found['value']) : '';
    return value.length > 0 ? value : undefined;
  };

  const doi = findId('doi');
  const pmcid = findId('pmc');

  return {
    uid,
    title: textOf(rec['title']),
    authors: (asArray(rec['authors']) as Record<string, unknown>[])
      .map((author) => textOf(author['name']))
      .filter((name) => name.length > 0),
    journal: textOf(rec['fulljournalname']) || textOf(rec['source']),
    source: textOf(rec['source']),
    pubdate: textOf(rec['pubdate']),
    volume: textOf(rec['volume']),
    issue: textOf(rec['issue']),
    pages: textOf(rec['pages']),
    ...(doi ? { doi } : {}),
    ...(pmcid ? { pmcid } : {}),
    pubtype: asArray(rec['pubtype'])
      .map((t) => textOf(t))
      .filter((t) => t.length > 0),
    lang: asArray(rec['lang'])
      .map((t) => textOf(t))
      .filter((t) => t.length > 0),
  };
}

/** Reduce a DocSum from any other database, keeping scalar fields only. */
export function compactGeneric(uid: string, rec: Record<string, unknown>): CompactRecord {
  const out: CompactRecord = { uid };
  let taken = 0;

  for (const [key, value] of Object.entries(rec)) {
    if (taken >= GENERIC_FIELD_LIMIT) break;
    if (GENERIC_DROP.has(key)) continue;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      out[key] = trimmed;
      taken += 1;
      continue;
    }

    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      const items = value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
      if (items.length === 0) continue;
      out[key] = items;
      taken += 1;
    }
  }

  return out;
}

/** Parse an ESummary JSON body into compact records. */
export function parseEsummary(json: unknown, db: string): { uids: string[]; records: CompactRecord[] } {
  const root = requireSection<Record<string, unknown>>(json, 'result', 'ESummary');
  const uids = asArray(root['uids'])
    .map((uid) => textOf(uid))
    .filter((uid) => uid.length > 0);

  const records = uids.map((uid) => {
    const rec = root[uid];
    if (rec === null || typeof rec !== 'object') return { uid };
    return db === PUBMED
      ? compactPubmed(uid, rec as Record<string, unknown>)
      : compactGeneric(uid, rec as Record<string, unknown>);
  });

  return { uids, records };
}

/**
 * Parse an ELink JSON body.
 *
 * `linksets` is an array at the top level; reading it as an object yields an
 * empty result and silently reports zero links.
 */
export function parseElink(json: unknown): ElinkParsed {
  const linksets = asArray(requireSection<Record<string, unknown>[]>(json, 'linksets', 'ELink')) as Record<
    string,
    unknown
  >[];

  const groups: LinkGroup[] = [];
  const histories: HistoryRef[] = [];
  let webEnv: string | undefined;

  for (const linkset of linksets) {
    const setWebEnv = textOf(linkset['webenv']);
    if (setWebEnv.length > 0) webEnv = setWebEnv;

    for (const entry of asArray(linkset['linksetdbs']) as Record<string, unknown>[]) {
      const ids = asArray(entry['links'])
        .map((id) => textOf(id))
        .filter((id) => id.length > 0);
      groups.push({
        dbto: textOf(entry['dbto']),
        linkname: textOf(entry['linkname']),
        count: ids.length,
        ids,
      });
    }

    for (const entry of asArray(linkset['linksetdbhistories']) as Record<string, unknown>[]) {
      const queryKey = textOf(entry['querykey']);
      const dbto = textOf(entry['dbto']);
      groups.push({
        dbto,
        linkname: textOf(entry['linkname']),
        count: 0,
        ids: [],
        query_key: queryKey,
      });
      if (webEnv && queryKey) {
        histories.push({ db: dbto, web_env: webEnv, query_key: queryKey });
      }
    }
  }

  return { groups, ...(webEnv ? { webEnv } : {}), histories };
}

/** Parse the EGQuery XML body, which reports a count per database. */
export function parseEgquery(xml: unknown): EgqueryEntry[] {
  const root = (xml as Record<string, unknown> | undefined)?.['eGQueryResult'] as
    Record<string, unknown> | undefined;

  return (asArray(root?.['ResultItem']) as Record<string, unknown>[])
    .map((item) => ({
      db: textOf(item['DbName']),
      menu: textOf(item['MenuName']),
      count: Number(textOf(item['Count'])) || 0,
      status: textOf(item['Status']),
    }))
    .filter((entry) => entry.db.length > 0);
}

/** Parse the ESpell XML body. */
export function parseEspell(
  xml: unknown,
  fallbackTerm: string,
): { query: string; corrected: string; changed: boolean } {
  const root = (xml as Record<string, unknown> | undefined)?.['eSpellResult'] as
    Record<string, unknown> | undefined;

  const query = textOf(root?.['Query']) || fallbackTerm;
  const corrected = textOf(root?.['CorrectedQuery']);

  return {
    query,
    corrected,
    changed: corrected.length > 0 && corrected.toLowerCase() !== query.toLowerCase(),
  };
}

/** Parse the EPost XML body and build its History reference. */
export function parseEpost(xml: unknown, db: string): HistoryRef | undefined {
  const root = (xml as Record<string, unknown> | undefined)?.['ePostResult'] as
    Record<string, unknown> | undefined;
  return historyFrom(db, textOf(root?.['WebEnv']), textOf(root?.['QueryKey']));
}

export interface CitationMatch {
  input: string;
  journal: string;
  year: string;
  volume: string;
  first_page: string;
  author: string;
  key: string;
  pmid: string;
  matched: boolean;
}

/**
 * Parse ECitMatch's pipe-delimited output.
 *
 * The reply echoes each input line with the PMID appended as a seventh
 * field, so fields are read positionally from the left. NCBI normalises the
 * request's carriage returns to line feeds in the reply, but all three line
 * endings are accepted in case that changes.
 */
export function parseEcitmatch(body: string, inputs: readonly string[]): CitationMatch[] {
  return body
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parts = line.split('|');
      const pmid = parts.length >= 7 ? (parts[6] ?? '').trim() : '';
      return {
        input: inputs[index] ?? '',
        journal: parts[0] ?? '',
        year: parts[1] ?? '',
        volume: parts[2] ?? '',
        first_page: parts[3] ?? '',
        author: parts[4] ?? '',
        key: parts[5] ?? '',
        pmid: /^\d+$/.test(pmid) ? pmid : '',
        matched: /^\d+$/.test(pmid),
      };
    });
}
