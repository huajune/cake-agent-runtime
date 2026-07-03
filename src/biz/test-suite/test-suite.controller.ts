import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Res,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { Response } from 'express';
import { TestExecutionService } from './services/test-execution.service';
import { TestBatchService } from './services/test-batch.service';
import { TestImportService } from './services/test-import.service';
import { TestWriteBackService } from './services/test-write-back.service';
import { ConversationTestService } from './services/conversation-test.service';
import { TestSuiteStreamingService } from './services/test-suite-streaming.service';
import { TestSuiteQueueService } from './services/test-suite-queue.service';
import { TestFeedbackService } from './services/test-feedback.service';
import { TestSuiteSessionService } from './services/test-suite-session.service';
import { CuratedDatasetImportService } from './services/curated-dataset-import.service';
import {
  TestChatRequestDto,
  BatchTestRequestDto,
  CreateBatchRequestDto,
  UpdateReviewRequestDto,
  ImportFromFeishuRequestDto,
  VercelAIChatRequestDto,
  SubmitFeedbackRequestDto,
  QuickCreateBatchRequestDto,
  WriteBackFeishuRequestDto,
  ResetChatSessionRequestDto,
  ImportCuratedScenarioDatasetRequestDto,
  ImportCuratedConversationDatasetRequestDto,
} from './dto/test-chat.dto';
import {
  GetConversationSourcesDto,
  UpdateTurnReviewDto,
  ExecuteConversationBatchDto,
  ExecuteConversationDto,
  SyncConversationTestsDto,
} from './dto/conversation-test.dto';
import { BatchSource, ExecutionStatus, ReviewStatus, TestType } from './enums/test.enum';

/**
 * 测试套件控制器
 */
@ApiTags('测试套件')
@Controller('test-suite')
export class TestSuiteController {
  constructor(
    private readonly executionService: TestExecutionService,
    private readonly batchService: TestBatchService,
    private readonly importService: TestImportService,
    private readonly writeBackService: TestWriteBackService,
    private readonly conversationTestService: ConversationTestService,
    private readonly streamingService: TestSuiteStreamingService,
    private readonly queueService: TestSuiteQueueService,
    private readonly feedbackService: TestFeedbackService,
    private readonly sessionService: TestSuiteSessionService,
    private readonly curatedDatasetImportService: CuratedDatasetImportService,
  ) {}

  // ==================== 单条测试 ====================

  @Post('chat')
  @ApiOperation({ summary: '执行单条测试' })
  async testChat(@Body() request: TestChatRequestDto) {
    return {
      success: true,
      data: await this.executionService.executeTest(request),
    };
  }

