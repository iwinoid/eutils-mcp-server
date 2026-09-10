import type { CallToolResult } from '@modelcontextprotocol/server';
import { CHARACTER_LIMIT, UNTRUSTED_CLOSE, UNTRUSTED_NOTICE, UNTRUSTED_OPEN } from '../constants.js';
import { EutilsError, type ResponseFormat } from '../types.js';

/**
 * Structural shape of an MCP tool result.
 *
 * Aliased to the SDK's own type so handlers stay assignable to
 * `registerTool`. The import is type-only, so the formatters remain free of
 * any runtime SDK dependency and stay unit-testable in isolation.
 */
export type ToolTextResult = CallToolResult;

/**
 * Strip our own fence markers out of untrusted text.
 *
 * Without this, NCBI content could close the fence early and place text
 * outside the marked region.
 */
export function sanitizeUntrusted(text: string): string {
  return text
    .split(UNTRUSTED_OPEN)
    .join('[fence-marker-removed]')
    .split(UNTRUSTED_CLOSE)
    .join('[fence-marker-removed]');
}

/**
 * Wrap external NCBI text so a model can tell data from instructions.
 *
 * Threat control #1: PubMed titles and abstracts are attacker-writable, so
 * they are fenced and labelled rather than returned bare.
 */
export function fenceUntrusted(text: string): string {
  return [UNTRUSTED_NOTICE, UNTRUSTED_OPEN, sanitizeUntrusted(text), UNTRUSTED_CLOSE].join('\n');
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalLength: number;
  message?: string;
}

/** Cap a rendered result, telling the caller how to see the rest. */
export function truncateWithNotice(text: string, limit: number = CHARACTER_LIMIT): TruncationResult {
  if (text.length <= limit) {
    return { text, truncated: false, originalLength: text.length };
  }
  const kept = text.slice(0, limit);
  const message =
    `Response truncated from ${text.length} to ${limit} characters. ` +
    `Use 'retstart' to page through the set, lower 'retmax', or add filters to narrow the query.`;
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
}

/** Render a successful tool result in the requested format, with truncation applied. */
export function respond(input: RespondInput): ToolTextResult {
  const body = input.format === 'json' ? JSON.stringify(input.structured, null, 2) : input.markdown;
  const { text, truncated, message } = truncateWithNotice(body);

  const structured = truncated
    ? { ...input.structured, truncated: true, truncation_message: message }
    : input.structured;

  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/** Render a failure as an actionable message the model can act on. */
export function errorResult(error: unknown): ToolTextResult {
  const text =
    error instanceof EutilsError
      ? error.toToolText()
      : `Error: ${error instanceof Error ? error.message : String(error)}`;

  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

/** Build the standard pagination envelope. */
export function pageInfo(
  total: number,
  count: number,
  offset: number,
): { total: number; count: number; offset: number; has_more: boolean; next_offset?: number } {
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

/** Render a bullet list, or a placeholder when empty. */
export function bulletList(items: readonly string[], placeholder = 'None.'): string {
  if (items.length === 0) return placeholder;
  return items.map((item) => `- ${item}`).join('\n');
}
