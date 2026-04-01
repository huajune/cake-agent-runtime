import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import {
  AgentRunnerService,
  type AgentInputMessage,
  type AgentRunResult,
  type AgentStreamResult,
} from '@agent/runner.service';
import { BookingDetectionService } from '@biz/message/services/booking-detection.service';
import { TestChatRequestDto, TestChatResponse, VercelAIChatRequestDto } from '../dto/test-chat.dto';
import { TestExecutionRepository } from '../repositories/test-execution.repository';
import { TestExecution } from '../entities/test-execution.entity';
import { ExecutionStatus, MessageRole } from '../enums/test.enum';

/** 默认场景 */
const DEFAULT_SCENARIO = 'candidate-consultation';

/**
 * 测试执行结果提取接口
 */
interface ExtractedResult {
  actualOutput: string;
  toolCalls: ToolCallInfo[];
  tokenUsage: TokenUsage;
}

interface ToolCallInfo {
  toolName: string;
  input: unknown;
  output: unknown;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 测试执行服务
 *
 * 职责：
 * - 执行单条测试（流式/非流式）
 * - 提取和解析 Agent 响应
 * - 保存执行记录
 * - 转换 Vercel AI SDK 请求格式
 */
@Injectable()
export class TestExecutionService {
  private readonly logger = new Logger(TestExecutionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly runner: AgentRunnerService,
    private readonly executionRepository: TestExecutionRepository,
    private readonly bookingDetection: BookingDetectionService,
  ) {
    this.logger.log('TestExecutionService 初始化完成');
  }

