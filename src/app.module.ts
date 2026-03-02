/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule, RedisModule } from './core';
import { SupabaseModule } from './core/supabase';
import { MonitoringModule } from './core/monitoring/monitoring.module';
import { LoggerModule } from './core/logger';
import { FeishuModule } from './core/feishu';
import { AgentModule } from './agent';
import { TestSuiteModule } from './test-suite/test-suite.module';
import { WecomModule } from './wecom/wecom.module';
import { validate } from './core/config/env.validation';

/**
 * 应用根模块
 *
 * 采用扁平化 DDD 架构设计：
 * - Core Layer (核心层): 技术基础设施（水平分层）
 * - Business Domains (业务域): 各业务领域（垂直分层）
 *
 * 目录结构: src/
 *   ├── core/              - 核心技术层
 *   │   ├── client-http/   - 客户端 HTTP 工具
 *   │   ├── response/      - 响应处理（拦截器、过滤器）
 *   │   ├── redis/         - Redis 缓存服务
 *   │   ├── supabase/      - Supabase 数据库服务
 *   │   ├── monitoring/    - 监控服务（指标、仪表盘）
 *   │   ├── alert/         - 告警服务
 *   │   ├── feishu-sync/   - 飞书同步服务
 *   │   └── config/        - 配置管理
 *   │
 *   ├── agent/             - AI Agent 业务域
 *   └── wecom/             - 企业微信业务域
 */
@Module({
  imports: [
    // ==================== 全局配置 ====================
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        // 本地 Agent 服务模式（AGENT_ENV=local）：优先加载本地 Agent 配置覆盖
        ...(process.env.AGENT_ENV === 'local' ? ['.env.agent.local'] : []),
        '.env.local', // 优先加载本地配置
        `.env.${process.env.NODE_ENV || 'development'}`,
        '.env',
      ],
      expandVariables: true,
      validate, // 启用环境变量验证，确保所有必需配置在启动时加载
    }),

    // ==================== 核心层 (Core Layer) ====================
    HttpModule, // HTTP 客户端服务
    RedisModule, // Redis 缓存服务（全局）
    SupabaseModule, // Supabase 数据库服务（全局）- 系统配置和用户托管状态持久化
    MonitoringModule, // 监控服务（全局）
    FeishuModule, // 飞书统一服务（告警、通知、多维表格同步）
    LoggerModule, // 实时日志推送（仅开发环境）

    // ==================== 业务域 (Business Domains) ====================
    AgentModule, // AI Agent 业务域
    TestSuiteModule, // 测试套件模块
    WecomModule, // 企业微信业务域
  ],
})
export class AppModule {}
