import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
  Res,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { Response } from 'express';
import { TestSuiteService } from './test-suite.service';
import { TestSuiteProcessor } from './test-suite.processor';
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
} from './dto/test-chat.dto';
import {
  GetConversationSourcesDto,
  UpdateTurnReviewDto,
  ExecuteConversationBatchDto,
  ExecuteConversationDto,
  SyncConversationTestsDto,
} from './dto/conversation-test.dto';
import {
  BatchSource,
  BatchStatus,
  ExecutionStatus,
  MessageRole,
  ReviewStatus,
  TestType,
} from './enums';
import {
  FeishuBitableSyncService,
  AgentTestFeedback,
} from '@core/feishu/services/feishu-bitable.service';
import { SSEStreamHandler, VercelAIStreamHandler } from './utils/sse-stream-handler';
import { ConversationTestService, TestBatchService } from './services';
import { ConversationSourceRepository, TestExecutionRepository } from '@supabase/test-suite';

@ApiTags('测试套件')
@Controller('test-suite')
export class TestSuiteController {
  private readonly logger = new Logger(TestSuiteController.name);

  constructor(
    private readonly testService: TestSuiteService,
    private readonly feishuBitableService: FeishuBitableSyncService,
    private readonly testProcessor: TestSuiteProcessor,
    private readonly conversationTestService: ConversationTestService,
    private readonly conversationSourceRepository: ConversationSourceRepository,
    private readonly executionRepository: TestExecutionRepository,
    private readonly testBatchService: TestBatchService,
  ) {}

  // ==================== 单条测试 ====================

  /**
   * 执行单条测试
   * POST /agent/test/chat
   */
  @Post('chat')
  @ApiOperation({
    summary: '执行单条测试',
    description: '测试 Agent 对话并返回详细的请求/响应信息',
  })
  async testChat(@Body() request: TestChatRequestDto) {
    this.logger.log(`执行单条测试: ${request.message.substring(0, 50)}...`);

    try {
      const result = await this.testService.executeTest(request);
      return {
        success: true,
        data: result,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`测试执行失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 执行流式测试（SSE）
   * POST /agent/test/chat/stream
   *
   * 返回 Server-Sent Events 流，事件类型：
   * - start: 开始处理
   * - text: 文本增量
   * - tool_call: 工具调用开始
   * - tool_result: 工具调用结果
   * - metrics: 性能指标
   * - done: 完成
   * - error: 错误
   */
  @Post('chat/stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @ApiOperation({
    summary: '执行流式测试（SSE）',
    description: '通过 Server-Sent Events 返回流式响应',
  })
  async testChatStream(@Body() request: TestChatRequestDto, @Res() res: Response) {
    this.logger.log(`[Stream] 执行流式测试: ${request.message.substring(0, 50)}...`);

    // 使用 SSE 流处理工具类
    const handler = new SSEStreamHandler(res, '[Stream]');
    handler.setupHeaders();

    try {
      // 发送开始事件
      handler.sendStart();

      // 执行测试并获取流式响应
      const stream = await this.testService.executeTestStream(request);

      // 处理流式数据
      stream.on('data', (chunk: Buffer) => {
        handler.processChunk(chunk);
      });

      stream.on('end', () => {
        handler.sendDone();
        handler.end();
      });

      stream.on('error', (error: Error) => {
        this.logger.error(`[Stream] 流式处理错误: ${error.message}`);
        handler.sendError(error.message);
        handler.end();
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Stream] 测试执行失败: ${errorMessage}`);
      handler.sendError(errorMessage);
      handler.end();
    }
  }

