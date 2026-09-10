#!/usr/bin/env node
/**
 * Call one tool on the built server and print the raw result.
 *
 * Usage: node scripts/call-tool.mjs eutils_egquery '{"term":"breast cancer"}'
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

const [toolName, argsJson = '{}'] = process.argv.slice(2);
if (!toolName) {
  console.error('Usage: node scripts/call-tool.mjs <tool-name> [json-args]');
  process.exit(2);
}

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NCBI_EMAIL: process.env.NCBI_EMAIL ?? 'eutils-mcp-server@example.com' },
});

child.stderr.on('data', (chunk) => process.stderr.write(chunk));

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

await send('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'call-tool', version: '1.0.0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const result = await send('tools/call', { name: toolName, arguments: JSON.parse(argsJson) });
console.log(JSON.stringify(result, null, 2));

child.kill();
process.exit(0);
