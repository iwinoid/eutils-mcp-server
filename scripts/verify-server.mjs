#!/usr/bin/env node
/**
 * Protocol-level smoke test for the E-utilities MCP server.
 *
 * Spawns the built server over stdio, speaks raw JSON-RPC to it, and checks
 * that every tool is listed and that a real search round-trips to NCBI.
 *
 * Usage: node scripts/verify-server.mjs [--live]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const live = process.argv.includes('--live');

const EXPECTED_TOOLS = [
  'eutils_einfo',
  'eutils_esearch',
  'eutils_epost',
  'eutils_esummary',
  'eutils_efetch',
  'eutils_elink',
  'eutils_egquery',
  'eutils_espell',
  'eutils_ecitmatch',
  'eutils_search_then_fetch',
  'eutils_link_then_fetch',
];

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NCBI_EMAIL: process.env.NCBI_EMAIL ?? 'eutils-mcp-server@example.com' },
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

let buffer = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
});

let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

try {
  console.log('MCP handshake');
  const init = await send('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'verify-server', version: '1.0.0' },
  });
  notify('notifications/initialized', {});
  check(
    'initialize returns serverInfo',
    init?.serverInfo?.name === 'eutils-mcp-server',
    JSON.stringify(init?.serverInfo),
  );
  check(
    'a protocol version was negotiated',
    typeof init?.protocolVersion === 'string',
    init?.protocolVersion,
  );

  console.log('\nTool listing');
  const list = await send('tools/list', {});
  const names = (list?.tools ?? []).map((tool) => tool.name);
  check(
    `lists ${EXPECTED_TOOLS.length} tools`,
    names.length === EXPECTED_TOOLS.length,
    `saw ${names.length}: ${names.join(', ')}`,
  );
  for (const expected of EXPECTED_TOOLS) {
    check(`tool present: ${expected}`, names.includes(expected));
  }

  const everyTool = (list?.tools ?? []).every(
    (tool) =>
      typeof tool.description === 'string' &&
      tool.description.length > 80 &&
      tool.inputSchema?.type === 'object' &&
      tool.annotations?.readOnlyHint === true &&
      tool.annotations?.destructiveHint === false,
  );
  check('every tool has a description, an input schema, and read-only annotations', everyTool);

  console.log('\nTool calls');
  const einfo = await send('tools/call', { name: 'eutils_einfo', arguments: {} });
  check(
    'eutils_einfo lists databases',
    !einfo.isError && /Entrez databases \(38\)/.test(textOf(einfo)),
    textOf(einfo).slice(0, 200),
  );

  const badDb = await send('tools/call', {
    name: 'eutils_esearch',
    arguments: { db: 'pubmed&api_key=stolen', term: 'x' },
  });
  check(
    'rejects a database name carrying an injected parameter',
    badDb.isError === true && /not a valid Entrez database name/.test(textOf(badDb)),
    textOf(badDb).slice(0, 200),
  );

  if (live) {
    console.log('\nLive NCBI calls');
    const search = await send('tools/call', {
      name: 'eutils_esearch',
      arguments: { db: 'pubmed', term: 'science[journal] AND breast cancer AND 2008[pdat]', retmax: 3 },
    });
    const searchText = textOf(search);
    const matched = /matched \*\*([\d,]+)\*\* records/.exec(searchText);
    check(
      'eutils_esearch reports a non-zero match count',
      !search.isError && matched !== null && Number(matched[1].replace(/,/g, '')) > 0,
      searchText.slice(0, 300),
    );
    check('eutils_esearch returns a history handle', /"web_env"/.test(searchText), searchText.slice(-300));

    const summary = await send('tools/call', {
      name: 'eutils_esummary',
      arguments: { db: 'pubmed', uids: ['31452104'] },
    });
    check(
      'eutils_esummary returns a title',
      !summary.isError && /Molegro Virtual Docker/.test(textOf(summary)),
      textOf(summary).slice(0, 300),
    );

    const fetched = await send('tools/call', {
      name: 'eutils_efetch',
      arguments: { db: 'protein', uids: ['NP_005537.3'], rettype: 'fasta' },
    });
    const fetchText = textOf(fetched);
    check(
      'eutils_efetch returns FASTA',
      !fetched.isError && /^>NP_005537/m.test(fetchText),
      fetchText.slice(0, 200),
    );
    check('untrusted record text is fenced', /EXTERNAL_NCBI_DATA/.test(fetchText));
  }
} catch (error) {
  console.log(`  FAIL  ${error.message}`);
  failures.push(error.message);
} finally {
  child.kill();
}

if (stderr.trim().length > 0) {
  console.log('\nServer stderr:');
  console.log(
    stderr
      .trim()
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
