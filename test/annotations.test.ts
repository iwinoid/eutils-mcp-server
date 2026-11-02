import { describe, expect, it } from 'vitest';
import { createHarness, json } from './toolHarness.js';

const harness = createHarness(() => json({}));

function annotations(name: string): Record<string, unknown> {
  const config = harness.configs.get(name);
  if (!config) throw new Error('missing tool ' + name);
  return config.annotations as Record<string, unknown>;
}

describe('MCP tool annotations', () => {
  it('marks tools that create NCBI History sets as stateful', () => {
    for (const name of [
      'eutils_esearch',
      'eutils_epost',
      'eutils_elink',
      'eutils_search_then_fetch',
      'eutils_link_then_fetch',
    ]) {
      expect(annotations(name), name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it('marks pure read tools as read-only and idempotent', () => {
    for (const name of [
      'eutils_einfo',
      'eutils_esummary',
      'eutils_efetch',
      'eutils_egquery',
      'eutils_espell',
      'eutils_ecitmatch',
    ]) {
      expect(annotations(name), name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });
});