  @Post('chat/stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @ApiOperation({ summary: '执行流式测试（SSE）' })
  async testChatStream(@Body() request: TestChatRequestDto, @Res() res: Response) {
    return this.streamingService.testChatStream(request, res);
  }

  @Post('chat/ai-stream')
  @ApiOperation({ summary: '执行流式测试（Vercel AI SDK UI Message Stream 格式）' })
  async testChatAIStream(@Body() request: VercelAIChatRequestDto, @Res() res: Response) {
    return this.streamingService.testChatAIStream(request, res);
  }

  @Post('chat/reset-session')
  @ApiOperation({ summary: '重置测试会话并清理长期画像' })
  async resetChatSession(@Body() request: ResetChatSessionRequestDto) {
    return this.sessionService.resetChatSession(request);
  }

  // ==================== 批量测试 ====================

  @Post('batch')
  @ApiOperation({ summary: '批量执行测试' })
  async batchTest(@Body() request: BatchTestRequestDto) {
    let batchId: string | undefined;
    if (request.batchName) {
      const batch = await this.batchService.createBatch({
        name: request.batchName,
        source: BatchSource.MANUAL,
      });
      batchId = batch.id;
    }

    const results = await this.batchService.executeBatch(request.cases, batchId, request.parallel);

    return {
      success: true,
      data: {
        batchId,
        totalCases: results.length,
        successCount: results.filter((r) => r.status === ExecutionStatus.SUCCESS).length,
        failureCount: results.filter((r) => r.status === ExecutionStatus.FAILURE).length,
        results,
      },
    };
  }

  // ==================== 批次管理 ====================

  @Post('batches')
  @ApiOperation({ summary: '创建测试批次' })
  async createBatch(@Body() request: CreateBatchRequestDto) {
    return { success: true, data: await this.batchService.createBatch(request) };
  }

  @Post('batches/import-from-feishu')
  @ApiOperation({ summary: '从飞书多维表格导入测试用例' })
  async importFromFeishu(@Body() request: ImportFromFeishuRequestDto) {
    return { success: true, data: await this.importService.importFromFeishu(request) };
  }

  @Post('datasets/scenario/import-curated')
  @ApiOperation({ summary: '导入策展后的正式测试集（幂等 upsert）' })
  async importCuratedScenarioDataset(@Body() request: ImportCuratedScenarioDatasetRequestDto) {
    return {
      success: true,
      data: await this.curatedDatasetImportService.importScenarioDataset(request),
    };
  }

  @Post('datasets/conversation/import-curated')
  @ApiOperation({ summary: '导入策展后的正式验证集（幂等 upsert）' })
  async importCuratedConversationDataset(
    @Body() request: ImportCuratedConversationDatasetRequestDto,
  ) {
    return {
      success: true,
      data: await this.curatedDatasetImportService.importConversationDataset(request),
    };
  }

  @Post('batches/quick-create')
  @ApiOperation({ summary: '一键创建批量测试' })
  async quickCreateBatch(@Body() request: QuickCreateBatchRequestDto) {
    return {
      success: true,
      data: await this.importService.quickCreateBatch({
        batchName: request.batchName,
        parallel: request.parallel,
        testType: request.testType || TestType.SCENARIO,
      }),
    };
  }

  @Get('batches')
  @ApiOperation({ summary: '获取测试批次列表' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'testType', required: false, enum: ['scenario', 'conversation'] })
  async getBatches(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('testType') testType?: TestType,
  ) {
    return this.batchService.getBatches(limit || 20, offset || 0, testType);
  }

  @Get('batches/:id')
  @ApiOperation({ summary: '获取批次详情' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getBatch(@Param('id') id: string) {
    const batch = await this.batchService.getBatch(id);
    if (!batch) {
      throw new HttpException('批次不存在', HttpStatus.NOT_FOUND);
    }
    return { success: true, data: batch };
  }

  @Get('batches/:id/stats')
  @ApiOperation({ summary: '获取批次统计信息' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getBatchStats(@Param('id') id: string) {
    return { success: true, data: await this.batchService.getBatchStats(id) };
  }

  @Get('batches/:id/progress')
  @ApiOperation({ summary: '获取批次执行进度' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getBatchProgress(@Param('id') id: string) {
    return this.queueService.getBatchProgress(id);
  }

  @Post('batches/:id/cancel')
  @ApiOperation({ summary: '取消批次执行' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async cancelBatch(@Param('id') id: string) {
    return this.queueService.cancelBatch(id);
  }

  @Get('batches/:id/category-stats')
  @ApiOperation({ summary: '获取批次分类统计' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getCategoryStats(@Param('id') id: string) {
    return { success: true, data: await this.batchService.getCategoryStats(id) };
  }

  @Get('batches/:id/failure-stats')
  @ApiOperation({ summary: '获取批次失败原因统计' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getFailureReasonStats(@Param('id') id: string) {
    return { success: true, data: await this.batchService.getFailureReasonStats(id) };
  }

  // ==================== 执行记录 ====================

  @Get('batches/:id/executions')
  @ApiOperation({ summary: '获取批次的执行记录（列表版）' })
  @ApiParam({ name: 'id', description: '批次ID' })
  @ApiQuery({ name: 'reviewStatus', required: false, enum: ReviewStatus })
  @ApiQuery({ name: 'executionStatus', required: false, enum: ExecutionStatus })
  @ApiQuery({ name: 'category', required: false })
  async getBatchExecutions(
    @Param('id') id: string,
    @Query('reviewStatus') reviewStatus?: ReviewStatus,
    @Query('executionStatus') executionStatus?: ExecutionStatus,
    @Query('category') category?: string,
  ) {
    const executions = await this.batchService.getBatchExecutionsForList(id, {
      reviewStatus,
      executionStatus,
      category,
    });
    return { success: true, data: executions };
  }

  @Get('executions')
  @ApiOperation({ summary: '获取执行记录列表' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getExecutions(@Query('limit') limit?: number, @Query('offset') offset?: number) {
    return {
      success: true,
      data: await this.executionService.getExecutions(limit || 50, offset || 0),
    };
  }

  @Get('executions/:id')
  @ApiOperation({ summary: '获取执行记录详情' })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async getExecution(@Param('id') id: string) {
    const execution = await this.executionService.getExecution(id);
    if (!execution) {
      throw new HttpException('执行记录不存在', HttpStatus.NOT_FOUND);
    }
    return { success: true, data: execution };
  }

  @Post('executions/:id/execute')
  @ApiOperation({ summary: '重新执行单条测试用例' })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async rerunExecution(@Param('id') id: string) {
    return { success: true, data: await this.batchService.rerunExecution(id) };
  }

  // ==================== 评审管理 ====================

  @Patch('executions/:id/review')
  @ApiOperation({ summary: '更新评审状态' })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async updateReview(@Param('id') id: string, @Body() review: UpdateReviewRequestDto) {
    return { success: true, data: await this.batchService.updateReview(id, review) };
  }

  @Patch('executions/batch-review')
  @ApiOperation({ summary: '批量更新评审状态' })
  async batchUpdateReview(
    @Body() body: { executionIds: string[]; review: UpdateReviewRequestDto },
  ) {
    const count = await this.batchService.batchUpdateReview(body.executionIds, body.review);
    return { success: true, data: { updatedCount: count } };
  }

  // ==================== 飞书回写 ====================

  @Post('executions/:id/write-back')
  @ApiOperation({ summary: '回写测试结果到飞书' })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async writeBackToFeishu(@Param('id') id: string, @Body() request: WriteBackFeishuRequestDto) {
    if (request.executionId && request.executionId !== id) {
      throw new HttpException('执行记录ID不匹配', HttpStatus.BAD_REQUEST);
    }
    const result = await this.writeBackService.writeBackToFeishu(
      id,
      request.testStatus,
      request.errorReason,
    );
    return { success: result.success, data: result };
  }

  @Post('executions/batch-write-back')
  @ApiOperation({ summary: '批量回写测试结果到飞书' })
  async batchWriteBackToFeishu(@Body() body: { items: WriteBackFeishuRequestDto[] }) {
    const results = await this.writeBackService.batchWriteBackToFeishu(body.items);
    return {
      success: true,
      data: {
        totalCount: body.items.length,
        successCount: results.success,
        failureCount: results.failed,
        errors: results.errors,
      },
    };
  }

  // ==================== 队列管理 ====================

  @Get('queue/status')
  @ApiOperation({ summary: '获取测试队列状态' })
  async getQueueStatus() {
    return this.queueService.getQueueStatus();
  }

  @Post('queue/clean-failed')
  @ApiOperation({ summary: '清理失败的任务' })
  async cleanFailedJobs() {
    return this.queueService.cleanFailedJobs();
  }

  // ==================== 反馈管理 ====================

  @Post('feedback')
  @ApiOperation({ summary: '提交测试反馈' })
  async submitFeedback(@Body() request: SubmitFeedbackRequestDto) {
    return this.feedbackService.submitFeedback(request);
  }

  // ==================== 回归验证 ====================

  @Post('conversations/sync')
  @ApiOperation({ summary: '从飞书同步回归验证记录' })
  async syncConversationTests(@Body() _request: SyncConversationTestsDto) {
    throw new HttpException('回归验证同步功能即将上线', HttpStatus.NOT_IMPLEMENTED);
  }

  @Get('conversations')
  @ApiOperation({ summary: '获取对话源列表' })
  @ApiQuery({ name: 'batchId', required: true })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 20 })
  async getConversationSources(@Query() query: GetConversationSourcesDto) {
    const { batchId, page = 1, pageSize = 20, status } = query;
    return {
      success: true,
      data: await this.conversationTestService.getConversationSources(
        batchId,
        page,
        pageSize,
        status,
      ),
    };
  }

  @Get('conversations/:sourceId/turns')
  @ApiOperation({ summary: '获取对话轮次列表' })
  @ApiParam({ name: 'sourceId', description: '对话源ID' })
  async getConversationTurns(@Param('sourceId') sourceId: string) {
    return {
      success: true,
      data: await this.conversationTestService.getConversationTurns(sourceId),
    };
  }

  @Post('conversations/:sourceId/execute')
  @ApiOperation({ summary: '执行单个回归验证' })
  @ApiParam({ name: 'sourceId', description: '对话源ID' })
  async executeConversation(
    @Param('sourceId') sourceId: string,
    @Body() request: ExecuteConversationDto,
  ) {
    return {
      success: true,
      data: await this.conversationTestService.executeConversation(sourceId, request.forceRerun),
    };
  }

  @Post('conversations/batch/:batchId/execute')
  @ApiOperation({ summary: '批量执行回归验证' })
  @ApiParam({ name: 'batchId', description: '批次ID' })
  async executeConversationBatch(
    @Param('batchId') batchId: string,
    @Body() request: ExecuteConversationBatchDto,
  ) {
    return {
      success: true,
      data: await this.conversationTestService.executeConversationBatch(
        batchId,
        request.forceRerun,
      ),
    };
  }

  @Patch('conversations/turns/:executionId/review')
  @ApiOperation({ summary: '更新轮次评审状态' })
  @ApiParam({ name: 'executionId', description: '执行记录ID' })
  async updateTurnReview(
    @Param('executionId') executionId: string,
    @Body() request: UpdateTurnReviewDto,
  ) {
    if (request.executionId && request.executionId !== executionId) {
      throw new HttpException('执行记录ID不匹配', HttpStatus.BAD_REQUEST);
    }

    return {
      success: true,
      data: await this.conversationTestService.updateTurnReview(
        executionId,
        request.reviewStatus,
        request.reviewComment,
        request.reviewerSource,
        request.reviewedBy,
      ),
    };
  }
}
