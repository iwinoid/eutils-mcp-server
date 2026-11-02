import * as z from 'zod';
import { EUtilsError, type HistoryRef, type QueryParams } from '../types.js';
import { parseUids, validateDatabase, validateHistory } from '../services/validate.js';
export const ResponseFormatSchema = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe(
    "Output format: 'markdown' for human-readable text, or 'json' for machine-readable data. Default: 'markdown'.",
  );
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
export const STATEFUL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
export interface ResolvedSource {
  id?: string;
  webEnv?: string;
  queryKey?: string;
  db: string;
  count?: number;
}
export function resolveSource(
  input: {
    uids?: string | string[] | undefined;
    history?: HistoryRef | undefined;
  },
  defaultDb: string,
): ResolvedSource {
  const hasUids = input.uids !== undefined && String(input.uids).trim().length > 0;
  const hasHistory = input.history !== undefined;
  if (hasUids && hasHistory) {
    throw new EUtilsError(
      'validation',
      'Both uids and history were supplied.',
      'Pass either an explicit UID list or a history reference, not both.',
    );
  }
  if (hasHistory && input.history) {
    const history = validateHistory(input.history);
    return {
      db: history.db,
      webEnv: history.web_env,
      queryKey: history.query_key,
    };
  }
  if (hasUids && input.uids !== undefined) {
    const cleaned = parseUids(input.uids);
    return { db: defaultDb, id: cleaned.join(','), count: cleaned.length };
  }
  throw new EUtilsError(
    'validation',
    'Neither uids nor history was supplied.',
    'Supply a UID list, or pass the history object from an earlier eutils_esearch, eutils_epost, or eutils_elink call.',
  );
}
export function applySource(
  params: QueryParams,
  source: ResolvedSource,
  options: {
    setDb?: boolean;
  } = {},
): void {
  if (options.setDb !== false) params['db'] = source.db;
  if (source.id !== undefined) {
    params['id'] = source.id;
  } else {
    params['WebEnv'] = source.webEnv;
    params['query_key'] = source.queryKey;
  }
}
export function resolveDbAndSource(input: {
  db?: string | undefined;
  uids?: string | string[] | undefined;
  history?: HistoryRef | undefined;
}): ResolvedSource {
  const explicit = input.db ? validateDatabase(input.db) : undefined;
  if (input.history) {
    const fromHistory = validateDatabase(input.history.db);
    if (explicit !== undefined && explicit !== fromHistory) {
      throw new EUtilsError(
        'validation',
        `db '${explicit}' does not match history.db '${fromHistory}'.`,
        'Omit db, or pass a history object belonging to the same database.',
      );
    }
    return resolveSource(input, fromHistory);
  }
  if (explicit === undefined) {
    throw new EUtilsError(
      'validation',
      'No database was given.',
      'Pass db, for example "pubmed", or pass a history object that carries one. Use eutils_einfo to list databases.',
    );
  }
  return resolveSource(input, explicit);
}
export function requireTerm(term: string | undefined): string {
  const trimmed = (term ?? '').trim();
  if (trimmed.length === 0) {
    throw new EUtilsError(
      'validation',
      'The search term was empty.',
      'Supply an Entrez query, for example "breast cancer AND 2008[pdat]". Use eutils_einfo to list searchable fields.',
    );
  }
  if (trimmed.length > 2000) {
    throw new EUtilsError(
      'validation',
      `The search term is ${trimmed.length} characters, over the 2000-character limit.`,
      'Shorten the query, or split it into several searches combined with the History server.',
    );
  }
  return trimmed;
}
