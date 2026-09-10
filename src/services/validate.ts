import { DB_NAME_PATTERN, ENTREZ_DATABASES, RETMAX_CAPS } from '../constants.js';
import { EutilsError } from '../types.js';

const KNOWN_DATABASES = new Set<string>(ENTREZ_DATABASES);

/** True when `value` is one of the 38 Entrez databases. */
export function isKnownDatabase(value: string): boolean {
  return KNOWN_DATABASES.has(value);
}

/**
 * Validate a database name.
 *
 * Two gates, in order. The character-class guard blocks anything that could
 * splice a query parameter or escape the endpoint, and it stays correct if
 * NCBI adds a database. The allowlist then rejects plausible-but-unknown
 * names with a helpful message.
 */
export function validateDatabase(value: string): string {
  const normalised = value.trim().toLowerCase();

  if (!DB_NAME_PATTERN.test(normalised)) {
    throw new EutilsError(
      'validation',
      `'${value}' is not a valid Entrez database name.`,
      'Use lowercase letters, digits, and underscores only. Call eutils_einfo to list databases.',
    );
  }

  if (!KNOWN_DATABASES.has(normalised)) {
    const sample = ENTREZ_DATABASES.slice(0, 12).join(', ');
    throw new EutilsError(
      'validation',
      `'${normalised}' is not a known Entrez database.`,
      `Known databases include: ${sample}. Call eutils_einfo for the full list.`,
    );
  }

  return normalised;
}

/**
 * Parse a UID list from either an array or a comma-separated string.
 *
 * UIDs are opaque to us, so they are only checked for shape: non-empty,
 * no whitespace, no URL metacharacters.
 */
export function parseUids(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(',');
  const uids: string[] = [];

  for (const item of raw) {
    const uid = String(item).trim();
    if (uid.length === 0) continue;
    if (!/^[A-Za-z0-9_.|-]{1,64}$/.test(uid)) {
      throw new EutilsError(
        'validation',
        `'${uid}' does not look like a valid UID or accession.`,
        'Pass integers such as 31452104, or accessions such as NP_005537.3.',
      );
    }
    uids.push(uid);
  }

  if (uids.length === 0) {
    throw new EutilsError(
      'validation',
      'No UIDs were provided.',
      'Supply at least one UID or accession, or pass a history reference instead.',
    );
  }

  return uids;
}

/** Enforce a per-endpoint retmax ceiling, refusing rather than clamping. */
export function validateRetmax(value: number | undefined, endpoint: keyof typeof RETMAX_CAPS): number {
  const cap = RETMAX_CAPS[endpoint];
  const resolved = value ?? Math.min(20, cap);

  if (resolved < 0) {
    throw new EutilsError('validation', 'retmax cannot be negative.', 'Use a value between 0 and the endpoint cap.');
  }
  if (resolved > cap) {
    throw new EutilsError(
      'validation',
      `retmax ${resolved} exceeds the ${cap}-record ceiling for this endpoint.`,
      `Lower retmax to ${cap} or less and page with retstart, or store the set on the History server with usehistory and read it in batches.`,
    );
  }
  return resolved;
}

/** Split a list into fixed-size chunks, used for internal batching. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Validate a History reference supplied by the caller. */
export function validateHistory(history: {
  db: string;
  web_env: string;
  query_key: string;
}): { db: string; web_env: string; query_key: string } {
  const db = validateDatabase(history.db);
  const webEnv = history.web_env.trim();
  const queryKey = history.query_key.trim();

  if (webEnv.length === 0 || /[\s&?]/.test(webEnv)) {
    throw new EutilsError(
      'validation',
      'The supplied web_env is empty or malformed.',
      'Pass the history object returned by a previous eutils_esearch, eutils_epost, or eutils_elink call unchanged.',
    );
  }
  if (!/^[0-9]{1,10}$/.test(queryKey)) {
    throw new EutilsError(
      'validation',
      `query_key '${queryKey}' is not a valid History query key.`,
      'query_key is a small integer. Pass the history object returned by a previous call unchanged.',
    );
  }

  return { db, web_env: webEnv, query_key: queryKey };
}
