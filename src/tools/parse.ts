/**
 * Pure parsers for E-utilities responses.
 *
 * Kept free of I/O so the response-shape logic — the layer where a wrong
 * envelope index silently yields empty results — can be unit tested against
 * captured NCBI fixtures.
 */

import { EUtilsError, type HistoryRef } from '../types.js';
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

export interface EGQueryEntry {
  db: string;
  menu: string;
  count: number;
  status: string;
}

export interface TranslationEntry {
  from: string;
  to: string;
}

export interface ESearchParsed {
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
  scores?: (number | null)[];
  query_key?: string;
}

export interface AvailableLink {
  dbto: string;
  linkname: string;
  menu_tag?: string;
  html_tag?: string;
}

export interface LinkCheck {
  uid: string;
  has_linkout?: boolean;
  has_neighbor?: boolean;
}

export interface ProviderUrl {
  url: string;
  provider?: string;
  provider_abbr?: string;
  categories: string[];
  attributes: string[];
}

export interface ProviderLink {
  uid: string;
  urls: ProviderUrl[];
}

export interface ELinkParsed {
  groups: LinkGroup[];
  webEnv?: string;
  histories: HistoryRef[];
  availableLinks: AvailableLink[];
  linkChecks: LinkCheck[];
  providerLinks: ProviderLink[];
}

/** Read a required top-level section out of a parsed JSON body. */
export function requireSection<T>(json: unknown, key: string, endpoint: string): T {
  if (json === null || typeof json !== 'object') {
    throw new EUtilsError(
      'parse',
      `${endpoint} returned a body that is not JSON.`,
      'Retry. If it persists, the NCBI response format may have changed.',
    );
  }
  const section = (json as Record<string, unknown>)[key];
  if (section === undefined || section === null) {
    throw new EUtilsError(
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
export function parseESearch(json: unknown, db: string, includeHistory: boolean): ESearchParsed {
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
export function parseESummary(json: unknown, db: string): { uids: string[]; records: CompactRecord[] } {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readTextField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = textOf(record[key]);
    if (value.length > 0) return value;
  }
  return '';
}

function readTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => readTextList(item));
  }
  const record = recordOf(value);
  if (record) {
    const nested = record['category'] ?? record['categories'] ?? record['attribute'] ?? record['attributes'];
    if (nested !== undefined) return readTextList(nested);
    const text = readTextField(record, ['value', '#text', 'name']);
    return text.length > 0 ? [text] : [];
  }
  const text = textOf(value);
  return text.length > 0 ? [text] : [];
}

function ynBoolean(value: string): boolean | undefined {
  if (value === 'Y' || value === 'y') return true;
  if (value === 'N' || value === 'n') return false;
  return undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const record = recordOf(value);
  if (!record) return undefined;
  return errorText(record['message']) ?? errorText(record['#text']) ?? errorText(record['error']);
}

function elinkErrorMessage(json: unknown): string | undefined {
  const root = recordOf(json);
  if (!root) return undefined;
  const top = errorText(root['error']) ?? errorText(root['ERROR']) ?? errorText(root['Error']);
  if (top !== undefined) return top;
  for (const value of asArray(root['linksets'])) {
    const linkset = recordOf(value);
    if (!linkset) continue;
    const message = errorText(linkset['error']) ?? errorText(linkset['ERROR']) ?? errorText(linkset['Error']);
    if (message !== undefined) return message;
  }
  return undefined;
}

function readLinks(value: unknown): { ids: string[]; scores?: (number | null)[] } {
  const ids: string[] = [];
  const scores: (number | null)[] = [];
  let scored = false;

  for (const item of asArray(value)) {
    const record = recordOf(item);
    if (!record) {
      const id = textOf(item);
      if (id.length > 0) {
        ids.push(id);
        scores.push(null);
      }
      continue;
    }
    const id = textOf(record['id']);
    if (id.length === 0) continue;
    ids.push(id);
    const rawScore = textOf(record['score']);
    const score = rawScore.length > 0 ? Number(rawScore) : Number.NaN;
    scores.push(Number.isFinite(score) ? score : null);
    scored = true;
  }

  return scored ? { ids, scores } : { ids };
}

