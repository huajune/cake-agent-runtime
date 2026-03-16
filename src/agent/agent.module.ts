import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@core/client-http';
import { FeishuModule } from '@core/feishu';
import { AgentService } from './agent.service';
import { AgentRegistryService } from './services/agent-registry.service';
import { AgentFallbackService } from './services/agent-fallback.service';
import { AgentApiClientService } from './services/agent-api-client.service';
import { AgentFacadeService } from './services/agent-facade.service';
import { AgentConfigValidator } from './utils/agent-validator';
import { AgentController } from './agent.controller';
import { ProfileLoaderService } from './services/agent-profile-loader.service';
import { StrategyConfigService } from './strategy/strategy-config.service';
import { BizModule } from '@biz/biz.module';

// 企微 Agent 编排
import { WeworkAgentOrchestratorService } from './services/wework-agent-orchestrator.service';

/**
 * AI Agent 模块
 *
 * 服务架构：
 * - 遗留路径：AgentService → AgentApiClientService → 花卷 HTTP API（待下线）
 * - 新路径：WeworkAgentOrchestratorService → ToolRegistry → AgentRunnerService（本地 AI SDK）
 *
 * 已迁移到 ai/ 的能力：
 * - ClassificationAgentService → ai/tool/wework-plan-turn.tool.ts（内联）
 * - WeworkSessionMemoryService → ai/memory/memory.service.ts
 * - FactExtractionService → ai/memory/ + memory_store 工具
 * - WeworkPreprocessorService → memory_recall 工具
 * - 3 个工具服务 → ai/tool/（ToolFactory + ToolRegistry 自动注册）
 */
@Module({
  imports: [ConfigModule, HttpModule, FeishuModule, BizModule],
  controllers: [AgentController],
  providers: [
    // ==================== 遗留服务（花卷路径，待下线） ====================
    AgentApiClientService,
    AgentFallbackService,
    AgentRegistryService,
    AgentConfigValidator,

    // ==================== 配置服务 ====================
    ProfileLoaderService,
    StrategyConfigService,

    // ==================== 主服务 ====================
    AgentService,
    AgentFacadeService,

    // ==================== 编排 ====================
    WeworkAgentOrchestratorService,
  ],
  exports: [
    AgentService,
    AgentApiClientService,
    AgentRegistryService,
    AgentFallbackService,
    AgentConfigValidator,
    ProfileLoaderService,
    AgentFacadeService,
    StrategyConfigService,
    WeworkAgentOrchestratorService,
  ],
})
export class AgentModule {}
