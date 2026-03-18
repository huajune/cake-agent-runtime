import { Injectable, Logger } from '@nestjs/common';
import { LoopService, type AgentRunResult } from '@agent/loop.service';
import { LlmEvaluationService } from './llm-evaluation.service';
import { ConversationParserService } from './conversation-parser.service';
import { ConversationSnapshotRepository } from '../../repositories/conversation-snapshot.repository';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { type ConversationSnapshotRecord } from '../../entities/conversation-snapshot.entity';
import {
  ExecutionStatus,
  ReviewStatus,
  ConversationSourceStatus,
  SimilarityRating,
} from '../../enums/test.enum';
import {
  ParsedMessage,
  ConversationParseResult,
  ConversationExecutionResult,
  ConversationTurn,
  ConversationTurnExecution,
  TurnListResponse,
} from '../../dto/conversation-test.dto';

/** 默认场景 */
const DEFAULT_SCENARIO = 'candidate-consultation';

/** 相似度阈值（及格线） */
const SIMILARITY_THRESHOLD = 60;

/**
 * 回归验证测试服务
 *
 * 职责：
 * - 执行回归验证（调用 Agent、记录结果）
 * - 查询对话源和轮次数据
 * - 汇总统计结果
 *
 * 文本解析委托给 ConversationParserService
 */
@Injectable()
export class ConversationTestService {
  private readonly logger = new Logger(ConversationTestService.name);

  constructor(
    private readonly loop: LoopService,
    private readonly llmEvaluationService: LlmEvaluationService,
    private readonly parserService: ConversationParserService,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly executionRepository: TestExecutionRepository,
  ) {
    this.logger.log('ConversationTestService 初始化完成');
  }

  /**
   * 解析原始对话文本（委托给 ConversationParserService）
   *
   * @param rawText 原始对话文本（带时间戳）
   * @returns 解析结果
   */
  parseConversation(rawText: string): ConversationParseResult {
    return this.parserService.parseConversation(rawText);
  }

  /**
   * 将对话拆解为多个测试轮次（委托给 ConversationParserService）
   *
   * @param messages 解析后的消息列表
   * @returns 测试轮次数组
   */
  splitIntoTurns(messages: ParsedMessage[]): ConversationTurn[] {
    return this.parserService.splitIntoTurns(messages);
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
    const source = await this.conversationSnapshotRepository.findById(sourceId);
    if (!source) {
      throw new Error(`对话源不存在: ${sourceId}`);
    }

    // 更新状态为执行中
    await this.conversationSnapshotRepository.updateStatus(
      sourceId,
      ConversationSourceStatus.RUNNING,
    );

    try {
      // 拆解对话为测试轮次
      const turns = this.parserService.splitIntoTurns(source.full_conversation as ParsedMessage[]);

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
      await this.conversationSnapshotRepository.updateSource(sourceId, {
        status: ConversationSourceStatus.COMPLETED,
        totalTurns: turns.length,
        avgSimilarityScore: avgScore,
        minSimilarityScore: minScore,
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

      await this.conversationSnapshotRepository.updateStatus(
        sourceId,
        ConversationSourceStatus.FAILED,
      );

      throw error;
    }
  }

  /**
   * 获取对话源的轮次列表
   */
  async getConversationTurns(sourceId: string): Promise<TurnListResponse> {
    const source = await this.conversationSnapshotRepository.findById(sourceId);
    if (!source) {
      throw new Error(`对话源不存在: ${sourceId}`);
    }

    const executions = await this.executionRepository.findByConversationSourceId(sourceId);

    // 解析对话以获取期望输出和真人历史
    const turns = this.parserService.splitIntoTurns(source.full_conversation as ParsedMessage[]);
    const turnMap = new Map(turns.map((t) => [t.turnNumber, t]));

    const turnExecutions: ConversationTurnExecution[] = executions.map((exec) => {
      const turn = turnMap.get(exec.turn_number ?? 0);
      return {
        id: exec.id,
        conversationSnapshotId: sourceId,
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
   * 获取对话源列表（分页）
   */
  async getConversationSources(
    batchId: string,
    page = 1,
    pageSize = 20,
    status?: ConversationSourceStatus,
  ) {
    const result = await this.conversationSnapshotRepository.findByBatchIdPaginated(
      batchId,
      page,
      pageSize,
      status ? { status } : undefined,
    );

    return {
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
    };
  }

  /**
   * 批量执行回归验证
   */
  async executeConversationBatch(
    batchId: string,
    forceRerun?: boolean,
  ): Promise<{
    batchId: string;
    total: number;
    successCount: number;
    failedCount: number;
    results: ConversationExecutionResult[];
  }> {
    const sources = await this.conversationSnapshotRepository.findByBatchId(batchId);

    if (sources.length === 0) {
      throw new Error(`批次 ${batchId} 下没有回归验证记录`);
    }

    const results: ConversationExecutionResult[] = [];
    let successCount = 0;
    let failedCount = 0;

    for (const source of sources) {
      try {
        const result = await this.executeConversation(source.id, forceRerun);
        results.push(result);
        successCount++;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`对话 ${source.id} 执行失败: ${errorMessage}`);
        failedCount++;
      }
    }

    return { batchId, total: sources.length, successCount, failedCount, results };
  }

  /**
   * 更新轮次评审状态
   */
  async updateTurnReview(
    executionId: string,
    reviewStatus: ReviewStatus,
    reviewComment?: string,
  ): Promise<{ executionId: string; reviewStatus: ReviewStatus }> {
    await this.executionRepository.updateExecution(executionId, {
      review_status: reviewStatus,
      review_comment: reviewComment,
    });
    return { executionId, reviewStatus };
  }

  /**
   * 获取对话源的批次ID
   */
  async getSourceBatchId(sourceId: string): Promise<string | null> {
    const source = await this.conversationSnapshotRepository.findById(sourceId);
    return source?.batch_id ?? null;
  }

  /**
   * 执行单个轮次测试
   */
  private async executeTurn(
    source: ConversationSnapshotRecord,
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

    let loopResult: AgentRunResult | null = null;
    let executionStatus: ExecutionStatus = ExecutionStatus.SUCCESS;
    let errorMessage: string | null = null;

    const userId = source.participant_name;
    if (!userId) {
      throw new Error(`对话源 ${source.id} 缺少 participant_name，无法作为 userId`);
    }

    try {
      loopResult = await this.loop.invoke({
        messages: [
          ...turn.history.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user' as const, content: turn.userMessage },
        ],
        userId,
        corpId: 'test',
        sessionId,
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

    // 提取 Agent 回复
    const actualOutput = loopResult?.text ?? '';
    const toolCalls: unknown[] = [];
    const tokenUsage = loopResult?.usage ?? {
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
        agent_request: null,
        agent_response: loopResult ? { text: loopResult.text } : null,
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
        conversationSnapshotId: source.id,
        turnNumber: turn.turnNumber,
        inputMessage: turn.userMessage,
        testInput: {
          message: turn.userMessage,
          history: turn.history,
          scenario,
        },
        expectedOutput: turn.expectedOutput,
        agentRequest: null,
        agentResponse: loopResult ? { text: loopResult.text } : null,
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
}
