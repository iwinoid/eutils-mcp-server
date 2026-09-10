import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = join(here, '..', 'dist', 'index.js');

export function serverIsBuilt(): boolean {
  return existsSync(SERVER_ENTRY);
}

/** Minimal JSON Schema shape, as emitted from the zod output schemas. */
export interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/**
 * Minimal MCP client over stdio.
 *
 * Written against the wire protocol rather than the SDK client so these
 * tests exercise exactly what a host would see.
 */
export class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr = '';

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NCBI_EMAIL: process.env['NCBI_EMAIL'] ?? 'eutils-mcp-server@example.com',
        ...env,
      },
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        }
      }
    });
  }

  get serverStderr(): string {
    return this.stderr;
  }

  private send(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeoutMs);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(): Promise<any> {
    const result = await this.send('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'vitest-live', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.send('tools/list', {});
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return await this.send('tools/call', { name, arguments: args });
  }

  close(): void {
    this.child.kill();
  }
}

/** Flatten a tool result into its text blocks. */
export function resultText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}