function readAvailableLinks(
  linkset: Record<string, unknown>,
  links: AvailableLink[],
  seen: Set<string>,
): void {
  const checklist = recordOf(linkset['idchecklist']);
  if (!checklist) return;
  for (const value of asArray(checklist['idlinksets'])) {
    const set = recordOf(value);
    if (!set) continue;
    const wrapperDbto = textOf(set['dbto']);
    for (const infoValue of asArray(set['linkinfos'])) {
      const info = recordOf(infoValue);
      if (!info) continue;
      const linkname = textOf(info['linkname']);
      if (linkname.length === 0) continue;
      const dbto = readTextField(info, ['dbto', 'db_to']) || wrapperDbto;
      const key = `${dbto}\u0000${linkname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const menuTag = readTextField(info, ['menutag', 'menu_tag', 'menu']);
      const htmlTag = readTextField(info, ['htmltag', 'html_tag', 'html']);
      links.push({
        dbto,
        linkname,
        ...(menuTag.length > 0 ? { menu_tag: menuTag } : {}),
        ...(htmlTag.length > 0 ? { html_tag: htmlTag } : {}),
      });
    }
  }
}

function readLinkChecks(linkset: Record<string, unknown>, checks: LinkCheck[]): void {
  const checklist = recordOf(linkset['idchecklist']);
  if (!checklist) return;
  for (const value of asArray(checklist['ids'])) {
    const record = recordOf(value);
    if (!record) {
      const uid = textOf(value);
      if (uid.length > 0) checks.push({ uid });
      continue;
    }
    const uid = readTextField(record, ['value', 'id', 'uid']);
    if (uid.length === 0) continue;
    const hasLinkout = ynBoolean(readTextField(record, ['haslinkout', 'has_linkout']));
    const hasNeighbor = ynBoolean(readTextField(record, ['hasneighbor', 'has_neighbor']));
    checks.push({
      uid,
      ...(hasLinkout !== undefined ? { has_linkout: hasLinkout } : {}),
      ...(hasNeighbor !== undefined ? { has_neighbor: hasNeighbor } : {}),
    });
  }
}

function readProviderLinks(linkset: Record<string, unknown>, links: ProviderLink[]): void {
  for (const value of asArray(linkset['idurllist'])) {
    const set = recordOf(value);
    if (!set) continue;
    const uid = readTextField(set, ['id', 'uid']);
    const urls: ProviderUrl[] = [];
    for (const objValue of asArray(set['objurls'])) {
      const objurl = recordOf(objValue);
      if (!objurl) continue;
      const rawUrl = objurl['url'];
      const urlRecord = recordOf(rawUrl);
      const url = urlRecord ? readTextField(urlRecord, ['value', '#text', 'url']) : textOf(rawUrl);
      if (!/^https?:\/\//i.test(url)) continue;
      const provider = recordOf(objurl['provider']);
      const providerName = provider ? readTextField(provider, ['name']) : '';
      const providerAbbr = provider ? readTextField(provider, ['nameabbr', 'name_abbr', 'abbr']) : '';
      urls.push({
        url,
        ...(providerName.length > 0 ? { provider: providerName } : {}),
        ...(providerAbbr.length > 0 ? { provider_abbr: providerAbbr } : {}),
        categories: readTextList(objurl['categories'] ?? objurl['category']),
        attributes: readTextList(objurl['attributes'] ?? objurl['attribute']),
      });
    }
    if (urls.length > 0) links.push({ uid, urls });
  }
}

/**
 * Parse an ELink JSON body.
 *
 * `linksets` is an array at the top level; reading it as an object yields an
 * empty result and silently reports zero links.
 */
export function parseELink(json: unknown): ELinkParsed {
  const failure = elinkErrorMessage(json);
  if (failure !== undefined) {
    throw new EUtilsError(
      'upstream',
      `ELink reported: ${failure}`,
      'Check the cmd, dbfrom, db, linkname, and UID values, then retry. Use eutils_einfo to list databases and link names.',
    );
  }

  const linksets = asArray(requireSection<unknown>(json, 'linksets', 'ELink'));

  const groups: LinkGroup[] = [];
  const histories: HistoryRef[] = [];
  const availableLinks: AvailableLink[] = [];
  const linkChecks: LinkCheck[] = [];
  const providerLinks: ProviderLink[] = [];
  const seenLinks = new Set<string>();
  let webEnv: string | undefined;

  for (const value of linksets) {
    const linkset = recordOf(value);
    if (!linkset) continue;

    const setWebEnv = textOf(linkset['webenv']);
    if (setWebEnv.length > 0) webEnv = setWebEnv;

    for (const entryValue of asArray(linkset['linksetdbs'])) {
      const entry = recordOf(entryValue);
      if (!entry) continue;
      const { ids, scores } = readLinks(entry['links']);
      groups.push({
        dbto: textOf(entry['dbto']),
        linkname: textOf(entry['linkname']),
        count: ids.length,
        ids,
        ...(scores !== undefined ? { scores } : {}),
      });
    }

    for (const entryValue of asArray(linkset['linksetdbhistories'])) {
      const entry = recordOf(entryValue);
      if (!entry) continue;
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

    readAvailableLinks(linkset, availableLinks, seenLinks);
    readLinkChecks(linkset, linkChecks);
    readProviderLinks(linkset, providerLinks);
  }

  return {
    groups,
    ...(webEnv ? { webEnv } : {}),
    histories,
    availableLinks,
    linkChecks,
    providerLinks,
  };
}

/** Parse the EGQuery XML body, which reports a count per database. */
export function parseEGQuery(xml: unknown): EGQueryEntry[] {
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
export function parseESpell(
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
export function parseEPost(xml: unknown, db: string): HistoryRef | undefined {
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
export function parseECitMatch(body: string, inputs: readonly string[]): CitationMatch[] {
  const byKey = new Map<string, string>();
  for (const input of inputs) {
    const key = (input.split('|')[5] ?? '').trim();
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, input);
  }

  return body
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parts = line.split('|');
      const key = (parts[5] ?? '').trim();
      const pmid = parts.length >= 7 ? (parts[6] ?? '').trim() : '';
      return {
        input: byKey.get(key) ?? inputs[index] ?? '',
        journal: parts[0] ?? '',
        year: parts[1] ?? '',
        volume: parts[2] ?? '',
        first_page: parts[3] ?? '',
        author: parts[4] ?? '',
        key,
        pmid: /^\d+$/.test(pmid) ? pmid : '',
        matched: /^\d+$/.test(pmid),
      };
    });
}
