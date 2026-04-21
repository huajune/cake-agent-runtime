import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { createHash } from 'node:crypto';
import {
  AgentRunnerService,
  type AgentInputMessage,
  type AgentRunResult,
  type AgentStreamResult,
} from '@agent/runner.service';
import { CallerKind } from '@enums/agent.enum';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ChatMessageInput } from '@biz/message/types/message.types';
import {
  EnterpriseMessageCallbackDto,
  MessageSource,
  MessageType,
  ContactType,
} from '@wecom/message/ingress/message-callback.dto';
import { MessageParser } from '@wecom/message/utils/message-parser.util';
import { TestChatRequestDto, TestChatResponse, VercelAIChatRequestDto } from '../dto/test-chat.dto';
import { TestExecutionRepository } from '../repositories/test-execution.repository';
import { TestExecution } from '../entities/test-execution.entity';
import { ExecutionStatus, MessageRole } from '../enums/test.enum';

/** 默认场景 */
const DEFAULT_SCENARIO = 'candidate-consultation';
const TEST_CORP_ID = 'test';
const TEST_BOT_ID = 'agent-test-bot';

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
    private readonly runner: AgentRunnerService,
    private readonly executionRepository: TestExecutionRepository,
    private readonly chatSessionService: ChatSessionService,
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
    const historyForAgent = this.resolveHistoryForAgent(request);
    const strategySource = this.resolveStrategySource(request);

    try {
      await this.prepareMonitoringContext({
        request,
        sessionId,
        historyForAgent,
      });

      const messages = this.buildRunnerMessages(
        historyForAgent,
        request.message,
        request.imageUrls,
      );

      agentResult = await this.runner.invoke({
        callerKind: CallerKind.TEST_SUITE,
        messages,
        userId: request.userId,
        corpId: TEST_CORP_ID,
        sessionId,
        scenario,
        botUserId: request.botUserId,
        botImId: request.botImId,
        strategySource,
        modelId: request.modelId,
        disableFallbacks: true,
      });
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
        body: {
          scenario,
          message: request.message ?? '',
          imageUrls: request.imageUrls,
          userId: request.userId,
          botUserId: request.botUserId,
          botImId: request.botImId,
          strategySource,
        },
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
    const historyForAgent = this.resolveHistoryForAgent(request);
    const strategySource = this.resolveStrategySource(request);
    await this.prepareMonitoringContext({
      request,
      sessionId,
      historyForAgent,
    });

    const messages = this.buildRunnerMessages(historyForAgent, request.message, request.imageUrls);
    const runnerParams = {
      callerKind: CallerKind.TEST_SUITE,
      messages,
      userId: request.userId,
      corpId: TEST_CORP_ID,
      sessionId,
      scenario,
      thinking: request.thinking,
      strategySource,
      botUserId: request.botUserId,
      botImId: request.botImId,
      modelId: request.modelId,
      disableFallbacks: true,
    };

    const runnerResult = await this.runner.stream(runnerParams);

    return {
      ...runnerResult,
      agentRequest: {
        callerKind: CallerKind.TEST_SUITE,
        messages,
        userId: request.userId,
        corpId: TEST_CORP_ID,
        sessionId,
        scenario,
        thinking: request.thinking,
        strategySource,
        botUserId: request.botUserId,
        botImId: request.botImId,
        modelId: request.modelId,
      },
    };
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
    const transportMessages = Array.isArray(request.messages) ? request.messages : [];
    const userMessages = transportMessages.filter((m) => m.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1];
    const latestPayload = this.extractMessagePayload(latestUserMessage);
    const currentImageUrls =
      latestPayload.imageUrls.length > 0 ? latestPayload.imageUrls : request.imageUrls;
    const messageText = latestPayload.text || (currentImageUrls?.length ? '[图片消息]' : '');

    const history = transportMessages.slice(0, -1).map((msg) => {
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
      skipHistoryTrim: true,
      sessionId: request.sessionId,
      userId: request.userId,
      botUserId: request.botUserId,
      botImId: request.botImId,
      thinking: request.thinking,
      imageUrls: currentImageUrls,
      modelId: request.modelId,
    };

    if (!this.hasInputContent(testRequest.message, testRequest.imageUrls)) {
      throw new Error('缺少可用于测试的用户输入，请填写当前用户消息或上传图片后再试');
    }

    return { testRequest, messageText };
  }

  private resolveStrategySource(
    request: Pick<TestChatRequestDto, 'botUserId' | 'botImId'>,
  ): 'testing' | 'released' {
    // agent-test 默认 testing；只要录入了拉群所需 bot 标识，就自动切到 released 联调链路
    if (request.botUserId?.trim() && request.botImId?.trim()) {
      return 'released';
    }
    return 'testing';
  }

  // ========== 私有方法 ==========

  private resolveHistoryForAgent(
    request: Pick<TestChatRequestDto, 'history' | 'skipHistoryTrim'>,
  ): Array<{ role: MessageRole; content: string; imageUrls?: string[] }> {
    return request.skipHistoryTrim ? request.history || [] : (request.history || []).slice(0, -2);
  }

  private async prepareMonitoringContext(params: {
    request: TestChatRequestDto;
    sessionId: string;
    historyForAgent: Array<{ role: MessageRole; content: string; imageUrls?: string[] }>;
  }): Promise<void> {
    const { request, sessionId, historyForAgent } = params;

    await this.syncHistoryToProductionChat(request, sessionId, historyForAgent);

    const syntheticMessage = this.buildSyntheticInboundMessage(request, sessionId);
    await this.chatSessionService.saveMessage(
      this.toCurrentUserChatMessage(request, sessionId, syntheticMessage),
    );
  }

  private async syncHistoryToProductionChat(
    request: TestChatRequestDto,
    sessionId: string,
    history: Array<{ role: MessageRole; content: string; imageUrls?: string[] }>,
  ): Promise<void> {
    if (history.length === 0) {
      return;
    }

    const baseTimestamp = Date.now() - (history.length + 1) * 1000;
    const messages: ChatMessageInput[] = history.map((message, index) =>
      this.toChatHistoryMessage({
        request,
        sessionId,
        historyIndex: index,
        message,
        timestamp: baseTimestamp + index * 1000,
      }),
    );

    await this.chatSessionService.saveMessagesBatch(messages);
  }

  private toChatHistoryMessage(params: {
    request: TestChatRequestDto;
    sessionId: string;
    historyIndex: number;
    message: { role: MessageRole; content: string; imageUrls?: string[] };
    timestamp: number;
  }): ChatMessageInput {
    const { request, sessionId, historyIndex, message, timestamp } = params;
    const trimmedContent = message.content.trim();
    const hasImages = (message.imageUrls?.length ?? 0) > 0;
    const role = message.role === MessageRole.ASSISTANT ? 'assistant' : 'user';
    const messageType = hasImages && !trimmedContent ? MessageType.IMAGE : MessageType.TEXT;
    const source = role === 'assistant' ? MessageSource.AI_REPLY : MessageSource.MOBILE_PUSH;

    return {
      chatId: sessionId,
      messageId: this.buildHistoryMessageId(sessionId, historyIndex, message),
      role,
      content:
        trimmedContent ||
        (hasImages
          ? role === 'assistant'
            ? '[图片消息] 招募经理发送了一张图片'
            : '[图片消息] 候选人发送了一张图片'
          : ''),
      timestamp,
      candidateName: request.userId,
      managerName: request.botUserId,
      orgId: TEST_CORP_ID,
      botId: TEST_BOT_ID,
      messageType,
      source,
      isRoom: false,
      imBotId: request.botImId,
      imContactId: request.userId,
      contactType: ContactType.PERSONAL_WECHAT,
      isSelf: role === 'assistant',
      payload:
        messageType === MessageType.IMAGE
          ? { imageUrl: message.imageUrls?.[0] }
          : { text: trimmedContent, pureText: trimmedContent },
      externalUserId: request.userId,
    };
  }

  private buildSyntheticInboundMessage(
    request: TestChatRequestDto,
    sessionId: string,
  ): EnterpriseMessageCallbackDto {
    const trimmedMessage = request.message?.trim();
    const imageUrl = request.imageUrls?.[0];
    const messageType = trimmedMessage || !imageUrl ? MessageType.TEXT : MessageType.IMAGE;
    const payload =
      messageType === MessageType.IMAGE
        ? { imageUrl }
        : { text: trimmedMessage || '', pureText: trimmedMessage || '' };

    return {
      orgId: TEST_CORP_ID,
      token: 'test-suite',
      botId: TEST_BOT_ID,
      botUserId: request.botUserId,
      imBotId: request.botImId || TEST_BOT_ID,
      chatId: sessionId,
      imContactId: request.userId!,
      messageType,
      messageId: this.buildLiveMessageId(sessionId),
      timestamp: Date.now().toString(),
      isSelf: false,
      source: MessageSource.MOBILE_PUSH,
      contactType: ContactType.PERSONAL_WECHAT,
      payload,
      contactName: request.userId,
      externalUserId: request.userId,
      _apiType: 'enterprise',
      _receivedAtMs: Date.now(),
    };
  }

  private buildHistoryMessageId(
    sessionId: string,
    historyIndex: number,
    message: { role: MessageRole; content: string; imageUrls?: string[] },
  ): string {
    const hash = createHash('sha1')
      .update(
        JSON.stringify({
          role: message.role,
          content: message.content,
          imageUrls: message.imageUrls || [],
        }),
      )
      .digest('hex')
      .slice(0, 12);

    return `agent-test-history:${sessionId}:${historyIndex}:${hash}`;
  }

  private buildLiveMessageId(sessionId: string): string {
    return `agent-test-live:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  private toCurrentUserChatMessage(
    request: TestChatRequestDto,
    sessionId: string,
    messageData: EnterpriseMessageCallbackDto,
  ): ChatMessageInput {
    return {
      chatId: sessionId,
      messageId: messageData.messageId,
      role: 'user',
      content: MessageParser.extractContent(messageData),
      timestamp: Number(messageData.timestamp),
      candidateName: request.userId,
      managerName: request.botUserId,
      orgId: TEST_CORP_ID,
      botId: TEST_BOT_ID,
      messageType: messageData.messageType,
      source: messageData.source,
      isRoom: false,
      imBotId: messageData.imBotId,
      imContactId: request.userId,
      contactType: ContactType.PERSONAL_WECHAT,
      isSelf: false,
      payload: messageData.payload as Record<string, unknown>,
      externalUserId: request.userId,
    };
  }

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
}
