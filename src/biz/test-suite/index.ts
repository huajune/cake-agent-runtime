/**
 * Test Suite 模块导出
 */

// 模块
export { TestSuiteModule } from './test-suite.module';

// 门面服务
export { TestSuiteService } from './test-suite.service';

// Controller
export { TestSuiteController } from './test-suite.controller';

// Processor
export {
  TestSuiteProcessor,
  type TestJobData,
  type TestJobResult,
  type BatchProgress,
} from './test-suite.processor';

// 子服务
export {
  TestExecutionService,
  TestBatchService,
  TestImportService,
  TestWriteBackService,
  FeishuTestSyncService,
  TestStatsService,
} from './services';

// 实体
export type { TestBatch, TestExecution } from './entities';
export type { ConversationSourceRecord } from './entities';

// 枚举
export {
  BatchStatus,
  BatchSource,
  ExecutionStatus,
  ReviewStatus,
  MessageRole,
  FeishuTestStatus,
} from './enums';

// DTO
export {
  TestChatRequestDto,
  TestChatResponse,
  CreateBatchRequestDto,
  UpdateReviewRequestDto,
  ImportFromFeishuRequestDto,
  ImportResult,
  BatchStats,
} from './dto/test-chat.dto';
