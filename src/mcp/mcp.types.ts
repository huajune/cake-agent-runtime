export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpStdioConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSseConfig {
  transport: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerTransportConfig = McpStdioConfig | McpSseConfig | McpHttpConfig;

export interface McpServerConfig {
  /** 服务器唯一名称 */
  name: string;
  /** 传输配置 */
  transport: McpServerTransportConfig;
}

export interface McpConnectedServer {
  name: string;
  config: McpServerConfig;
  toolNames: string[];
  connectedAt: Date;
}
