import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoopService, type AgentRunResult } from '@agent/loop.service';
import { ContextService } from '@agent/context/context.service';
import { TestChatRequestDto, TestChatResponse } from '../../dto/test-chat.dto';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { TestExecution } from '../../entities/test-execution.entity';
import { ExecutionStatus } from '../../enums/test.enum';

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
 */
@Injectable()
export class TestExecutionService {
  private readonly logger = new Logger(TestExecutionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly loop: LoopService,
    private readonly context: ContextService,
    private readonly executionRepository: TestExecutionRepository,
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

    this.logger.log(`执行测试: ${request.caseName || request.message.substring(0, 50)}...`);

    let agentResult: AgentRunResult | null = null;
    let executionStatus: ExecutionStatus = ExecutionStatus.SUCCESS;
    let errorMessage: string | null = null;

    try {
      // 测试/验证集的 history 包含完整聊天记录（包括最新的 user + assistant）
      // 重新测试时需要去掉最后两条，用当前 message 重新获取 AI 回答
      const historyForAgent = (request.history || []).slice(0, -2);

      const messages = [
        ...historyForAgent.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: request.message },
      ];

      agentResult = await this.loop.invoke({
        messages,
        userId: request.userId,
        corpId: 'test',
        sessionId: request.sessionId ?? `test-${Date.now()}`,
        scenario,
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionStatus = errorMsg.includes('timeout')
        ? ExecutionStatus.TIMEOUT
        : ExecutionStatus.FAILURE;
      errorMessage = errorMsg;
    }

    const durationMs = Date.now() - startTime;

    // 提取结果
    const extracted = this.extractResult(agentResult);

    // 构建响应
    const response: TestChatResponse = {
      actualOutput: extracted.actualOutput,
      status: executionStatus,
      request: {
        url: 'orchestrator/run',
        method: 'POST',
        body: { scenario, message: request.message },
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

    // 保存执行记录
    if (request.saveExecution !== false) {
      const execution = await this.saveExecution({
        batchId: request.batchId,
        caseId: request.caseId,
        caseName: request.caseName,
        category: request.category,
        testInput: {
          message: request.message,
          history: request.history,
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
   * 执行流式测试
   */
  async executeTestStream(request: TestChatRequestDto): Promise<NodeJS.ReadableStream> {
    const result = await this.executeTestStreamWithMeta(request);
    return result.stream;
  }

  /**
   * 执行流式测试（带元数据）
   */
  async executeTestStreamWithMeta(
    request: TestChatRequestDto,
  ): Promise<{ stream: NodeJS.ReadableStream; estimatedInputTokens: number }> {
    const scenario = request.scenario || DEFAULT_SCENARIO;

    if (!request.userId) {
      throw new Error('userId 是必填项，请在请求中传入 userId');
    }

    this.logger.log(
      `[Stream] 执行流式测试: ${request.caseName || request.message.substring(0, 50)}...`,
    );

    // 测试/验证集的 history 包含完整聊天记录（包括最新的 user + assistant）
    // 重新测试时需要去掉最后两条，用当前 message 重新获取 AI 回答
    const historyForAgent = request.skipHistoryTrim
      ? request.history || []
      : (request.history || []).slice(0, -2);

    const messages = [
      ...historyForAgent.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: request.message },
    ];

    const { systemPrompt } = await this.context.compose({ scenario });
    const streamResult = await this.loop.stream({
      systemPrompt,
      messages,
      userId: request.userId,
      corpId: 'test',
      sessionId: request.sessionId ?? `test-${Date.now()}`,
    });

    return {
      stream: streamResult.textStream as unknown as NodeJS.ReadableStream,
      estimatedInputTokens: 0,
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
   * 供 Processor 在任务完成后调用
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

  // ========== 私有方法 ==========

  /**
   * 提取 Agent 响应结果
   */
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
      toolCalls: [],
      tokenUsage: result.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}
