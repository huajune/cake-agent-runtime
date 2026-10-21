import { McpClientService } from '@mcp/mcp-client.service';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BUILT_IN_TOOL_CONTRACTS } from '@tools/tool-contracts';
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

describe('MCP contract connection', () => {
  const registry = { registerMcpTool: jest.fn(), removeByMcpServer: jest.fn() };
  const client = {
    connect: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    listTools: jest
      .fn()
      .mockResolvedValue({ tools: [{ name: 'remote_read', inputSchema: { type: 'object' } }] }),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    (Client as jest.Mock).mockImplementation(() => client);
  });
  it('passes the locally configured contract', async () => {
    const service = new McpClientService(registry as never);
    await service.connect({
      name: 'test',
      transport: { transport: 'http', url: 'https://example.test' },
      toolContracts: { remote_read: BUILT_IN_TOOL_CONTRACTS.recall_history },
    });
    expect(registry.registerMcpTool).toHaveBeenCalledWith(
      'remote_read',
      expect.anything(),
      'test',
      BUILT_IN_TOOL_CONTRACTS.recall_history,
    );
    await service.disconnect('test');
  });
  it('closes an undeclared connection and permits a corrected retry', async () => {
    const service = new McpClientService(registry as never);
    const config = {
      name: 'test',
      transport: { transport: 'http' as const, url: 'https://example.test' },
    };
    await expect(service.connect(config)).rejects.toThrow('no action contract');
    expect(registry.registerMcpTool).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    await expect(
      service.connect({
        ...config,
        toolContracts: { remote_read: BUILT_IN_TOOL_CONTRACTS.recall_history },
      }),
    ).resolves.toBeDefined();
  });
});
