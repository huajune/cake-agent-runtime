import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentFacadeService,
  AgentResultStatus,
  type ScenarioOptions,
  type AgentResult,
} from '@agent';
import { TestChatRequestDto, TestChatResponse } from '../dto/test-chat.dto';
import { TestExecutionRepository } from '../repositories';
import { TestExecution } from '../entities';
import { ExecutionStatus } from '../enums';

/** 默认场景 */
const DEFAULT_SCENARIO = 'candidate-consultation';

/** 测试场景默认开启 extended thinking */
const DEFAULT_TEST_THINKING = { type: 'enabled' as const, budgetTokens: 10000 };

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
    private readonly agentFacade: AgentFacadeService,
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
    const sessionId = request.sessionId || `test-${Date.now()}`;

    if (!request.userId) {
      throw new Error('userId 是必填项，请在请求中传入 userId');
    }

    this.logger.log(`执行测试: ${request.caseName || request.message.substring(0, 50)}...`);

    let result: AgentResult;
    let executionStatus: ExecutionStatus = ExecutionStatus.SUCCESS;
    let errorMessage: string | null = null;

    try {
      // 测试/验证集的 history 包含完整聊天记录（包括最新的 user + assistant）
      // 重新测试时需要去掉最后两条，用当前 message 重新获取 AI 回答
      const historyForAgent = (request.history || []).slice(0, -2);

      const options: ScenarioOptions = {
        messages: historyForAgent,
        userId: request.userId,
        thinking: request.thinking || DEFAULT_TEST_THINKING,
      };

      result = await this.agentFacade.chatWithScenario(
        scenario,
        sessionId,
        request.message,
        options,
      );

      if (result.status === AgentResultStatus.ERROR) {
        executionStatus = ExecutionStatus.FAILURE;
        errorMessage = result.error?.message || '未知错误';
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionStatus = errorMsg.includes('timeout')
        ? ExecutionStatus.TIMEOUT
        : ExecutionStatus.FAILURE;
      errorMessage = errorMsg;
      result = {
        status: AgentResultStatus.ERROR,
        error: { code: 'TEST_EXECUTION_ERROR', message: errorMsg },
      };
    }

    const durationMs = Date.now() - startTime;

    // 提取结果
    const extracted = this.extractResult(result);

    // 构建响应
    const response: TestChatResponse = {
      actualOutput: extracted.actualOutput,
      status: executionStatus,
      request: {
        url: `${this.configService.get('AGENT_API_BASE_URL')}/chat`,
        method: 'POST',
        body: (result as AgentResult & { requestBody?: unknown }).requestBody || null,
      },
      response: {
        statusCode: executionStatus === ExecutionStatus.SUCCESS ? 200 : 500,
        body: result.data || result.fallback || result.error,
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
    const sessionId = request.sessionId || `test-stream-${Date.now()}`;

    if (!request.userId) {
      throw new Error('userId 是必填项，请在请求中传入 userId');
    }

    this.logger.log(
      `[Stream] 执行流式测试: ${request.caseName || request.message.substring(0, 50)}...`,
    );

    // 测试/验证集的 history 包含完整聊天记录（包括最新的 user + assistant）
    // 重新测试时需要去掉最后两条，用当前 message 重新获取 AI 回答
    // ai-stream 等场景已在 Controller 层预处理好历史，无需再截断
    const historyForAgent = request.skipHistoryTrim
      ? request.history || []
      : (request.history || []).slice(0, -2);

    const options: ScenarioOptions = {
      messages: historyForAgent,
      userId: request.userId,
      thinking: request.thinking || DEFAULT_TEST_THINKING,
    };

    const result = await this.agentFacade.chatStreamWithScenario(
      scenario,
      sessionId,
      request.message,
      options,
    );

    this.logger.debug(`[Stream] 估算 input tokens: ${result.estimatedInputTokens}`);

    return {
      stream: result.stream,
      estimatedInputTokens: result.estimatedInputTokens,
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
  private extractResult(result: AgentResult): ExtractedResult {
    return {
      actualOutput: this.extractResponseText(result),
      toolCalls: this.extractToolCalls(result),
      tokenUsage: result.data?.usage || {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  }

  /**
   * 提取响应文本
   */
  private extractResponseText(result: AgentResult): string {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return '';

      return response.messages
        .map((msg) => {
          if (msg.parts) {
            return msg.parts.map((p) => p.text || '').join('');
          }
          return '';
        })
        .join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * 提取工具调用
   */
  private extractToolCalls(result: AgentResult): ToolCallInfo[] {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return [];

      const toolCalls: ToolCallInfo[] = [];
      for (const msg of response.messages) {
        if (msg.parts) {
          for (const part of msg.parts) {
            const partAny = part as unknown as Record<string, unknown>;
            if (partAny.type === 'tool_call' || partAny.toolName) {
              toolCalls.push({
                toolName: partAny.toolName as string,
                input: partAny.input,
                output: partAny.output,
              });
            }
          }
        }
      }
      return toolCalls;
    } catch {
      return [];
    }
  }
}
