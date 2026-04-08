/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from './infra/client-http/http.module';
import { RedisModule } from './infra/redis/redis.module';
import { GeocodingModule } from './infra/geocoding/geocoding.module';
import { SupabaseModule } from '@infra/supabase/supabase.module';
import { LoggerModule } from './infra/logger/logger.module';
import { WebEntryModule } from '@infra/server/web-entry/web-entry.module';
import { FeishuModule } from './infra/feishu/feishu.module';
import { ProvidersModule } from '@providers/providers.module';
import { ToolModule } from '@tools/tool.module';
import { McpModule } from '@mcp/mcp.module';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { AgentModule } from './agent/agent.module';
import { WecomModule } from '@channels/wecom/wecom.module';
import { BizModule } from '@biz/biz.module';
import { TestSuiteModule } from '@biz/test-suite/test-suite.module';
import { EvaluationModule } from './evaluation/evaluation.module';
import { validate } from './infra/config/env.validation';
import { ApiTokenGuard } from './infra/server/guards/api-token.guard';

/**
 * 应用根模块
 *
 * 架构：
 * - Core Layer: 技术基础设施（Redis、Supabase、飞书、HTTP）
 * - Provider Layer: 多模型 Provider + 容错 + 路由（@Global）
 * - AI Capability Layer: 工具、MCP、记忆、海绵数据（独立模块）
 * - Observability: Observer 可观测性
 * - Agent Layer: 编排 + Profile + 策略
 * - Channel Layer: 企业微信渠道
 * - Business Layer: 监控、用户、消息等业务逻辑
 */
@Module({
  imports: [
    // ==================== 全局配置 ====================
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        ...(process.env.AGENT_ENV === 'local' ? ['.env.agent.local'] : []),
        '.env.local',
        `.env.${process.env.NODE_ENV || 'development'}`,
        '.env',
      ],
      expandVariables: true,
      validate,
    }),

    // ==================== 核心层 (Core Layer) ====================
    HttpModule,
    RedisModule,
    GeocodingModule,
    SupabaseModule,
    FeishuModule,
    LoggerModule,
    WebEntryModule,

    // ==================== 业务逻辑层 (Business Logic Layer) ====================
    BizModule,

    // ==================== AI 基础设施 (AI Infrastructure) ====================
    ProvidersModule, // 多模型 Provider（@Global，三层架构）
    ToolModule, // 工具注册表 + 内置工具
    McpModule, // MCP 客户端
    MemoryModule, // 记忆服务（Redis-backed）
    SpongeModule, // 海绵数据服务（岗位/面试 HTTP）
    EvaluationModule, // Agent 评估（LLM 评分 + 对话解析）
    ObservabilityModule, // Observer 可观测性

    // ==================== 业务域 (Business Domains) ====================
    AgentModule, // AI Agent 编排
    WecomModule, // 企业微信渠道
    TestSuiteModule, // Agent 测试套件（独立于 BizModule，避免循环依赖）
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiTokenGuard }],
})
export class AppModule {}
