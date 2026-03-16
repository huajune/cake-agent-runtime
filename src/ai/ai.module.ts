import { Global, Module } from '@nestjs/common';
import { ModelModule } from './model/model.module';
import { ToolModule } from './tool/tool.module';
import { McpModule } from './mcp/mcp.module';
import { RunnerModule } from './runner/runner.module';
import { MemoryModule } from './memory/memory.module';
import { SpongeModule } from './sponge/sponge.module';

/**
 * AI 能力框架模块（Vercel AI SDK）
 * - ModelModule:  模型提供者管理（单网关纯注册表）
 * - ToolModule:   工具注册表 + 所有内置 LLM 工具
 * - McpModule:    MCP客户端管理
 * - RunnerModule: Agent执行引擎（generateText/streamText）
 * - MemoryModule: 记忆基础设施（Redis-backed）
 * - SpongeModule: 海绵数据服务（岗位/面试 HTTP 客户端）
 */
@Global()
@Module({
  imports: [ModelModule, ToolModule, McpModule, RunnerModule, MemoryModule, SpongeModule],
  exports: [ModelModule, ToolModule, McpModule, RunnerModule, MemoryModule, SpongeModule],
})
export class AiModule {}
