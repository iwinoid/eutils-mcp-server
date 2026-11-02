import type { McpServer } from '@modelcontextprotocol/server';
import type { EUtilsClient } from '../services/eutilsClient.js';
import { registerDiscoveryTools } from './discovery.js';
import { registerLinkTools } from './links.js';
import { registerRecordTools } from './records.js';
import { registerSearchTools } from './search.js';
import { registerWorkflowTools } from './workflows.js';
export function registerAllTools(server: McpServer, client: EUtilsClient): void {
  registerDiscoveryTools(server, client);
  registerSearchTools(server, client);
  registerRecordTools(server, client);
  registerLinkTools(server, client);
  registerWorkflowTools(server, client);
}
