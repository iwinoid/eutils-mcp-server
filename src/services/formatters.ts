import type { CallToolResult } from '@modelcontextprotocol/server';
import { CHARACTER_LIMIT, UNTRUSTED_CLOSE, UNTRUSTED_NOTICE, UNTRUSTED_OPEN } from '../constants.js';
import { EUtilsError, type ResponseFormat } from '../types.js';
export type ToolTextResult = CallToolResult;
export function sanitizeUntrusted(text: string): string {
  return text
    .split(UNTRUSTED_OPEN)
    .join('[fence-marker-removed]')
    .split(UNTRUSTED_CLOSE)
    .join('[fence-marker-removed]');
}
export function fenceUntrusted(text: string): string {
  return [UNTRUSTED_NOTICE, UNTRUSTED_OPEN, sanitizeUntrusted(text), UNTRUSTED_CLOSE].join('\n');
}
export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalLength: number;
  message?: string;
}
export interface TruncateOptions {
  strategy?: 'head' | 'head-tail';
  tailChars?: number;
  guidance?: string;
}
export const DEFAULT_TAIL_CHARS = 5000;
export function truncateWithNotice(
  text: string,
  limit: number = CHARACTER_LIMIT,
  options: TruncateOptions = {},
): TruncationResult {
  if (text.length <= limit) {
    return { text, truncated: false, originalLength: text.length };
  }
  const strategy = options.strategy ?? 'head';
  let kept: string;
  let base: string;
  if (strategy === 'head-tail') {
    const tailChars = Math.min(options.tailChars ?? DEFAULT_TAIL_CHARS, Math.floor(limit / 2));
    const headChars = limit - tailChars;
    const omitted = text.length - limit;
    kept =
      `${text.slice(0, headChars)}\n\n` +
      `[... ${omitted.toLocaleString('en-US')} characters omitted ...]\n\n` +
      text.slice(text.length - tailChars);
    base =
      `Response truncated from ${text.length} to ${limit} characters (head and tail kept). ` +
      `Use 'retstart' to page through the set, lower 'retmax', or add filters to narrow the query.`;
  } else {
    kept = text.slice(0, limit);
    base =
      `Response truncated from ${text.length} to ${limit} characters. ` +
      `Use 'retstart' to page through the set, lower 'retmax', or add filters to narrow the query.`;
  }
  const message = options.guidance ? `${base} ${options.guidance}` : base;
  return {
    text: `${kept}\n\n[TRUNCATED] ${message}`,
    truncated: true,
    originalLength: text.length,
    message,
  };
}
export interface RespondInput {
  structured: Record<string, unknown>;
  markdown: string;
  format: ResponseFormat;
  truncate?: TruncateOptions;
}
const STRUCTURED_TRUNCATION_NOTICE =
  'The structured result was reduced to fit the response budget. Use retstart, a smaller retmax, or a narrower query to see more.';
type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };
function isRecord(value: JsonLike): value is {
  [key: string]: JsonLike;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function measure(value: JsonLike): number {
  return JSON.stringify(value, null, 2).length;
}
function truncatePlain(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = Math.min(2000, Math.floor(limit / 2));
  const head = limit - tail;
  return (
    text.slice(0, head) +
    '\n\n[... ' +
    (text.length - limit) +
    ' characters omitted ...]\n\n' +
    text.slice(text.length - tail)
  );
}
function walkStrings(value: JsonLike, limit: number): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === 'string') value[index] = truncatePlain(item, limit);
      else if (item !== undefined) walkStrings(item, limit);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === 'string') value[key] = truncatePlain(item, limit);
    else if (item !== undefined) walkStrings(item, limit);
  }
}
function shrinkLargestArray(value: JsonLike): boolean {
  let largest: JsonLike[] | undefined;
  const visit = (node: JsonLike): void => {
    if (Array.isArray(node)) {
      if (largest === undefined || JSON.stringify(node).length > JSON.stringify(largest).length) {
        largest = node;
      }
      for (const item of node) visit(item);
      return;
    }
    if (isRecord(node)) {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  if (largest === undefined || largest.length === 0) return false;
  largest.length = Math.ceil(largest.length / 2);
  return true;
}
function budgetStructured(
  value: unknown,
  maxChars: number,
): {
  value: Record<string, unknown>;
  truncated: boolean;
} {
  const cloned = JSON.parse(JSON.stringify(value)) as JsonLike;
  if (measure(cloned) <= maxChars) return { value: cloned as Record<string, unknown>, truncated: false };
  walkStrings(cloned, Math.max(2000, Math.floor(maxChars / 2)));
  for (let step = 0; step < 200 && measure(cloned) > maxChars; step += 1) {
    if (!shrinkLargestArray(cloned)) break;
  }
  for (const threshold of [4000, 2000, 1000, 500, 250, 100, 50]) {
    if (measure(cloned) <= maxChars) break;
    walkStrings(cloned, threshold);
  }
  if (measure(cloned) > maxChars) {
    return {
      value: { truncated: true, truncation_message: STRUCTURED_TRUNCATION_NOTICE },
      truncated: true,
    };
  }
  return { value: cloned as Record<string, unknown>, truncated: true };
}
export function respond(input: RespondInput): ToolTextResult {
  const budget = budgetStructured(input.structured, CHARACTER_LIMIT - 400);
  const structured = budget.truncated
    ? { ...budget.value, truncated: true, truncation_message: STRUCTURED_TRUNCATION_NOTICE }
    : budget.value;
  if (input.format === 'json') {
    let text = JSON.stringify(structured, null, 2);
    if (text.length > CHARACTER_LIMIT) text = JSON.stringify(structured);
    return { content: [{ type: 'text', text }], structuredContent: structured };
  }
  const { text, truncated, message } = truncateWithNotice(
    input.markdown,
    CHARACTER_LIMIT,
    input.truncate ?? {},
  );
  const reasons: string[] = [];
  if (budget.truncated) reasons.push(STRUCTURED_TRUNCATION_NOTICE);
  if (truncated && message !== undefined) reasons.push(message);
  const merged =
    reasons.length > 0
      ? { ...structured, truncated: true, truncation_message: reasons.join(' ') }
      : structured;
  return { content: [{ type: 'text', text }], structuredContent: merged };
}
export function errorResult(error: unknown): ToolTextResult {
  const text =
    error instanceof EUtilsError
      ? error.toToolText()
      : `Error: ${error instanceof Error ? error.message : String(error)}`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
export function pageInfo(
  total: number,
  count: number,
  offset: number,
): {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
} {
  const consumed = offset + count;
  const hasMore = total > consumed;
  return {
    total,
    count,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: consumed } : {}),
  };
}
export function bulletList(items: readonly string[], placeholder = 'None.'): string {
  if (items.length === 0) return placeholder;
  return items.map((item) => `- ${item}`).join('\n');
}
