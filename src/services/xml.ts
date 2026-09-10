import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Parser hardened for untrusted input.
 *
 * NCBI responses are external data. Entity processing is disabled so a
 * crafted document cannot expand entities, and `parseTagValue` is off so
 * values stay strings and nothing is coerced behind our back.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Remove a DOCTYPE declaration, which is the usual vehicle for entity attacks. */
export function stripDoctype(xml: string): string {
  return xml.replace(/<!DOCTYPE[^>[]*(\[[^]*?\])?[^>]*>/gi, '');
}

/**
 * Parse an XML document into a plain object.
 *
 * Validation runs before parsing so malformed input is reported as a parse
 * failure rather than silently yielding a partial object. Returns
 * `undefined` instead of throwing, letting callers fall back to raw text.
 */
export function parseXml(xml: string): unknown {
  const trimmed = xml.trim();
  if (trimmed.length === 0) return undefined;

  const cleaned = stripDoctype(trimmed);
  if (cleaned.trim().length === 0) return undefined;

  try {
    if (XMLValidator.validate(cleaned) !== true) return undefined;
    return parser.parse(cleaned);
  } catch {
    return undefined;
  }
}

/**
 * Coerce a parsed node into an array.
 *
 * The parser yields a bare object for a single child and an array for
 * several, which makes every consumer write the same branch. Normalising
 * here keeps that out of the tools.
 */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read a text value from a parsed node, tolerating `#text` wrappers. */
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return textOf((value as Record<string, unknown>)['#text']);
  }
  return '';
}
