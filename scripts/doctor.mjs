#!/usr/bin/env node
/**
 * Probe every E-utilities endpoint and report which ones work from here.
 *
 * Answers the two questions that are otherwise hard to separate: is my network
 * or credentials at fault, or is an NCBI endpoint broken? Run it before
 * filing a bug against this server.
 *
 * Usage: node scripts/doctor.mjs
 */

import { BASE_URL, DEFAULT_TOOL } from '../dist/constants.js';

const apiKey = process.env['NCBI_API_KEY'];
const email = process.env['NCBI_EMAIL'];
const tool = process.env['NCBI_TOOL'] ?? DEFAULT_TOOL;

console.log('eutils-mcp-server doctor\n');
console.log(`  base url   ${BASE_URL}`);
console.log(`  tool       ${tool}`);
console.log(`  email      ${email ?? '(not set — NCBI prefers that automated clients identify themselves)'}`);
console.log(`  api key    ${apiKey ? 'set' : '(not set — requests are capped at 3/second)'}`);
console.log(`  rate limit ${apiKey ? 10 : 3} requests/second\n`);

/** One probe per endpoint, using the smallest request that exercises it. */
const probes = [
  { name: 'einfo', path: 'einfo.fcgi', params: { db: 'pubmed', retmode: 'json' } },
  {
    name: 'esearch',
    path: 'esearch.fcgi',
    params: { db: 'pubmed', term: 'cancer', retmax: '1', retmode: 'json' },
  },
  { name: 'esummary', path: 'esummary.fcgi', params: { db: 'pubmed', id: '31452104', retmode: 'json' } },
  {
    name: 'efetch',
    path: 'efetch.fcgi',
    params: { db: 'pubmed', id: '31452104', rettype: 'abstract', retmode: 'text' },
  },
  {
    name: 'elink',
    path: 'elink.fcgi',
    params: { dbfrom: 'pubmed', db: 'pmc', id: '31452104', retmode: 'json' },
  },
  { name: 'epost', path: 'epost.fcgi', params: { db: 'pubmed', id: '31452104' } },
  { name: 'espell', path: 'espell.fcgi', params: { db: 'pubmed', term: 'breast cancr' } },
  { name: 'egquery', path: 'egquery.fcgi', params: { term: 'cancer' } },
  {
    name: 'ecitmatch',
    path: 'ecitmatch.cgi',
    params: { db: 'pubmed', retmode: 'xml', bdata: 'science|1987|235|182|palmenberg ac|A|' },
    post: true,
  },
];

const results = [];

for (const probe of probes) {
  const url = new URL(BASE_URL + probe.path);
  url.searchParams.set('tool', tool);
  if (email) url.searchParams.set('email', email);
  if (apiKey) url.searchParams.set('api_key', apiKey);

  const init = { redirect: 'manual', signal: AbortSignal.timeout(20_000) };

  if (probe.post) {
    const body = new URLSearchParams(probe.params);
    init.method = 'POST';
    init.body = body.toString();
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  } else {
    for (const [key, value] of Object.entries(probe.params)) url.searchParams.set(key, value);
  }

  const started = Date.now();
  let status = 'no response';
  let detail = '';
  let ok = false;

  try {
    const response = await fetch(url, init);
    const elapsed = Date.now() - started;
    status = `HTTP ${response.status}`;

    if (response.status === 301 || response.status === 302) {
      const location = response.headers.get('location') ?? '';
      detail = `redirects to ${location ? new URL(location).host : '(no location)'}`;
      if (probe.name === 'egquery') {
        detail += ' — not published in public DNS; see README';
      }
    } else if (response.ok) {
      const text = await response.text();
      ok = text.trim().length > 0;
      detail = `${elapsed} ms, ${text.length} bytes`;
      if (!ok) detail += ' (empty body)';
    } else {
      const text = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
      detail = text;
    }
  } catch (error) {
    detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  results.push({ ...probe, status, detail, ok });
  await new Promise((resolve) => setTimeout(resolve, apiKey ? 120 : 400));
}

console.log('  endpoint     status        detail');
console.log('  ' + '-'.repeat(76));
for (const result of results) {
  const mark = result.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${result.name.padEnd(11)} ${result.status.padEnd(13)} ${result.detail}`);
}

const broken = results.filter((result) => !result.ok);
console.log();

if (broken.length === 0) {
  console.log('All endpoints responded.');
} else if (broken.every((result) => result.name === 'egquery')) {
  console.log('Only EGQuery failed. This is the known NCBI-side redirect to an internal host.');
  console.log(
    apiKey
      ? 'A valid API key was sent and the redirect still happened, so this is not a credentials problem.'
      : 'No API key was sent. A key does not help: the redirect happens before any credential check.',
  );
  console.log('The server handles this: eutils_egquery degrades and says so.');
} else {
  console.log(`${broken.length} endpoint(s) failed: ${broken.map((r) => r.name).join(', ')}`);
  console.log('If most endpoints failed, suspect network access, a proxy, or DNS rather than NCBI.');
}

process.exit(broken.length === 0 || broken.every((result) => result.name === 'egquery') ? 0 : 1);
