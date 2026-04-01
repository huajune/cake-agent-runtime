import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@infra/client-http/http.module';
import { TestBatchRepository } from './repositories/test-batch.repository';
import { TestExecutionRepository } from './repositories/test-execution.repository';
import { ConversationSnapshotRepository } from './repositories/conversation-snapshot.repository';
import { TestSuiteController } from './test-suite.controller';
import { TestSuiteProcessor } from './test-suite.processor';
import { TestExecutionService } from './services/test-execution.service';
import { TestBatchService } from './services/test-batch.service';
import { TestImportService } from './services/test-import.service';
import { TestWriteBackService } from './services/test-write-back.service';
import { ConversationTestService } from './services/conversation-test.service';
import { AgentModule } from '@agent/agent.module';
import { BizModule } from '@biz/biz.module';
import { FeishuSyncModule } from '@biz/feishu-sync/feishu-sync.module';
import { EvaluationModule } from '@evaluation/evaluation.module';

/**
 * 测试套件模块
 *
 * 架构（扁平化）：
 * - TestExecutionService: 测试执行（单条/流式）
 * - TestBatchService: 批次管理 + 统计
 * - TestImportService: 飞书导入 + 表格解析
 * - TestWriteBackService: 飞书回写
 * - ConversationTestService: 回归验证执行
 * - TestSuiteProcessor: Bull Queue 任务处理器
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    AgentModule,
    BizModule,
    FeishuSyncModule,
    EvaluationModule,
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
    // Repositories
    TestBatchRepository,
    TestExecutionRepository,
    ConversationSnapshotRepository,

    // Services（注意：TestWriteBackService 和 TestExecutionService 需在 TestBatchService 之前）
    TestExecutionService,
    TestWriteBackService,
    TestBatchService,
    ConversationTestService,
    TestSuiteProcessor,
    TestImportService,
  ],
  exports: [
    TestExecutionService,
    TestBatchService,
    TestImportService,
    TestWriteBackService,
    TestSuiteProcessor,
    ConversationTestService,
  ],
})
export class TestSuiteModule {}
