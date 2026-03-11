import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentFacadeService,
  AgentResultStatus,
  type ScenarioOptions,
  type AgentResult,
} from '@agent';
import { MessageRole } from '@shared/enums';
import { LlmEvaluationService } from './llm-evaluation.service';
import {
  ConversationSourceRepository,
  TestExecutionRepository,
  type ConversationSourceRecord,
} from '@db/test-suite';
import {
  ExecutionStatus,
  ReviewStatus,
  ConversationSourceStatus,
  SimilarityRating,
} from '../enums';
import {
  ParsedMessage,
  ConversationTurn,
  ConversationParseResult,
  ConversationExecutionResult,
  ConversationTurnExecution,
  TurnListResponse,
} from '../dto/conversation-test.dto';

/** 默认场景 */
const DEFAULT_SCENARIO = 'candidate-consultation';

/** 测试场景默认开启 extended thinking */
const DEFAULT_TEST_THINKING = { type: 'enabled' as const, budgetTokens: 10000 };

/** 相似度阈值（及格线） */
const SIMILARITY_THRESHOLD = 60;

/**
 * 对话解析正则表达式
 * 匹配格式: [MM/DD HH:mm 角色] 消息内容
 * 例如: [12/04 17:20 候选人] 这还招人吗
 */
const CONVERSATION_LINE_PATTERN = /^\[(\d{2}\/\d{2}\s+\d{2}:\d{2})\s+(候选人|招募经理)\]\s*(.+)$/;

/**
 * 回归验证测试服务
 *
 * 职责：
 * - 解析原始对话记录
 * - 拆解对话为多个测试轮次
 * - 执行回归验证并计算相似度
 * - 汇总统计结果
 */
@Injectable()
export class ConversationTestService {
  private readonly logger = new Logger(ConversationTestService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly agentFacade: AgentFacadeService,
    private readonly llmEvaluationService: LlmEvaluationService,
    private readonly conversationSourceRepository: ConversationSourceRepository,
    private readonly executionRepository: TestExecutionRepository,
  ) {
    this.logger.log('ConversationTestService 初始化完成');
  }

