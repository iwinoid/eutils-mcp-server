import type { EutilsParamName } from './services/eutilsParams.js';
export interface HistoryRef {
  db: string;
  web_env: string;
  query_key: string;
}
export interface PageInfo {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}
export type ResponseFormat = 'markdown' | 'json';
export type EUtilsErrorKind =
  | 'validation'
  | 'rate_limit'
  | 'not_found'
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'parse'
  | 'cancelled'
  | 'history_expired';
export class EUtilsError extends Error {
  readonly kind: EUtilsErrorKind;
  readonly suggestion: string;
  constructor(kind: EUtilsErrorKind, message: string, suggestion: string) {
    super(message);
    this.name = 'EUtilsError';
    this.kind = kind;
    this.suggestion = suggestion;
  }
  toToolText(): string {
    return `Error (${this.kind}): ${this.message}\nSuggested next step: ${this.suggestion}`;
  }
}
export type QueryParams = Partial<Record<EutilsParamName, string | number | boolean>>;
