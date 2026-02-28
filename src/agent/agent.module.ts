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
import { StrategyConfigController } from './strategy/strategy-config.controller';

/**
 * AI Agent 模块
 * 提供 AI Agent 集成能力，包括配置管理和资源注册表
 *
 * 服务架构（简化版）：
 * - AgentService: 核心业务逻辑层（组装请求、处理响应、降级策略）
 * - AgentApiClientService: HTTP 客户端层（API 调用、重试、速率限制）
 * - AgentRegistryService: 模型和工具注册表
 * - ProfileLoaderService: Profile 加载服务
 * - AgentFallbackService: 降级消息管理
 * - AgentConfigValidator: 配置验证器
 *
 * 工具类：
 * - ProfileSanitizer: Profile 清洗器（静态类，无需注册）
 * - AgentLogger: 日志工具（在 AgentService 中实例化）
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule, // 依赖 HTTP 模块提供的 HttpClientFactory
    FeishuModule, // 依赖告警模块提供的 FeishuAlertService
  ],
  controllers: [AgentController, StrategyConfigController],
  providers: [
    // 基础服务（按字母排序）
    AgentApiClientService,
    AgentFallbackService,
    AgentRegistryService,
    AgentConfigValidator,

    // 配置服务
    ProfileLoaderService,

    // 策略配置服务
    StrategyConfigService,

    // 主服务
    AgentService,

    // 门面服务（协调层）
    AgentFacadeService,
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
  ],
})
export class AgentModule {}