  /**
   * 解析原始对话文本
   *
   * @param rawText 原始对话文本（带时间戳）
   * @returns 解析结果
   */
  parseConversation(rawText: string): ConversationParseResult {
    if (!rawText || !rawText.trim()) {
      return {
        success: false,
        messages: [],
        totalTurns: 0,
        error: '对话内容为空',
      };
    }

    try {
      const lines = rawText.split('\n').filter((line) => line.trim());
      const messages: ParsedMessage[] = [];
      let currentMessage: ParsedMessage | null = null;

      for (const line of lines) {
        const match = line.match(CONVERSATION_LINE_PATTERN);

        if (match) {
          // 如果有未保存的消息，先保存
          if (currentMessage) {
            messages.push(currentMessage);
          }

          const [, timestamp, role, content] = match;
          const mappedRole: 'user' | 'assistant' = role === '候选人' ? 'user' : 'assistant';

          currentMessage = {
            role: mappedRole,
            content: content.trim(),
            timestamp,
          };
        } else if (currentMessage && line.trim()) {
          // 连续行，追加到当前消息
          currentMessage.content += '\n' + line.trim();
        }
      }

      // 保存最后一条消息
      if (currentMessage) {
        messages.push(currentMessage);
      }

      // 合并连续的同角色消息
      const mergedMessages = this.mergeConsecutiveMessages(messages);

      // 计算轮数（候选人发言次数）
      const totalTurns = mergedMessages.filter((m) => m.role === 'user').length;

      return {
        success: true,
        messages: mergedMessages,
        totalTurns,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`对话解析失败: ${errorMsg}`);
      return {
        success: false,
        messages: [],
        totalTurns: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * 将对话拆解为多个测试轮次
   *
   * @param messages 解析后的消息列表
   * @returns 测试轮次数组
   */
  splitIntoTurns(messages: ParsedMessage[]): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    let turnNumber = 0;

    for (let i = 0; i < messages.length; i++) {
      const current = messages[i];

      // 只在用户消息时创建测试轮次
      if (current.role === 'user') {
        turnNumber++;

        // 查找该用户消息之后的助手回复
        const nextAssistant = messages[i + 1];
        const expectedOutput = nextAssistant?.role === 'assistant' ? nextAssistant.content : '';

        // 构建历史上下文（当前轮之前的所有消息）
        const history = messages.slice(0, i);

        turns.push({
          turnNumber,
          history,
          userMessage: current.content,
          expectedOutput,
        });
      }
    }

    return turns;
  }

  /**
   * 执行单个对话的所有轮次测试
   *
   * @param sourceId 对话源ID
   * @param forceRerun 是否强制重新执行
   * @returns 执行结果
   */
  async executeConversation(
    sourceId: string,
    forceRerun = false,
  ): Promise<ConversationExecutionResult> {
    const source = await this.conversationSourceRepository.findById(sourceId);
    if (!source) {
      throw new Error(`对话源不存在: ${sourceId}`);
    }

    // 更新状态为执行中
    await this.conversationSourceRepository.updateStatus(
      sourceId,
      ConversationSourceStatus.RUNNING,
    );

    try {
      // 拆解对话为测试轮次
      const turns = this.splitIntoTurns(source.full_conversation as ParsedMessage[]);

      const turnResults: Array<{
        turnNumber: number;
        similarityScore: number | null;
        rating: SimilarityRating | null;
        executionStatus: string;
      }> = [];

      // 逐轮执行测试
      for (const turn of turns) {
        const result = await this.executeTurn(source, turn, forceRerun);
        turnResults.push(result);
      }

      // 计算统计数据
      const validScores = turnResults
        .map((t) => t.similarityScore)
        .filter((s): s is number => s !== null);

      const avgScore =
        validScores.length > 0
          ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
          : null;

      const minScore = validScores.length > 0 ? Math.min(...validScores) : null;

      // 更新对话源状态和统计数据
      await this.conversationSourceRepository.updateSource(sourceId, {
        status: ConversationSourceStatus.COMPLETED,
        total_turns: turns.length,
        avg_similarity_score: avgScore,
        min_similarity_score: minScore,
      });

      return {
        sourceId,
        conversationId: source.conversation_id,
        totalTurns: turns.length,
        executedTurns: turnResults.length,
        avgSimilarityScore: avgScore,
        minSimilarityScore: minScore,
        turns: turnResults,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`对话执行失败: ${errorMsg}`);

      await this.conversationSourceRepository.updateStatus(
        sourceId,
        ConversationSourceStatus.FAILED,
      );

      throw error;
    }
  }

  /**
   * 执行单个轮次测试
   */
  private async executeTurn(
    source: ConversationSourceRecord,
    turn: ConversationTurn,
    forceRerun: boolean,
  ): Promise<{
    turnNumber: number;
    similarityScore: number | null;
    rating: SimilarityRating | null;
    executionStatus: string;
  }> {
    const startTime = Date.now();
    const scenario = DEFAULT_SCENARIO;
    const sessionId = source.conversation_id;

    this.logger.debug(
      `执行对话轮次: ${sessionId} 第 ${turn.turnNumber} 轮 (sourceId: ${source.id})`,
    );

    // 检查是否已有执行记录
    const existingExecution = await this.executionRepository.findByConversationSourceAndTurn(
      source.id,
      turn.turnNumber,
    );

    if (existingExecution && !forceRerun) {
      return {
        turnNumber: turn.turnNumber,
        similarityScore: existingExecution.similarity_score ?? null,
        rating: existingExecution.similarity_score
          ? this.llmEvaluationService.getRating(existingExecution.similarity_score)
          : null,
        executionStatus: existingExecution.execution_status,
      };
    }

    let agentResult: AgentResult;
    let executionStatus: ExecutionStatus = ExecutionStatus.SUCCESS;
    let errorMessage: string | null = null;

    const userId = source.participant_name;
    if (!userId) {
      throw new Error(`对话源 ${source.id} 缺少 participant_name，无法作为 userId`);
    }

    try {
      const options: ScenarioOptions = {
        messages: turn.history.map((m) => ({
          role: m.role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
          content: m.content,
        })),
        userId,
        thinking: DEFAULT_TEST_THINKING,
      };

      agentResult = await this.agentFacade.chatWithScenario(
        scenario,
        sessionId,
        turn.userMessage,
        options,
      );

      if (agentResult.status === AgentResultStatus.ERROR) {
        executionStatus = ExecutionStatus.FAILURE;
        errorMessage = agentResult.error?.message || '未知错误';
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionStatus = errorMsg.includes('timeout')
        ? ExecutionStatus.TIMEOUT
        : ExecutionStatus.FAILURE;
      errorMessage = errorMsg;
      agentResult = {
        status: AgentResultStatus.ERROR,
        error: { code: 'EXECUTION_ERROR', message: errorMsg },
      };
    }

    const durationMs = Date.now() - startTime;

    // 提取 Agent 回复
    const actualOutput = this.extractResponseText(agentResult);
    const toolCalls = this.extractToolCalls(agentResult);
    const tokenUsage = agentResult.data?.usage || {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    // 使用 LLM 评估（替代语义相似度）
    let similarityScore: number | null = null;
    let rating: SimilarityRating | null = null;
    let evaluationReason: string | null = null;

    if (executionStatus === ExecutionStatus.SUCCESS && turn.expectedOutput && actualOutput) {
      const evaluation = await this.llmEvaluationService.evaluate({
        userMessage: turn.userMessage,
        expectedOutput: turn.expectedOutput,
        actualOutput,
        history: turn.history,
      });
      similarityScore = evaluation.score;
      rating = this.llmEvaluationService.getRating(evaluation.score);
      evaluationReason = evaluation.reason;

      this.logger.debug(
        `LLM 评估完成: 轮次 ${turn.turnNumber}, 分数: ${evaluation.score}, 通过: ${evaluation.passed}`,
      );
    }

    // 确定评审状态
    const reviewStatus =
      similarityScore !== null && similarityScore >= SIMILARITY_THRESHOLD
        ? ReviewStatus.PASSED
        : ReviewStatus.PENDING;

    // 保存或更新执行记录
    if (existingExecution) {
      await this.executionRepository.updateExecution(existingExecution.id, {
        agent_request: (agentResult as AgentResult & { requestBody?: unknown }).requestBody,
        agent_response: agentResult.data || agentResult.fallback || agentResult.error,
        actual_output: actualOutput,
        tool_calls: toolCalls,
        execution_status: executionStatus,
        duration_ms: durationMs,
        token_usage: tokenUsage,
        error_message: errorMessage,
        similarity_score: similarityScore,
        review_status: reviewStatus,
        evaluation_reason: evaluationReason,
      });
    } else {
      await this.executionRepository.create({
        batchId: source.batch_id,
        conversationSourceId: source.id,
        turnNumber: turn.turnNumber,
        inputMessage: turn.userMessage,
        testInput: {
          message: turn.userMessage,
          history: turn.history,
          scenario,
        },
        expectedOutput: turn.expectedOutput,
        agentRequest: (agentResult as AgentResult & { requestBody?: unknown }).requestBody,
        agentResponse: agentResult.data || agentResult.fallback || agentResult.error,
        actualOutput,
        toolCalls,
        executionStatus,
        durationMs,
        tokenUsage,
        errorMessage,
        similarityScore,
        reviewStatus,
        evaluationReason,
      });
    }

    return {
      turnNumber: turn.turnNumber,
      similarityScore,
      rating,
      executionStatus,
    };
  }

  /**
   * 获取对话源的轮次列表
   */
  async getConversationTurns(sourceId: string): Promise<TurnListResponse> {
    const source = await this.conversationSourceRepository.findById(sourceId);
    if (!source) {
      throw new Error(`对话源不存在: ${sourceId}`);
    }

    const executions = await this.executionRepository.findByConversationSourceId(sourceId);

    // 解析对话以获取期望输出和真人历史
    const turns = this.splitIntoTurns(source.full_conversation as ParsedMessage[]);
    const turnMap = new Map(turns.map((t) => [t.turnNumber, t]));

    const turnExecutions: ConversationTurnExecution[] = executions.map((exec) => {
      const turn = turnMap.get(exec.turn_number ?? 0);
      return {
        id: exec.id,
        conversationSourceId: sourceId,
        turnNumber: exec.turn_number ?? 0,
        inputMessage: exec.input_message || turn?.userMessage || '',
        // 返回真人对话历史（候选人 + 招募经理）
        history: turn?.history || [],
        expectedOutput: exec.expected_output || turn?.expectedOutput || null,
        actualOutput: exec.actual_output,
        similarityScore: exec.similarity_score ?? null,
        evaluationReason: exec.evaluation_reason ?? null,
        executionStatus: exec.execution_status,
        toolCalls: exec.tool_calls as unknown[] | null,
        durationMs: exec.duration_ms,
        tokenUsage: exec.token_usage as {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        } | null,
        reviewStatus: exec.review_status,
        reviewComment: exec.review_comment,
        createdAt: new Date(exec.created_at),
      };
    });

    return {
      turns: turnExecutions.sort((a, b) => a.turnNumber - b.turnNumber),
      conversationInfo: {
        id: source.id,
        participantName: source.participant_name,
        totalTurns: source.total_turns,
        avgSimilarityScore: source.avg_similarity_score ?? null,
      },
    };
  }

  /**
   * 合并连续的同角色消息
   */
  private mergeConsecutiveMessages(messages: ParsedMessage[]): ParsedMessage[] {
    if (messages.length === 0) return [];

    const merged: ParsedMessage[] = [];
    let current = { ...messages[0] };

    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === current.role) {
        // 同角色消息，合并内容
        current.content += '\n' + messages[i].content;
      } else {
        // 不同角色，保存当前消息并开始新消息
        merged.push(current);
        current = { ...messages[i] };
      }
    }

    merged.push(current);
    return merged;
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
   * 使用两遍扫描配对 tool_call/tool_use 和 tool_result
   */
  private extractToolCalls(result: AgentResult): unknown[] {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return [];

      // 第一遍: 收集所有 tool_call/tool_use
      const toolCallMap = new Map<string, { toolName: string; input: unknown; output?: unknown }>();

      for (const msg of response.messages) {
        if (!msg.parts) continue;

        for (const part of msg.parts) {
          const partAny = part as unknown as Record<string, unknown>;

          // 提取 tool_call/tool_use
          if (partAny.type === 'tool_call' || partAny.type === 'tool_use') {
            const toolCallId = (partAny.toolCallId || partAny.id) as string;
            const toolName = (partAny.toolName || partAny.name) as string;
            const input = partAny.input || partAny.args;

            if (toolCallId && toolName) {
              toolCallMap.set(toolCallId, { toolName, input });
            }
          }
        }
      }

      // 第二遍: 匹配 tool_result
      for (const msg of response.messages) {
        if (!msg.parts) continue;

        for (const part of msg.parts) {
          const partAny = part as unknown as Record<string, unknown>;

          // 提取 tool_result
          if (partAny.type === 'tool_result') {
            const toolCallId = partAny.toolCallId as string;
            const output = partAny.result || partAny.output;

            if (toolCallId && toolCallMap.has(toolCallId)) {
              const toolCall = toolCallMap.get(toolCallId)!;
              toolCall.output = output;
            }
          }
        }
      }

      // 转换为数组格式
      return Array.from(toolCallMap.values());
    } catch {
      return [];
    }
  }
}
