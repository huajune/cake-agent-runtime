import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@core/client-http';
import { TestSuiteController } from './test-suite.controller';
import { TestSuiteService } from './test-suite.service';
import { TestSuiteProcessor } from './test-suite.processor';
import {
  TestExecutionService,
  TestBatchService,
  TestImportService,
  TestWriteBackService,
  FeishuTestSyncService,
  TestStatsService,
  ConversationTestService,
  SemanticSimilarityService,
} from './services';
import {
  TestBatchRepository,
  TestExecutionRepository,
  ConversationSourceRepository,
} from './repositories';
import { AgentModule } from '@agent';
import { FeishuModule } from '@core/feishu';

/**
 * 测试套件模块
 * 提供 Agent 测试执行、结果保存、批次管理等功能
 *
 * 架构说明：
 * - TestSuiteService: 门面服务，统一对外接口
 * - TestExecutionService: 测试执行子服务
 * - TestBatchService: 批次管理子服务
 * - TestImportService: 飞书导入子服务
 * - TestWriteBackService: 飞书回写子服务
 * - TestSuiteProcessor: Bull Queue 任务处理器
 *
 * 特性：
 * - 使用 Bull Queue 处理长时间运行的测试任务（30-50秒/任务）
 * - 支持任务进度实时查询
 * - 支持批次取消和失败重试
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    AgentModule,
    FeishuModule,
    // 注册测试套件队列
    BullModule.registerQueueAsync({
      name: 'test-suite',
      imports: [ConfigModule],
      useFactory: async (_configService: ConfigService) => {
        return {
          defaultJobOptions: {
            attempts: 2,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            timeout: 120000,
            removeOnComplete: true,
            removeOnFail: false,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [TestSuiteController],
  providers: [
    // 仓储层
    TestBatchRepository,
    TestExecutionRepository,
    ConversationSourceRepository,

    // 基础服务（无依赖其他子服务）
    TestStatsService,
    FeishuTestSyncService,
    SemanticSimilarityService,

    // 子服务（有依赖关系）
    TestExecutionService,
    TestBatchService,
    ConversationTestService,

    // Processor（依赖子服务，使用 forwardRef 解决循环依赖）
    TestSuiteProcessor,

    // 导入服务（依赖 Processor）
    TestImportService,

    // 回写服务
    TestWriteBackService,

    // 门面服务
    TestSuiteService,
  ],
  exports: [
    // 导出门面服务和子服务
    TestSuiteService,
    TestExecutionService,
    TestBatchService,
    TestImportService,
    TestWriteBackService,
    TestSuiteProcessor,
    FeishuTestSyncService,
    TestStatsService,
    ConversationTestService,
    SemanticSimilarityService,
    TestBatchRepository,
    TestExecutionRepository,
    ConversationSourceRepository,
  ],
})
export class TestSuiteModule {}
