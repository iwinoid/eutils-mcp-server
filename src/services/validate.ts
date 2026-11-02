import { DB_NAME_PATTERN, ENTREZ_DATABASES, MAX_UIDS_PER_CALL, RETMAX_CAPS } from '../constants.js';
import { EUtilsError } from '../types.js';
const KNOWN_DATABASES = new Set<string>(ENTREZ_DATABASES);
export function isKnownDatabase(value: string): boolean {
  return KNOWN_DATABASES.has(value);
}
export function validateDatabase(value: string): string {
  const normalised = value.trim().toLowerCase();
  if (!DB_NAME_PATTERN.test(normalised)) {
    throw new EUtilsError(
      'validation',
      `'${value}' is not a valid Entrez database name.`,
      'Use lowercase letters, digits, and underscores only. Call eutils_einfo to list databases.',
    );
  }
  if (!KNOWN_DATABASES.has(normalised)) {
    const sample = ENTREZ_DATABASES.slice(0, 12).join(', ');
    throw new EUtilsError(
      'validation',
      `'${normalised}' is not a known Entrez database.`,
      `Known databases include: ${sample}. Call eutils_einfo for the full list.`,
    );
  }
  return normalised;
}
export function parseUids(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : splitUidString(input);
  const uids: string[] = [];
  for (const item of raw) {
    const uid = String(item).trim();
    if (uid.length === 0) continue;
    if (!/^[A-Za-z0-9_.|-]{1,64}$/.test(uid)) {
      throw new EUtilsError(
        'validation',
        `'${uid}' does not look like a valid UID or accession.`,
        'Pass integers such as 31452104, or accessions such as NP_005537.3.',
      );
    }
    uids.push(uid);
  }
  if (uids.length === 0) {
    throw new EUtilsError(
      'validation',
      'No UIDs were provided.',
      'Supply at least one UID or accession, or pass a history reference instead.',
    );
  }
  if (uids.length > MAX_UIDS_PER_CALL) {
    throw new EUtilsError(
      'validation',
      `The call contains ${uids.length} UIDs, over the ${MAX_UIDS_PER_CALL}-UID ceiling.`,
      'Split the list into smaller calls, or use a History set built from a query.',
    );
  }
  return uids;
}
function splitUidString(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {}
  }
  return input.split(',');
}
export function validateRetmax(value: number | undefined, endpoint: keyof typeof RETMAX_CAPS): number {
  const cap = RETMAX_CAPS[endpoint];
  const resolved = value ?? Math.min(20, cap);
  if (resolved < 0) {
    throw new EUtilsError(
      'validation',
      'retmax cannot be negative.',
      'Use a value between 0 and the endpoint cap.',
    );
  }
  if (resolved > cap) {
    throw new EUtilsError(
      'validation',
      `retmax ${resolved} exceeds the ${cap}-record ceiling for this endpoint.`,
      `Lower retmax to ${cap} or less and page with retstart, or store the set on the History server with usehistory and read it in batches.`,
    );
  }
  return resolved;
}
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
export function validateWebEnv(value: string): string {
  const webEnv = value.trim();
  if (webEnv.length === 0 || /[\s&?]/.test(webEnv)) {
    throw new EUtilsError(
      'validation',
      'The supplied web_env is empty or malformed.',
      'Pass the history object returned by a previous eutils_esearch, eutils_epost, or eutils_elink call unchanged.',
    );
  }
  return webEnv;
}
export function validateHistory(history: { db: string; web_env: string; query_key: string }): {
  db: string;
  web_env: string;
  query_key: string;
} {
  const db = validateDatabase(history.db);
  const webEnv = validateWebEnv(history.web_env);
  const queryKey = history.query_key.trim();
  if (!/^[0-9]{1,10}$/.test(queryKey)) {
    throw new EUtilsError(
      'validation',
      `query_key '${queryKey}' is not a valid History query key.`,
      'query_key is a small integer. Pass the history object returned by a previous call unchanged.',
    );
  }
  return { db, web_env: webEnv, query_key: queryKey };
}
