import { Body, Controller, Get, HttpException, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { TestSuiteService } from './test-suite.service';
import {
  BatchSource,
  ExecutionStatus,
  FeishuTestStatus,
  ReviewStatus,
  TestType,
} from './enums/test.enum';

@Controller('test-suite')
export class TestSuiteController {
  constructor(private readonly testService: TestSuiteService) {}

  @Post('chat')
  async testChat(@Body() request: Record<string, unknown>) {
    return { success: true, data: await this.testService.executeTest(request) };
  }

  @Post('batch')
  async batchTest(
    @Body()
    request: {
      batchName?: string;
      cases: Array<Record<string, unknown>>;
      parallel?: boolean;
    },
  ) {
    let batchId: string | undefined;

    if (request.batchName) {
      const batch = await this.testService.createBatch({
        name: request.batchName,
        source: BatchSource.MANUAL,
      });
      batchId = batch.id;
    }

    const results = await this.testService.executeBatch(request.cases, batchId, request.parallel);

    return {
      success: true,
      data: {
        batchId,
        totalCases: results.length,
        successCount: results.filter((result) => result.status === 'success').length,
        failureCount: results.filter((result) => result.status === 'failure').length,
        results,
      },
    };
  }

  @Post('batches')
  async createBatch(@Body() request: Record<string, unknown>) {
    return { success: true, data: await this.testService.createBatch(request) };
  }

  @Post('batches/import-from-feishu')
  async importFromFeishu(@Body() request: Record<string, unknown>) {
    return { success: true, data: await this.testService.importFromFeishu(request) };
  }

  @Post('batches/quick-create')
  async quickCreateBatch(@Body() request: { batchName?: string; parallel?: boolean; testType?: TestType }) {
    return {
      success: true,
      data: await this.testService.quickCreateBatch({
        batchName: request.batchName,
        parallel: request.parallel,
        testType: request.testType || TestType.SCENARIO,
      }),
    };
  }

  @Get('batches')
  getBatches(@Query('limit') limit?: number, @Query('offset') offset?: number, @Query('testType') testType?: TestType) {
    return this.testService.getBatches(limit || 20, offset || 0, testType);
  }

  @Get('batches/:id')
  async getBatch(@Param('id') id: string) {
    const batch = await this.testService.getBatch(id);
    if (!batch) {
      throw new HttpException('批次不存在', HttpStatus.NOT_FOUND);
    }
    return { success: true, data: batch };
  }

  @Get('batches/:id/stats')
  async getBatchStats(@Param('id') id: string) {
    return { success: true, data: await this.testService.getBatchStats(id) };
  }

  @Get('batches/:id/progress')
  async getBatchProgress(@Param('id') id: string) {
    return { success: true, data: await this.testService.getBatchProgress(id) };
  }

  @Post('batches/:id/cancel')
  async cancelBatch(@Param('id') id: string) {
    return { success: true, data: await this.testService.cancelBatch(id) };
  }

  @Get('batches/:id/category-stats')
  async getCategoryStats(@Param('id') id: string) {
    return { success: true, data: await this.testService.getCategoryStats(id) };
  }

  @Get('batches/:id/failure-reasons')
  async getFailureReasonStats(@Param('id') id: string) {
    return { success: true, data: await this.testService.getFailureReasonStats(id) };
  }

  @Get('batches/:id/executions')
  async getBatchExecutions(
    @Param('id') id: string,
    @Query('reviewStatus') reviewStatus?: ReviewStatus,
    @Query('executionStatus') executionStatus?: ExecutionStatus,
    @Query('category') category?: string,
  ) {
    return {
      success: true,
      data: await this.testService.getBatchExecutionsForList(id, {
        reviewStatus,
        executionStatus,
        category,
      }),
    };
  }

  @Get('executions')
  async getExecutions(@Query('limit') limit?: number, @Query('offset') offset?: number) {
    return { success: true, data: await this.testService.getExecutions(limit || 50, offset || 0) };
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string) {
    const execution = await this.testService.getExecution(id);
    if (!execution) {
      throw new HttpException('执行记录不存在', HttpStatus.NOT_FOUND);
    }
    return { success: true, data: execution };
  }

  @Patch('executions/:id/review')
  async updateReview(@Param('id') id: string, @Body() review: Record<string, unknown>) {
    return { success: true, data: await this.testService.updateReview(id, review) };
  }

  @Patch('executions/review')
  async batchUpdateReview(
    @Body() body: { executionIds: string[]; review: Record<string, unknown> },
  ) {
    const updatedCount = await this.testService.batchUpdateReview(body.executionIds, body.review);
    return { success: true, data: { updatedCount } };
  }

  @Post('executions/:id/write-back')
  async writeBackToFeishu(
    @Param('id') id: string,
    @Body()
    request: { executionId?: string; testStatus: FeishuTestStatus; errorReason?: string },
  ) {
    if (request.executionId && request.executionId !== id) {
      throw new HttpException('执行记录ID不匹配', HttpStatus.BAD_REQUEST);
    }

    return {
      success: true,
      data: await this.testService.writeBackToFeishu(id, request.testStatus, request.errorReason),
    };
  }

  @Post('executions/write-back')
  async batchWriteBackToFeishu(
    @Body()
    body: {
      items: Array<{
        executionId: string;
        testStatus: FeishuTestStatus;
        errorReason?: string;
      }>;
    },
  ) {
    const result = await this.testService.batchWriteBackToFeishu(body.items);
    return {
      success: true,
      data: {
        totalCount: body.items.length,
        successCount: result.success,
        failureCount: result.failed,
        errors: result.errors,
      },
    };
  }

  @Get('queue/status')
  async getQueueStatus() {
    return { success: true, data: await this.testService.getQueueStatus() };
  }

  @Post('queue/clean-failed')
  async cleanFailedJobs() {
    const removedCount = await this.testService.cleanFailedJobs();
    return {
      success: true,
      data: { removedCount, message: `已清理 ${removedCount} 个失败任务` },
    };
  }

  @Post('feedback')
  async submitFeedback(@Body() request: Record<string, unknown>) {
    return { success: true, data: await this.testService.submitFeedback(request) };
  }

  @Post('conversations/sync')
  async syncConversationTests(@Body() _request: Record<string, unknown>) {
    throw new HttpException('回归验证同步功能即将上线', HttpStatus.NOT_IMPLEMENTED);
  }

  @Get('conversations')
  async getConversationSources(@Query() query: { batchId: string; page?: number; pageSize?: number; status?: string }) {
    return {
      success: true,
      data: await this.testService.getConversationSources(
        query.batchId,
        query.page || 1,
        query.pageSize || 20,
        query.status,
      ),
    };
  }

  @Get('conversations/:sourceId/turns')
  async getConversationTurns(@Param('sourceId') sourceId: string) {
    return { success: true, data: await this.testService.getConversationTurns(sourceId) };
  }

  @Post('conversations/:sourceId/execute')
  async executeConversation(@Param('sourceId') sourceId: string, @Body() request: { forceRerun?: boolean }) {
    return { success: true, data: await this.testService.executeConversation(sourceId, request.forceRerun) };
  }

  @Post('conversations/batches/:batchId/execute')
  async executeConversationBatch(@Param('batchId') batchId: string, @Body() request: { forceRerun?: boolean }) {
    return { success: true, data: await this.testService.executeConversationBatch(batchId, request.forceRerun) };
  }

  @Patch('conversations/turns/:executionId/review')
  async updateTurnReview(
    @Param('executionId') executionId: string,
    @Body() request: { reviewStatus: ReviewStatus; reviewComment?: string },
  ) {
    return {
      success: true,
      data: await this.testService.updateTurnReview(
        executionId,
        request.reviewStatus,
        request.reviewComment,
      ),
    };
  }
}