  /**
   * 执行单条测试
   */
  async executeTest(request: TestChatRequestDto): Promise<TestChatResponse> {
    const startTime = Date.now();
    const scenario = request.scenario || DEFAULT_SCENARIO;

    if (!request.userId) {
      throw new Error('userId 是必填项，请在请求中传入 userId');
    }

    if (!this.hasInputContent(request.message, request.imageUrls)) {
      throw new Error('message 或 imageUrls 至少需要提供一个');
    }

    this.logger.log(
      `执行测试: ${request.caseName || this.buildInputPreview(request.message, request.imageUrls)}...`,
    );

    let agentResult: AgentRunResult | null = null;
    let executionStatus: ExecutionStatus = ExecutionStatus.SUCCESS;
    let errorMessage: string | null = null;
    const sessionId = request.sessionId ?? `test-${Date.now()}`;

    try {
      const historyForAgent = request.skipHistoryTrim
        ? request.history || []
        : (request.history || []).slice(0, -2);

      const messages = this.buildRunnerMessages(
        historyForAgent,
        request.message,
        request.imageUrls,
      );

      agentResult = await this.runner.invoke({
        messages,
        userId: request.userId,
        corpId: 'test',
        sessionId,
        scenario,
        strategySource: 'testing',
      });

      if (request.notifyBooking) {
        await this.notifyBookingIfNeeded({
          sessionId,
          userId: request.userId,
          toolCalls: agentResult.toolCalls,
        });
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionStatus = errorMsg.includes('timeout')
        ? ExecutionStatus.TIMEOUT
        : ExecutionStatus.FAILURE;
      errorMessage = errorMsg;
    }

    const durationMs = Date.now() - startTime;

    const extracted = this.extractResult(agentResult);

    const response: TestChatResponse = {
      actualOutput: extracted.actualOutput,
      status: executionStatus,
      request: {
        url: 'orchestrator/run',
        method: 'POST',
        body: { scenario, message: request.message, imageUrls: request.imageUrls },
      },
      response: {
        statusCode: executionStatus === ExecutionStatus.SUCCESS ? 200 : 500,
        body: agentResult || { error: errorMessage },
        toolCalls: extracted.toolCalls,
      },
      metrics: {
        durationMs,
        tokenUsage: extracted.tokenUsage,
      },
    };

    if (request.saveExecution !== false) {
      const execution = await this.saveExecution({
        batchId: request.batchId,
        caseId: request.caseId,
        caseName: request.caseName,
        category: request.category,
        testInput: {
          message: request.message,
          history: request.history,
          imageUrls: request.imageUrls,
          scenario,
        },
        expectedOutput: request.expectedOutput,
        agentRequest: response.request.body,
        agentResponse: response.response.body,
        actualOutput: extracted.actualOutput,
        toolCalls: extracted.toolCalls,
        executionStatus,
        durationMs,
        tokenUsage: extracted.tokenUsage,
        errorMessage,
      });

      response.executionId = execution.id;
    }

    return response;
  }

  /**
   * 执行流式测试（旧 SSE 格式）
   */
  async executeTestStream(request: TestChatRequestDto): Promise<NodeJS.ReadableStream> {
    const { streamResult } = await this.executeTestStreamWithMeta(request);
    return Readable.fromWeb(streamResult.textStream as Parameters<typeof Readable.fromWeb>[0]);
  }

  /**
   * 执行流式测试（返回 Vercel AI SDK StreamTextResult + 元数据）
   */
  async executeTestStreamWithMeta(request: TestChatRequestDto): Promise<AgentStreamResult> {
    const scenario = request.scenario || DEFAULT_SCENARIO;

    if (!request.userId) {
      throw new Error('userId 是必填项，请在请求中传入 userId');
    }

    if (!this.hasInputContent(request.message, request.imageUrls)) {
      throw new Error('message 或 imageUrls 至少需要提供一个');
    }

    this.logger.log(
      `[Stream] 执行流式测试: ${request.caseName || this.buildInputPreview(request.message, request.imageUrls)}...`,
    );

    const sessionId = request.sessionId ?? `test-${Date.now()}`;
    const historyForAgent = request.skipHistoryTrim
      ? request.history || []
      : (request.history || []).slice(0, -2);

    const messages = this.buildRunnerMessages(historyForAgent, request.message, request.imageUrls);

    return this.runner.stream({
      messages,
      userId: request.userId,
      corpId: 'test',
      sessionId,
      scenario,
      thinking: request.thinking,
      strategySource: 'testing',
      onFinish: request.notifyBooking
        ? async (result) => {
            await this.notifyBookingIfNeeded({
              sessionId,
              userId: request.userId,
              toolCalls: result.toolCalls,
            });
          }
        : undefined,
    });
  }

  /**
   * 获取执行记录详情
   */
  async getExecution(executionId: string): Promise<TestExecution | null> {
    return this.executionRepository.findById(executionId);
  }

  /**
   * 获取执行记录列表（不关联批次）
   */
  async getExecutions(limit = 50, offset = 0): Promise<TestExecution[]> {
    return this.executionRepository.findMany(limit, offset);
  }

  /**
   * 根据 batchId 和 caseId 更新执行记录
   */
  async updateExecutionByBatchAndCase(
    batchId: string,
    caseId: string,
    data: {
      agentRequest?: unknown;
      agentResponse?: unknown;
      actualOutput?: string;
      toolCalls?: unknown[];
      executionStatus: ExecutionStatus;
      durationMs: number;
      tokenUsage?: unknown;
      errorMessage?: string;
    },
  ): Promise<void> {
    try {
      await this.executionRepository.updateByBatchAndCase(batchId, caseId, data);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`更新执行记录失败: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * 保存执行记录
   */
  async saveExecution(data: {
    batchId?: string;
    caseId?: string;
    caseName?: string;
    category?: string;
    testInput: unknown;
    expectedOutput?: string;
    agentRequest: unknown;
    agentResponse: unknown;
    actualOutput: string;
    toolCalls: unknown[];
    executionStatus: ExecutionStatus;
    durationMs: number;
    tokenUsage: unknown;
    errorMessage: string | null;
  }): Promise<TestExecution> {
    return this.executionRepository.create(data);
  }

  /**
   * 统计批次中已完成的执行记录数量
   */
  async countCompletedExecutions(batchId: string): Promise<{
    total: number;
    success: number;
    failure: number;
    timeout: number;
  }> {
    return this.executionRepository.countCompletedByBatchId(batchId);
  }

  /**
   * 转换 Vercel AI SDK 格式为测试请求
   */
  convertVercelAIToTestRequest(request: VercelAIChatRequestDto): {
    testRequest: TestChatRequestDto;
    messageText: string;
  } {
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1];
    const latestPayload = this.extractMessagePayload(latestUserMessage);
    const currentImageUrls =
      latestPayload.imageUrls.length > 0 ? latestPayload.imageUrls : request.imageUrls;
    const messageText = latestPayload.text || (currentImageUrls?.length ? '[图片消息]' : '');

    const history = request.messages.slice(0, -1).map((msg) => {
      const payload = this.extractMessagePayload(msg);
      return {
        role: msg.role as MessageRole,
        content: payload.text || (payload.imageUrls.length > 0 ? '[图片消息]' : ''),
        imageUrls: payload.imageUrls.length > 0 ? payload.imageUrls : undefined,
      };
    });

    const testRequest: TestChatRequestDto = {
      message: latestPayload.text,
      history,
      scenario: request.scenario || 'candidate-consultation',
      saveExecution: request.saveExecution ?? false,
      notifyBooking: request.notifyBooking ?? true,
      skipHistoryTrim: true,
      sessionId: request.sessionId,
      userId: request.userId,
      thinking: request.thinking,
      imageUrls: currentImageUrls,
    };

    return { testRequest, messageText };
  }

  // ========== 私有方法 ==========

  private buildRunnerMessages(
    history: Array<{ role: MessageRole; content: string; imageUrls?: string[] }>,
    message?: string,
    imageUrls?: string[],
  ): AgentInputMessage[] {
    return [
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        imageUrls: m.imageUrls,
      })),
      {
        role: 'user',
        content: message || '',
        imageUrls,
      },
    ];
  }

  private extractMessagePayload(message?: {
    parts?: Array<{
      type: string;
      text?: string;
      url?: string;
      mediaType?: string;
    }>;
  }): {
    text: string;
    imageUrls: string[];
  } {
    const parts = message?.parts || [];
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    const imageUrls = parts
      .filter(
        (part) =>
          part.type === 'file' &&
          typeof part.url === 'string' &&
          (part.mediaType?.startsWith('image/') || part.url.startsWith('data:image/')),
      )
      .map((part) => part.url as string);
    return { text, imageUrls };
  }

  private hasInputContent(message?: string, imageUrls?: string[]): boolean {
    return Boolean(message?.trim()) || Boolean(imageUrls?.length);
  }

  private buildInputPreview(message?: string, imageUrls?: string[]): string {
    if (message?.trim()) return message.substring(0, 50);
    return `[图片消息${imageUrls?.length ? ` x${imageUrls.length}` : ''}]`;
  }

  private extractResult(result: AgentRunResult | null): ExtractedResult {
    if (!result) {
      return {
        actualOutput: '',
        toolCalls: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }

    return {
      actualOutput: result.text || '',
      toolCalls: (result.toolCalls || []).map((toolCall) => ({
        toolName: toolCall.toolName,
        input: toolCall.args,
        output: toolCall.result,
      })),
      tokenUsage: result.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  private async notifyBookingIfNeeded(params: {
    sessionId: string;
    userId: string;
    toolCalls?: AgentRunResult['toolCalls'];
  }): Promise<void> {
    await this.bookingDetection.handleBookingSuccessAsync({
      chatId: params.sessionId,
      contactName: params.userId,
      userId: params.userId,
      managerId: 'test-suite',
      managerName: 'Agent Test',
      toolCalls: params.toolCalls,
    });
  }
}