  /**
   * 流式测试 - Vercel AI SDK 兼容格式
   * POST /agent/test/chat/ai-stream
   *
   * 接收 useChat hook 发送的请求，转换格式后调用花卷 API
   * 前端可使用 @ai-sdk/react 的 useChat hook 直接解析
   */
  @Post('chat/ai-stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @Header('x-vercel-ai-ui-message-stream', 'v1')
  @ApiOperation({
    summary: '执行流式测试（Vercel AI SDK 格式）',
    description: '接收 useChat hook 请求格式，兼容 DefaultChatTransport',
  })
  async testChatAIStream(@Body() request: VercelAIChatRequestDto, @Res() res: Response) {
    // 从 UIMessage 格式提取最新的用户消息
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1];

    // 从 parts 中提取文本内容
    const messageText =
      latestUserMessage?.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('') || '';

    this.logger.log(
      `[AI-Stream] 执行流式测试: ${messageText.substring(0, 50)}... (共 ${request.messages.length} 条消息)`,
    );

    try {
      // 将 UIMessage 格式转换为 SimpleMessage 格式
      const history = request.messages.slice(0, -1).map((msg) => {
        const textContent =
          msg.parts
            ?.filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('') || '';
        return {
          role: msg.role as MessageRole,
          content: textContent,
        };
      });

      // 构建 TestChatRequestDto 格式的请求
      const testRequest: TestChatRequestDto = {
        message: messageText,
        history,
        scenario: request.scenario || 'candidate-consultation',
        saveExecution: request.saveExecution ?? false,
        skipHistoryTrim: true,
        sessionId: request.sessionId,
        userId: request.userId,
        thinking: request.thinking,
      };

      // 立即 flush SSE headers + start 事件，让前端 useChat 进入 streaming 状态
      VercelAIStreamHandler.flushSSEHeaders(res);
      res.write(`data: ${JSON.stringify({ type: 'start', messageId: `msg-${Date.now()}` })}\n\n`);

      // 获取花卷 API 的流式响应（此处 await 可能耗时 1-3s，但前端已进入 streaming 状态）
      const { stream, estimatedInputTokens } =
        await this.testService.executeTestStreamWithMeta(testRequest);

      // 使用 Vercel AI SDK 流处理工具类（优先从 finish 事件提取真实 token usage，否则估算）
      const handler = new VercelAIStreamHandler(res, '[AI-Stream]', estimatedInputTokens);

      // 处理流式数据（透传并从 finish 事件捕获 token usage）
      stream.on('data', (chunk: Buffer) => {
        handler.processChunk(chunk);
      });

      stream.on('end', () => {
        handler.sendUsageAndEnd();
      });

      stream.on('error', (error: Error) => {
        this.logger.error(`[AI-Stream] 流式处理错误: ${error.message}`);
        handler.sendError(error.message);
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[AI-Stream] 测试执行失败: ${errorMessage}`);
      // 如果还没设置响应头，设置一下
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
      }
      res.write(`data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`);
      res.end();
    }
  }

  /**
   * 批量执行测试
   * POST /agent/test/batch
   */
  @Post('batch')
  @ApiOperation({ summary: '批量执行测试', description: '批量执行多个测试用例' })
  async batchTest(@Body() request: BatchTestRequestDto) {
    this.logger.log(`批量执行测试: ${request.cases.length} 个用例`);

    try {
      // 创建批次（如果提供了名称）
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
          successCount: results.filter((r) => r.status === ExecutionStatus.SUCCESS).length,
          failureCount: results.filter((r) => r.status === ExecutionStatus.FAILURE).length,
          results,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`批量测试执行失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ==================== 批次管理 ====================

  /**
   * 创建测试批次
   * POST /agent/test/batches
   */
  @Post('batches')
  @ApiOperation({ summary: '创建测试批次' })
  async createBatch(@Body() request: CreateBatchRequestDto) {
    this.logger.log(`创建测试批次: ${request.name}`);

    try {
      const batch = await this.testService.createBatch(request);
      return {
        success: true,
        data: batch,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`创建批次失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 从飞书多维表格导入测试用例
   * POST /agent/test/batches/import-from-feishu
   */
  @Post('batches/import-from-feishu')
  @ApiOperation({
    summary: '从飞书多维表格导入测试用例',
    description: '从飞书多维表格导入测试用例，自动识别字段映射',
  })
  async importFromFeishu(@Body() request: ImportFromFeishuRequestDto) {
    this.logger.log(`从飞书导入测试用例: appToken=${request.appToken}, tableId=${request.tableId}`);

    try {
      const result = await this.testService.importFromFeishu(request);
      return {
        success: true,
        data: result,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`导入失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 一键创建批量测试（从预配置的飞书测试/验证集表导入并执行）
   * POST /agent/test/batches/quick-create
   */
  @Post('batches/quick-create')
  @ApiOperation({
    summary: '一键创建批量测试',
    description: '从预配置的飞书测试/验证集表自动导入用例并执行测试',
  })
  async quickCreateBatch(@Body() request: QuickCreateBatchRequestDto) {
    const testType = request.testType || TestType.SCENARIO;
    this.logger.log(
      `一键创建批量测试: batchName=${request.batchName || '自动生成'}, testType=${testType}`,
    );

    try {
      const result = await this.testService.quickCreateBatch({
        batchName: request.batchName,
        parallel: request.parallel,
        testType,
      });
      return {
        success: true,
        data: result,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`一键创建批量测试失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取批次列表
   * GET /agent/test/batches
   */
  @Get('batches')
  @ApiOperation({ summary: '获取测试批次列表' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'testType',
    required: false,
    enum: ['scenario', 'conversation'],
    description: '测试类型过滤：scenario-用例测试，conversation-回归验证',
  })
  async getBatches(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('testType') testType?: TestType,
  ) {
    const result = await this.testService.getBatches(limit || 20, offset || 0, testType);
    return {
      success: true,
      data: result.data,
      total: result.total,
    };
  }

  /**
   * 获取批次详情
   * GET /agent/test/batches/:id
   */
  @Get('batches/:id')
  @ApiOperation({ summary: '获取批次详情' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getBatch(@Param('id') id: string) {
    const batch = await this.testService.getBatch(id);
    if (!batch) {
      throw new HttpException('批次不存在', HttpStatus.NOT_FOUND);
    }
    return {
      success: true,
      data: batch,
    };
  }

  /**
   * 获取批次统计信息
   * GET /agent/test/batches/:id/stats
   */
  @Get('batches/:id/stats')
  @ApiOperation({ summary: '获取批次统计信息' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getBatchStats(@Param('id') id: string) {
    const stats = await this.testService.getBatchStats(id);
    return {
      success: true,
      data: stats,
    };
  }

  /**
   * 获取批次执行进度（实时）
   * GET /agent/test/batches/:id/progress
   */
  @Get('batches/:id/progress')
  @ApiOperation({
    summary: '获取批次执行进度',
    description: '获取批次的实时执行进度，包括完成数、成功率、预估剩余时间等',
  })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getBatchProgress(@Param('id') id: string) {
    try {
      const progress = await this.testProcessor.getBatchProgress(id);
      return {
        success: true,
        data: progress,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取批次进度失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * 取消批次执行
   * POST /agent/test/batches/:id/cancel
   */
  @Post('batches/:id/cancel')
  @ApiOperation({
    summary: '取消批次执行',
    description:
      '取消批次中所有任务（等待中、延迟中、执行中）。执行中的任务会被标记为丢弃，完成后不更新统计。',
  })
  @ApiParam({ name: 'id', description: '批次ID' })
  async cancelBatch(@Param('id') id: string) {
    this.logger.log(`取消批次执行: ${id}`);

    try {
      const cancelled = await this.testProcessor.cancelBatchJobs(id);
      await this.testService.updateBatchStatusPublic(id, BatchStatus.CANCELLED);

      const totalCancelled = cancelled.waiting + cancelled.delayed + cancelled.active;

      return {
        success: true,
        data: {
          batchId: id,
          cancelled,
          totalCancelled,
          message: `已取消 ${totalCancelled} 个任务（等待=${cancelled.waiting}, 延迟=${cancelled.delayed}, 执行中=${cancelled.active}）`,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`取消批次失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取批次分类统计
   * GET /agent/test/batches/:id/category-stats
   */
  @Get('batches/:id/category-stats')
  @ApiOperation({ summary: '获取批次分类统计' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getCategoryStats(@Param('id') id: string) {
    const stats = await this.testService.getCategoryStats(id);
    return {
      success: true,
      data: stats,
    };
  }

  /**
   * 获取批次失败原因统计
   * GET /agent/test/batches/:id/failure-stats
   */
  @Get('batches/:id/failure-stats')
  @ApiOperation({ summary: '获取批次失败原因统计' })
  @ApiParam({ name: 'id', description: '批次ID' })
  async getFailureReasonStats(@Param('id') id: string) {
    const stats = await this.testService.getFailureReasonStats(id);
    return {
      success: true,
      data: stats,
    };
  }

  // ==================== 执行记录管理 ====================

  /**
   * 获取批次的执行记录（列表版，轻量）
   * GET /agent/test/batches/:id/executions
   *
   * 只返回列表展示所需字段，排除大型 JSON 字段以提升性能
   * 如需完整数据，使用 GET /agent/test/executions/:id 获取单条详情
   */
  @Get('batches/:id/executions')
  @ApiOperation({
    summary: '获取批次的执行记录（列表版）',
    description: '返回列表展示所需字段，排除大型 JSON 字段以提升性能',
  })
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
    const executions = await this.testService.getBatchExecutionsForList(id, {
      reviewStatus,
      executionStatus,
      category,
    });
    return {
      success: true,
      data: executions,
    };
  }

  /**
   * 获取执行记录列表（不关联批次）
   * GET /agent/test/executions
   */
  @Get('executions')
  @ApiOperation({ summary: '获取执行记录列表' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getExecutions(@Query('limit') limit?: number, @Query('offset') offset?: number) {
    const executions = await this.testService.getExecutions(limit || 50, offset || 0);
    return {
      success: true,
      data: executions,
    };
  }

  /**
   * 获取执行记录详情
   * GET /agent/test/executions/:id
   */
  @Get('executions/:id')
  @ApiOperation({ summary: '获取执行记录详情' })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async getExecution(@Param('id') id: string) {
    const execution = await this.testService.getExecution(id);
    if (!execution) {
      throw new HttpException('执行记录不存在', HttpStatus.NOT_FOUND);
    }
    return {
      success: true,
      data: execution,
    };
  }

  // ==================== 评审管理 ====================

  /**
   * 更新评审状态
   * PATCH /agent/test/executions/:id/review
   */
  @Patch('executions/:id/review')
  @ApiOperation({ summary: '更新评审状态' })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async updateReview(@Param('id') id: string, @Body() review: UpdateReviewRequestDto) {
    this.logger.log(`更新评审状态: ${id} -> ${review.reviewStatus}`);

    try {
      const execution = await this.testService.updateReview(id, review);
      return {
        success: true,
        data: execution,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`更新评审失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 批量更新评审状态
   * PATCH /agent/test/executions/batch-review
   */
  @Patch('executions/batch-review')
  @ApiOperation({ summary: '批量更新评审状态' })
  async batchUpdateReview(
    @Body() body: { executionIds: string[]; review: UpdateReviewRequestDto },
  ) {
    this.logger.log(`批量更新评审状态: ${body.executionIds.length} 条记录`);

    try {
      const count = await this.testService.batchUpdateReview(body.executionIds, body.review);
      return {
        success: true,
        data: { updatedCount: count },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`批量更新评审失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 回写测试结果到飞书
   * POST /agent/test/executions/:id/write-back
   */
  @Post('executions/:id/write-back')
  @ApiOperation({
    summary: '回写测试结果到飞书',
    description: '将测试执行结果回写到飞书测试/验证集表',
  })
  @ApiParam({ name: 'id', description: '执行记录ID' })
  async writeBackToFeishu(@Param('id') id: string, @Body() request: WriteBackFeishuRequestDto) {
    this.logger.log(`回写测试结果到飞书: executionId=${id}, status=${request.testStatus}`);

    try {
      // 确保 executionId 匹配
      if (request.executionId && request.executionId !== id) {
        throw new Error('执行记录ID不匹配');
      }

      const result = await this.testService.writeBackToFeishu(
        id,
        request.testStatus,
        request.errorReason,
      );

      return {
        success: result.success,
        data: result,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`回写飞书失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 批量回写测试结果到飞书
   * POST /agent/test/executions/batch-write-back
   */
  @Post('executions/batch-write-back')
  @ApiOperation({
    summary: '批量回写测试结果到飞书',
    description: '将多个测试执行结果批量回写到飞书测试/验证集表',
  })
  async batchWriteBackToFeishu(@Body() body: { items: WriteBackFeishuRequestDto[] }) {
    this.logger.log(`批量回写测试结果到飞书: ${body.items.length} 条记录`);

    try {
      const results = await this.testService.batchWriteBackToFeishu(body.items);

      return {
        success: true,
        data: {
          totalCount: body.items.length,
          successCount: results.success,
          failureCount: results.failed,
          errors: results.errors,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`批量回写飞书失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ==================== 队列管理 ====================

  /**
   * 获取测试队列状态
   * GET /agent/test/queue/status
   */
  @Get('queue/status')
  @ApiOperation({
    summary: '获取测试队列状态',
    description: '获取 Bull Queue 中任务的状态统计',
  })
  async getQueueStatus() {
    try {
      const status = await this.testProcessor.getQueueStatus();
      return {
        success: true,
        data: status,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取队列状态失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 清理失败的任务
   * POST /agent/test/queue/clean-failed
   */
  @Post('queue/clean-failed')
  @ApiOperation({
    summary: '清理失败的任务',
    description: '从队列中移除所有失败的任务',
  })
  async cleanFailedJobs() {
    this.logger.log('清理失败的任务');

    try {
      const removedCount = await this.testProcessor.cleanFailedJobs();
      return {
        success: true,
        data: {
          removedCount,
          message: `已清理 ${removedCount} 个失败任务`,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`清理失败任务失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ==================== 反馈管理 ====================

  /**
   * 提交测试反馈（踩/赞）
   * POST /agent/test/feedback
   */
  @Post('feedback')
  @ApiOperation({
    summary: '提交测试反馈',
    description: '将测试结果标记为 badcase 或 goodcase，写入飞书多维表格',
  })
  async submitFeedback(@Body() request: SubmitFeedbackRequestDto) {
    this.logger.log(`[Feedback] 提交 ${request.type} 反馈`);

    try {
      const feedback: AgentTestFeedback = {
        type: request.type,
        chatHistory: request.chatHistory,
        userMessage: request.userMessage,
        errorType: request.errorType,
        remark: request.remark,
        chatId: request.chatId,
      };

      const result = await this.feishuBitableService.writeAgentTestFeedback(feedback);

      if (result.success) {
        return {
          success: true,
          data: {
            recordId: result.recordId,
            type: request.type,
          },
        };
      } else {
        throw new Error(result.error || '写入飞书表格失败');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Feedback] 提交失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ==================== 回归验证 (Conversation Verification) ====================

  /**
   * 从飞书同步回归验证记录
   * POST /test-suite/conversations/sync
   */
  @Post('conversations/sync')
  @ApiOperation({
    summary: '从飞书同步回归验证记录',
    description: '从飞书多维表格导入回归验证测试数据，创建测试批次和对话源记录',
  })
  async syncConversationTests(@Body() _request: SyncConversationTestsDto) {
    this.logger.log('[ConversationSync] 开始同步回归验证记录');

    try {
      // TODO: 实现从飞书同步回归验证记录的逻辑
      // 1. 调用 FeishuTestSyncService.getConversationTestsFromDefaultTable()
      // 2. 创建测试批次（类型为 CONVERSATION）
      // 3. 批量创建 ConversationSource 记录
      // 4. 返回批次信息和导入统计

      throw new HttpException(
        {
          success: false,
          error: '回归验证同步功能即将上线',
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ConversationSync] 同步失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取对话源列表
   * GET /test-suite/conversations?batchId=xxx&page=1&pageSize=20
   */
  @Get('conversations')
  @ApiOperation({
    summary: '获取对话源列表',
    description: '获取指定批次的回归验证记录列表（分页）',
  })
  @ApiQuery({ name: 'batchId', required: true, description: '批次ID' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页数量', example: 20 })
  async getConversationSources(@Query() query: GetConversationSourcesDto) {
    const { batchId, page = 1, pageSize = 20, status } = query;
    this.logger.log(`[ConversationList] 获取对话列表: batchId=${batchId}, page=${page}`);

    try {
      const result = await this.conversationSourceRepository.findByBatchIdPaginated(
        batchId,
        page,
        pageSize,
        status ? { status } : undefined,
      );

      return {
        success: true,
        data: {
          sources: result.data.map((source) => ({
            id: source.id,
            batchId: source.batch_id,
            feishuRecordId: source.feishu_record_id,
            conversationId: source.conversation_id,
            participantName: source.participant_name,
            totalTurns: source.total_turns,
            avgSimilarityScore: source.avg_similarity_score,
            minSimilarityScore: source.min_similarity_score,
            status: source.status,
            createdAt: source.created_at,
            updatedAt: source.updated_at,
          })),
          total: result.total,
          page,
          pageSize,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ConversationList] 获取失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取对话的轮次列表
   * GET /test-suite/conversations/:sourceId/turns
   */
  @Get('conversations/:sourceId/turns')
  @ApiOperation({
    summary: '获取对话轮次列表',
    description: '获取指定对话的所有轮次执行记录',
  })
  @ApiParam({ name: 'sourceId', description: '对话源ID' })
  async getConversationTurns(@Param('sourceId') sourceId: string) {
    this.logger.log(`[ConversationTurns] 获取对话轮次: sourceId=${sourceId}`);

    try {
      const result = await this.conversationTestService.getConversationTurns(sourceId);

      return {
        success: true,
        data: result,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ConversationTurns] 获取失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 执行单个对话的回归验证
   * POST /test-suite/conversations/:sourceId/execute
   */
  @Post('conversations/:sourceId/execute')
  @ApiOperation({
    summary: '执行单个回归验证',
    description: '执行指定对话的所有轮次测试，计算相似度分数',
  })
  @ApiParam({ name: 'sourceId', description: '对话源ID' })
  async executeConversation(
    @Param('sourceId') sourceId: string,
    @Body() request: ExecuteConversationDto,
  ) {
    this.logger.log(`[ConversationExecute] 执行回归验证: sourceId=${sourceId}`);

    try {
      const result = await this.conversationTestService.executeConversation(
        sourceId,
        request.forceRerun,
      );

      // 执行完成后,更新批次统计
      const source = await this.conversationSourceRepository.findById(sourceId);
      if (source?.batch_id) {
        await this.testBatchService.updateBatchStats(source.batch_id);
        this.logger.log(`[ConversationExecute] 已更新批次统计: batchId=${source.batch_id}`);
      }

      return {
        success: true,
        data: result,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ConversationExecute] 回归验证执行失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 批量执行回归验证
   * POST /test-suite/conversations/batch/:batchId/execute
   */
  @Post('conversations/batch/:batchId/execute')
  @ApiOperation({
    summary: '批量执行回归验证',
    description: '执行指定批次的所有回归验证测试',
  })
  @ApiParam({ name: 'batchId', description: '批次ID' })
  async executeConversationBatch(
    @Param('batchId') batchId: string,
    @Body() request: ExecuteConversationBatchDto,
  ) {
    this.logger.log(`[ConversationBatchExecute] 执行批量回归验证: batchId=${batchId}`);

    try {
      // 获取该批次的所有对话源
      const sources = await this.conversationSourceRepository.findByBatchId(batchId);

      if (sources.length === 0) {
        throw new Error(`批次 ${batchId} 下没有回归验证记录`);
      }

      const results = [];
      let successCount = 0;
      let failedCount = 0;

      // 逐个执行回归验证
      for (const source of sources) {
        try {
          const result = await this.conversationTestService.executeConversation(
            source.id,
            request.forceRerun,
          );
          results.push(result);
          successCount++;
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(`对话 ${source.id} 执行失败: ${errorMessage}`);
          failedCount++;
        }
      }

      // 批量执行完成后,更新批次统计
      await this.testBatchService.updateBatchStats(batchId);
      this.logger.log(`[ConversationBatchExecute] 已更新批次统计: batchId=${batchId}`);

      return {
        success: true,
        data: {
          batchId,
          total: sources.length,
          successCount,
          failedCount,
          results,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ConversationBatchExecute] 回归验证批量执行失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 更新轮次评审状态
   * PATCH /test-suite/conversations/turns/:executionId/review
   */
  @Patch('conversations/turns/:executionId/review')
  @ApiOperation({
    summary: '更新轮次评审状态',
    description: '更新对话轮次的人工评审结果',
  })
  @ApiParam({ name: 'executionId', description: '执行记录ID' })
  async updateTurnReview(
    @Param('executionId') executionId: string,
    @Body() request: UpdateTurnReviewDto,
  ) {
    this.logger.log(`[TurnReview] 更新评审: executionId=${executionId}`);

    try {
      await this.executionRepository.updateExecution(executionId, {
        review_status: request.reviewStatus,
        review_comment: request.reviewComment,
      });

      return {
        success: true,
        data: {
          executionId,
          reviewStatus: request.reviewStatus,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TurnReview] 更新失败: ${errorMessage}`);
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
