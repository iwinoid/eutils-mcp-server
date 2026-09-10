/** Shared types for the E-utilities MCP server. */

/**
 * A pointer to a UID set held on the NCBI History server.
 *
 * Travels through tool calls as an ordinary value. The server keeps no state,
 * so the model passes this back verbatim to continue a pipeline.
 */
export interface HistoryRef {
  db: string;
  web_env: string;
  query_key: string;
}

/** Standard pagination envelope returned by every listing tool. */
export interface PageInfo {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export type ResponseFormat = 'markdown' | 'json';

/** Failure categories that map to different advice for the model. */
export type EutilsErrorKind =
  | 'validation'
  | 'rate_limit'
  | 'not_found'
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'parse'
  | 'history_expired';

/**
 * An error carrying a machine-readable kind plus a suggested next step.
 *
 * `message` is always safe to show: the API key is redacted before any
 * EutilsError is constructed.
 */
export class EutilsError extends Error {
  readonly kind: EutilsErrorKind;
  readonly suggestion: string;

  constructor(kind: EutilsErrorKind, message: string, suggestion: string) {
    super(message);
    this.name = 'EutilsError';
    this.kind = kind;
    this.suggestion = suggestion;
  }

  /** Render as a single actionable line for the model. */
  toToolText(): string {
    return `Error (${this.kind}): ${this.message}\nSuggested next step: ${this.suggestion}`;
  }
}

/** One parameter of an E-utilities request. Values are stringified by the client. */
export type QueryParams = Record<string, unknown>;
