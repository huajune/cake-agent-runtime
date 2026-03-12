import { Module } from '@nestjs/common';
import { ModelModule } from './model/model.module';
import { ToolModule } from './tool/tool.module';
import { McpModule } from './mcp/mcp.module';
import { AgentModule } from './agent/agent.module';

/**
 * AI 能力框架模块（Vercel AI SDK）
 * - ModelModule: 模型提供者管理
 * - ToolModule:  工具注册表
 * - McpModule:   MCP客户端管理
 * - AgentModule: Agent执行引擎
 */
@Module({
  imports: [ModelModule, ToolModule, McpModule, AgentModule],
  exports: [ModelModule, ToolModule, McpModule, AgentModule],
})
export class AiModule {}
