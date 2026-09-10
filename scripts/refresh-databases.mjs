#!/usr/bin/env node
/**
 * Refresh the Entrez database allowlist in src/constants.ts from EInfo.
 *
 * NCBI occasionally adds or retires databases. Run this when a legitimate
 * database name is rejected as unknown.
 *
 * Usage: node scripts/refresh-databases.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const constantsPath = join(here, '..', 'src', 'constants.ts');

const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi');
url.searchParams.set('retmode', 'json');
url.searchParams.set('tool', 'eutils-mcp-server');
url.searchParams.set('email', process.env['NCBI_EMAIL'] ?? 'eutils-mcp-server@example.com');
if (process.env['NCBI_API_KEY']) url.searchParams.set('api_key', process.env['NCBI_API_KEY']);

const response = await fetch(url);
if (!response.ok) {
  console.error(`EInfo returned HTTP ${response.status}`);
  process.exit(1);
}

const payload = await response.json();
const databases = payload?.einforesult?.dblist ?? [];

if (!Array.isArray(databases) || databases.length === 0) {
  console.error('EInfo returned no database list; refusing to write.');
  process.exit(1);
}

const source = readFileSync(constantsPath, 'utf8');
const start = source.indexOf('export const ENTREZ_DATABASES = [');
const end = source.indexOf('] as const;', start);
if (start === -1 || end === -1) {
  console.error('Could not locate ENTREZ_DATABASES in src/constants.ts');
  process.exit(1);
}

// Compare against the existing array only: scanning the whole file would also
// pick up unrelated constant lists such as SEQUENCE_DATABASES.
const previousBlock = source.slice(start, end);
const previous = [...previousBlock.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
const added = databases.filter((db) => !previous.includes(db));
const removed = previous.filter((db) => !databases.includes(db));

const block = `export const ENTREZ_DATABASES = [\n${databases.map((db) => `  '${db}',`).join('\n')}\n] as const;`;

// Use the local calendar date so the stamp matches what a reader sees.
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const before = source.slice(0, start).replace(
  /captured from `einfo\.fcgi\?retmode=json` \(dblist\)\n \* on \d{4}-\d{2}-\d{2}\./,
  `captured from \`einfo.fcgi?retmode=json\` (dblist)\n * on ${stamp}.`,
);

writeFileSync(constantsPath, before + block + source.slice(end + '] as const;'.length));

console.log(`Wrote ${databases.length} databases to src/constants.ts`);
if (added.length > 0) console.log(`  added:   ${added.join(', ')}`);
if (removed.length > 0) console.log(`  removed: ${removed.join(', ')}`);
if (added.length === 0 && removed.length === 0) console.log('  no change');
