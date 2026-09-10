import type { McpServer } from '@modelcontextprotocol/server';
import type { EutilsClient } from '../services/eutilsClient.js';
import { registerDiscoveryTools } from './discovery.js';
import { registerLinkTools } from './links.js';
import { registerRecordTools } from './records.js';
import { registerSearchTools } from './search.js';
import { registerWorkflowTools } from './workflows.js';

/**
 * Register all eleven E-utilities tools on a server.
 *
 * Each registrar owns one domain and receives the shared client, so every
 * outbound request passes through the same rate limiter and credential guard.
 */
export function registerAllTools(server: McpServer, client: EutilsClient): void {
  registerDiscoveryTools(server, client);
  registerSearchTools(server, client);
  registerRecordTools(server, client);
  registerLinkTools(server, client);
  registerWorkflowTools(server, client);
}
