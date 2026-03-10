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

// 仓储
export {
  TestBatchRepository,
  TestExecutionRepository,
  type TestBatch,
  type TestExecution,
} from '@db/test-suite';

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
