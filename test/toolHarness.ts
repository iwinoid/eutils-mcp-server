import type { McpServer } from '@modelcontextprotocol/server';
import type { EutilsClient, EutilsResponse } from '../src/services/eutilsClient.js';
import { registerAllTools } from '../src/tools/registry.js';

export interface RecordedRequest {
  endpoint: string;
  params: Record<string, unknown>;
}

export interface ToolHarness {
  call(name: string, args: Record<string, unknown>): Promise<any>;
  calls: RecordedRequest[];
  configs: Map<string, any>;
}

export function createHarness(
  router: (req: RecordedRequest) => EutilsResponse | Promise<EutilsResponse>,
): ToolHarness {
  const calls: RecordedRequest[] = [];
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const configs = new Map<string, any>();
  const server = {
    registerTool(name: string, config: any, handler: (input: any) => Promise<any>) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  } as unknown as McpServer;
  const client = {
    hasApiKey: true,
    request: async (req: any) => {
      const recorded = { endpoint: req.endpoint, params: req.params };
      calls.push(recorded);
      return router(recorded);
    },
  } as unknown as EutilsClient;
  registerAllTools(server, client);
  return {
    calls,
    configs,
    async call(name, args) {
      const handler = handlers.get(name);
      if (!handler) throw new Error('unknown tool ' + name);
      return handler(args);
    },
  };
}

export function json(body: unknown, status = 200): EutilsResponse {
  return { status, contentType: 'application/json', text: JSON.stringify(body), json: body };
}

export function text(body: string, status = 200, contentType = 'text/plain'): EutilsResponse {
  return { status, contentType, text: body };
}
