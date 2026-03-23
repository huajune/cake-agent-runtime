import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { tool, jsonSchema } from 'ai';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { AiTool } from '@shared-types/tool.types';
import { McpServerConfig, McpConnectedServer } from './mcp.types';

@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private readonly clients = new Map();
  private readonly connected = new Map();
  constructor(private readonly toolRegistry: ToolRegistryService) {}
  async connect(config: McpServerConfig): Promise<McpConnectedServer> {
    if (this.clients.has(config.name)) throw new Error('MCP服务器已连接: ' + config.name);
    this.logger.log('连接MCP: ' + config.name);
    const client = new Client({ name: 'cake-agent-runtime', version: '1.0.0' });
    await client.connect(this.createTransport(config));
    this.clients.set(config.name, client);
    const { tools: ts } = await client.listTools();
    const names = [];
    for (const t of ts) {
      const n = t.name,
        c = client;
      const mcpTool = (tool as (...args: unknown[]) => unknown)({
        description: t.description ?? '',
        parameters: jsonSchema(t.inputSchema as Record<string, unknown>),
        execute: async (args) =>
          c.callTool({ name: n, arguments: args as Record<string, unknown> }),
      }) as AiTool;
      this.toolRegistry.registerMcpTool(n, mcpTool, config.name);
      names.push(n);
    }
    const s = { name: config.name, config, toolNames: names, connectedAt: new Date() };
    this.connected.set(config.name, s);
    this.logger.log('MCP已连接: ' + config.name + ', 工具: ' + names.length);
    return s;
  }
  async disconnect(name: string): Promise<void> {
    const c = this.clients.get(name);
    if (!c) {
      this.logger.warn('未连接: ' + name);
      return;
    }
    await c.close();
    this.clients.delete(name);
    this.toolRegistry.removeByMcpServer(name);
    this.connected.delete(name);
    this.logger.log('MCP已断开: ' + name);
  }
  listConnected(): McpConnectedServer[] {
    return [...this.connected.values()];
  }
  async onModuleDestroy() {
    for (const n of this.clients.keys())
      await this.disconnect(n).catch((e) => this.logger.error('关闭MCP出错: ' + n, e));
  }
  private createTransport(config: McpServerConfig) {
    const t = config.transport;
    if (t.transport === 'stdio')
      return new StdioClientTransport({ command: t.command, args: t.args, env: t.env });
    if (t.transport === 'sse') return new SSEClientTransport(new URL(t.url));
    if (t.transport === 'http') return new StreamableHTTPClientTransport(new URL(t.url));
    throw new Error('不支持的MCP传输');
  }
}
