import { XMLParser, XMLValidator } from 'fast-xml-parser';
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
});
export function stripDoctype(xml: string): string {
  return xml.replace(/<!DOCTYPE[^>[]*(\[[^]*?\])?[^>]*>/gi, '');
}
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
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return textOf((value as Record<string, unknown>)['#text']);
  }
  return '';
}
