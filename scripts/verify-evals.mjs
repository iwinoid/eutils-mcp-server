#!/usr/bin/env node
/**
 * Verify that every answer in evals/eutils_evaluation.xml is still correct.
 *
 * Each question is solved against the live server by the same tool sequence a
 * model would use, and the produced answer is compared to the recorded one.
 * This is the evidence that the evaluation set is solvable and accurate.
 *
 * Usage: node scripts/verify-evals.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const evalPath = join(here, '..', 'evals', 'eutils_evaluation.xml');

// ---------------------------------------------------------------- MCP client

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NCBI_EMAIL: process.env.NCBI_EMAIL ?? 'eutils-mcp-server@example.com' },
});
child.stderr.resume();

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

async function call(name, args) {
  const message = await send('tools/call', { name, arguments: args });
  const result = message.result ?? {};
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

// ------------------------------------------------------------ question solvers

const solvers = [
  {
    id: 'PNAS 1991 journal abbreviation',
    async solve() {
      const cite = await call('eutils_ecitmatch', {
        citations: ['proc natl acad sci u s a|1991|88|3248|mann bj|Art1|'],
      });
      const pmid = cite.records[0].pmid;
      const summary = await call('eutils_esummary', { db: 'pubmed', uids: [pmid] });
      return summary.records[0].source;
    },
  },
  {
    id: 'Science 1987 DOI',
    async solve() {
      const cite = await call('eutils_ecitmatch', {
        citations: ['science|1987|235|182|palmenberg ac|Art2|'],
      });
      const summary = await call('eutils_esummary', { db: 'pubmed', uids: [cite.records[0].pmid] });
      return summary.records[0].doi;
    },
  },
  {
    id: 'Gene 7173 official symbol',
    async solve() {
      const summary = await call('eutils_esummary', { db: 'gene', uids: ['7173'] });
      return summary.records[0].nomenclaturesymbol;
    },
  },
  {
    id: 'human common name',
    async solve() {
      const search = await call('eutils_esearch', {
        db: 'taxonomy',
        term: 'human',
        retmax: 1,
        usehistory: false,
      });
      const taxid = search.uids[0];
      const summary = await call('eutils_esummary', { db: 'taxonomy', uids: [taxid] });
      return summary.records[0].commonname;
    },
  },
  {
    id: 'MeSH Terms field tag',
    async solve() {
      const info = await call('eutils_einfo', { db: 'pubmed' });
      return info.fields.find((field) => field.fullname === 'MeSH Terms')?.name;
    },
  },
  {
    id: 'NP_005537.3 organism',
    async solve() {
      const summary = await call('eutils_esummary', { db: 'protein', uids: ['NP_005537.3'] });
      return summary.records[0].organism;
    },
  },
  {
    id: 'NP_005537.3 FASTA description',
    async solve() {
      const fasta = await call('eutils_efetch', {
        db: 'protein',
        uids: ['NP_005537.3'],
        rettype: 'fasta',
      });
      const header = fasta.text.split('\n')[0];
      return header
        .replace(/^>\S+\s+/, '')
        .replace(/\s*\[[^\]]*\]\s*$/, '')
        .trim();
    },
  },
  {
    id: 'gene to protein link name',
    async solve() {
      const link = await call('eutils_elink', {
        dbfrom: 'gene',
        db: 'protein',
        uids: ['7173'],
      });
      return link.groups[0]?.linkname;
    },
  },
  {
    id: 'NM_000547.5 caption',
    async solve() {
      const summary = await call('eutils_esummary', { db: 'nuccore', uids: ['NM_000547.5'] });
      return summary.records[0].caption;
    },
  },
  {
    id: 'mengo vius spelling correction',
    async solve() {
      const spell = await call('eutils_espell', { db: 'pubmed', term: 'mengo vius' });
      return spell.corrected_query;
    },
  },
];

// ------------------------------------------------------------------ run them

const xml = readFileSync(evalPath, 'utf8');
const pairs = [...xml.matchAll(/<qa_pair>([\s\S]*?)<\/qa_pair>/g)].map((match) => ({
  question: match[1].match(/<question>([\s\S]*?)<\/question>/)[1].trim(),
  answer: match[1].match(/<answer>([\s\S]*?)<\/answer>/)[1].trim(),
}));

await send('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'verify-evals', version: '1.0.0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

console.log(`Verifying ${pairs.length} evaluation answers\n`);

let failures = 0;

if (solvers.length !== pairs.length) {
  console.error(`Solver count ${solvers.length} does not match question count ${pairs.length}`);
  process.exit(1);
}

for (const [index, pair] of pairs.entries()) {
  const solver = solvers[index];
  let actual;
  try {
    actual = await solver.solve();
  } catch (error) {
    console.log(`  FAIL  Q${index + 1} ${solver.id}: ${error.message}`);
    failures += 1;
    continue;
  }

  const ok = String(actual).trim() === pair.answer;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  Q${index + 1} ${solver.id}` +
      (ok ? '' : `\n         expected: ${pair.answer}\n         actual:   ${actual}`),
  );
  if (!ok) failures += 1;
}

child.kill();
console.log(
  `\n${failures === 0 ? `ALL ${pairs.length} EVALUATION ANSWERS VERIFIED` : `${failures} ANSWER(S) WRONG`}`,
);
process.exit(failures === 0 ? 0 : 1);
