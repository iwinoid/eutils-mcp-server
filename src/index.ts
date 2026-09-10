#!/usr/bin/env node
/**
 * E-utilities MCP server.
 *
 * Exposes the nine NCBI Entrez Programming Utilities as MCP tools over stdio.
 * Read-only: it never writes to the local environment.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createClientFromEnv } from './services/eutilsClient.js';
import { registerAllTools } from './tools/registry.js';

/** Log to stderr only: stdout carries the MCP protocol stream. */
function warn(message: string): void {
  process.stderr.write(`[eutils-mcp-server] ${message}\n`);
}

function readPackageVersion(): string {
  return process.env['npm_package_version'] ?? '0.0.1';
}

if (!process.env['NCBI_EMAIL']) {
  warn(
    'NCBI_EMAIL is not set. NCBI asks that automated clients identify themselves so they can ' +
      'contact you before blocking an IP. Set NCBI_EMAIL and NCBI_TOOL, then register them by ' +
      'mailing eutilities@ncbi.nlm.nih.gov.',
  );
}

if (!process.env['NCBI_API_KEY']) {
  warn(
    'NCBI_API_KEY is not set, so requests are capped at 3 per second. ' +
      'Create a key in your NCBI account settings to raise the cap to 10 per second.',
  );
}

serveStdio(() => {
  const server = new McpServer({
    name: 'eutils-mcp-server',
    version: readPackageVersion(),
  });

  const client = createClientFromEnv();
  registerAllTools(server, client);

  return server;
});
