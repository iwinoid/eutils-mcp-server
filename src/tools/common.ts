import * as z from 'zod';
import { EutilsError, type HistoryRef } from '../types.js';
import { parseUids, validateDatabase, validateHistory } from '../services/validate.js';

/** Output format shared by every tool. */
export const ResponseFormatSchema = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe(
    "Output format: 'markdown' for human-readable text, or 'json' for machine-readable data. Default: 'markdown'.",
  );

/** Reference to a UID set held on the NCBI History server. */
export const HistorySchema = z
  .object({
    db: z.string().min(1).describe('Entrez database the UID set belongs to, for example "pubmed".'),
    web_env: z
      .string()
      .min(1)
      .describe('WebEnv cookie from an earlier eutils_esearch, eutils_epost, or eutils_elink call.'),
    query_key: z.string().min(1).describe('Query key returned alongside web_env, for example "1".'),
  })
  .describe(
    'Pointer to a UID set stored on the NCBI History server. Pass back the object returned by a previous call, unchanged.',
  );

/** UID list or History reference. Either may be supplied, but not neither. */
export const UidSourceShape = {
  uids: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'UIDs or accession.version identifiers, as an array or a comma-separated string. Example: ["31452104", "31452105"].',
    ),
  history: HistorySchema.optional(),
};

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Annotations for tools that create a set on the NCBI History server.
 *
 * Still read-only with respect to the local environment, but a repeat call
 * leaves an extra set behind, so idempotency is not claimed.
 */
export const STATEFUL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export interface ResolvedSource {
  /** Comma-separated UID list, when the caller supplied explicit UIDs. */
  id?: string;
  webEnv?: string;
  queryKey?: string;
  /** Database the UID set lives in. */
  db: string;
  /** How many UIDs the caller asked about, when known. */
  count?: number;
}

/**
 * Turn the `uids` / `history` pair into request parameters.
 *
 * Guarantees exactly one source is used, so a stale History reference can
 * never silently override an explicit UID list.
 */
export function resolveSource(
  input: { uids?: string | string[] | undefined; history?: HistoryRef | undefined },
  defaultDb: string,
): ResolvedSource {
  const hasUids = input.uids !== undefined && String(input.uids).trim().length > 0;
  const hasHistory = input.history !== undefined;

  if (hasUids && hasHistory) {
    throw new EutilsError(
      'validation',
      'Both uids and history were supplied.',
      'Pass either an explicit UID list or a history reference, not both.',
    );
  }

  if (hasHistory && input.history) {
    // Route through validateHistory so the character guards on web_env and
    // query_key actually run; the zod schema only enforces non-emptiness.
    const history = validateHistory(input.history);
    return {
      db: history.db,
      webEnv: history.web_env,
      queryKey: history.query_key,
    };
  }

  if (hasUids && input.uids !== undefined) {
    const list = Array.isArray(input.uids) ? input.uids : String(input.uids).split(',');
    const cleaned = parseUids(list);
    return { db: defaultDb, id: cleaned.join(','), count: cleaned.length };
  }

  throw new EutilsError(
    'validation',
    'Neither uids nor history was supplied.',
    'Supply a UID list, or pass the history object from an earlier eutils_esearch, eutils_epost, or eutils_elink call.',
  );
}

/** Apply a resolved source to an E-utilities parameter set. */
export function applySource(
  params: Record<string, unknown>,
  source: ResolvedSource,
  options: { setDb?: boolean } = {},
): void {
  if (options.setDb !== false) params['db'] = source.db;
  if (source.id !== undefined) {
    params['id'] = source.id;
  } else {
    params['WebEnv'] = source.webEnv;
    params['query_key'] = source.queryKey;
  }
}

/**
 * Reconcile an optional `db` argument with an optional History reference.
 *
 * The History object carries its own database. If the caller also passed
 * `db` and the two disagree, that is a mistake worth reporting rather than
 * silently picking one.
 */
export function resolveDbAndSource(input: {
  db?: string | undefined;
  uids?: string | string[] | undefined;
  history?: HistoryRef | undefined;
}): ResolvedSource {
  const explicit = input.db ? validateDatabase(input.db) : undefined;

  if (input.history) {
    const fromHistory = validateDatabase(input.history.db);
    if (explicit !== undefined && explicit !== fromHistory) {
      throw new EutilsError(
        'validation',
        `db '${explicit}' does not match history.db '${fromHistory}'.`,
        'Omit db, or pass a history object belonging to the same database.',
      );
    }
    return resolveSource(input, fromHistory);
  }

  if (explicit === undefined) {
    throw new EutilsError(
      'validation',
      'No database was given.',
      'Pass db, for example "pubmed", or pass a history object that carries one. Use eutils_einfo to list databases.',
    );
  }

  return resolveSource(input, explicit);
}

/** Reject a blank search term with actionable advice. */
export function requireTerm(term: string | undefined): string {
  const trimmed = (term ?? '').trim();
  if (trimmed.length === 0) {
    throw new EutilsError(
      'validation',
      'The search term was empty.',
      'Supply an Entrez query, for example "breast cancer AND 2008[pdat]". Use eutils_einfo to list searchable fields.',
    );
  }
  if (trimmed.length > 2000) {
    throw new EutilsError(
      'validation',
      `The search term is ${trimmed.length} characters, over the 2000-character limit.`,
      'Shorten the query, or split it into several searches combined with the History server.',
    );
  }
  return trimmed;
}
