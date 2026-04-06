import { Injectable, Logger, Optional } from '@nestjs/common';
import { AgentRunnerService, type AgentRunResult } from '@agent/runner.service';
import { LlmEvaluationService } from '@evaluation/llm-evaluation.service';
import { type EvaluationDimensions } from '@evaluation/evaluation.types';
import { ConversationParserService } from '@evaluation/conversation-parser.service';
import { ConversationSnapshotRepository } from '../repositories/conversation-snapshot.repository';
import { TestExecutionRepository } from '../repositories/test-execution.repository';
import { type ConversationSnapshotRecord } from '../entities/conversation-snapshot.entity';
import { TestBatchService } from './test-batch.service';
import {
  ExecutionStatus,
  ReviewStatus,
  ConversationSourceStatus,
  SimilarityRating,
} from '../enums/test.enum';
import {
  ParsedMessage,
  ConversationParseResult,
  ConversationExecutionResult,
  ConversationTurn,
  ConversationTurnExecution,
  TurnListResponse,
} from '../dto/conversation-test.dto';

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
 */
@Injectable()
export class ConversationTestService {
  private readonly logger = new Logger(ConversationTestService.name);

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly llmEvaluationService: LlmEvaluationService,
    private readonly parserService: ConversationParserService,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly executionRepository: TestExecutionRepository,
    @Optional() private readonly batchService?: TestBatchService,
  ) {
    this.logger.log('ConversationTestService 初始化完成');
  }

  /**
   * 解析原始对话文本
   */
  parseConversation(rawText: string): ConversationParseResult {
    return this.parserService.parseConversation(rawText);
  }

  /**
   * 将对话拆解为多个测试轮次
   */
  splitIntoTurns(messages: ParsedMessage[]): ConversationTurn[] {
    return this.parserService.splitIntoTurns(messages);
  }

  /**
   * 执行单个对话的所有轮次测试
   */
  async executeConversation(
    sourceId: string,
    forceRerun = false,
  ): Promise<ConversationExecutionResult> {
    const source = await this.conversationSnapshotRepository.findById(sourceId);
    if (!source) {
      throw new Error(`对话源不存在: ${sourceId}`);
    }

    await this.conversationSnapshotRepository.updateStatus(
      sourceId,
      ConversationSourceStatus.RUNNING,
    );

    try {
      const turns = this.parserService.splitIntoTurns(source.full_conversation as ParsedMessage[]);

      const turnResults: Array<{
        turnNumber: number;
        similarityScore: number | null;
        rating: SimilarityRating | null;
        executionStatus: string;
        evaluationSummary: string | null;
        dimensions: EvaluationDimensions | null;
      }> = [];

      for (const turn of turns) {
        const result = await this.executeTurn(source, turn, forceRerun);
        turnResults.push(result);
      }

      const validScores = turnResults
        .map((t) => t.similarityScore)
        .filter((s): s is number => s !== null);

      const avgScore =
        validScores.length > 0
          ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
          : null;

      const minScore = validScores.length > 0 ? Math.min(...validScores) : null;
      const dimensionScores = this.aggregateDimensionScores(turnResults);
      const evaluationSummary = this.pickLowestScoreSummary(turnResults);

      await this.conversationSnapshotRepository.updateSource(sourceId, {
        status: ConversationSourceStatus.COMPLETED,
        totalTurns: turns.length,
        avgSimilarityScore: avgScore,
        minSimilarityScore: minScore,
      });

      // 更新批次统计
      if (source.batch_id && this.batchService) {
        await this.batchService.updateBatchStats(source.batch_id);
      }

      return {
        sourceId,
        conversationId: source.conversation_id,
        totalTurns: turns.length,
        executedTurns: turnResults.length,
        avgSimilarityScore: avgScore,
        minSimilarityScore: minScore,
        evaluationSummary,
        dimensionScores,
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

    const turns = this.parserService.splitIntoTurns(source.full_conversation as ParsedMessage[]);
    const turnMap = new Map(turns.map((t) => [t.turnNumber, t]));

    const turnExecutions: ConversationTurnExecution[] = executions.map((exec) => {
      const turn = turnMap.get(exec.turn_number ?? 0);
      return {
        id: exec.id,
        conversationSnapshotId: sourceId,
        turnNumber: exec.turn_number ?? 0,
        inputMessage: exec.input_message || turn?.userMessage || '',
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
   * 获取对话源所属批次 ID（兼容旧 facade）
   */
  async getSourceBatchId(sourceId: string): Promise<string | null> {
    const source = await this.conversationSnapshotRepository.findById(sourceId);
    return source?.batch_id || null;
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

    // 批量执行完成后更新批次统计
    if (this.batchService) {
      await this.batchService.updateBatchStats(batchId);
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

  // ========== 私有方法 ==========

  private async executeTurn(
    source: ConversationSnapshotRecord,
    turn: ConversationTurn,
    forceRerun: boolean,
  ): Promise<{
    turnNumber: number;
    similarityScore: number | null;
    rating: SimilarityRating | null;
    executionStatus: string;
    evaluationSummary: string | null;
    dimensions: EvaluationDimensions | null;
  }> {
    const startTime = Date.now();
    const scenario = DEFAULT_SCENARIO;
    const sessionId = source.conversation_id;

    this.logger.debug(
      `执行对话轮次: ${sessionId} 第 ${turn.turnNumber} 轮 (sourceId: ${source.id})`,
    );

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
        evaluationSummary: existingExecution.evaluation_reason ?? null,
        dimensions: null,
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
      const runnerMessages = [
        ...turn.history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: turn.userMessage },
      ];

      loopResult = await this.runner.invoke({
        messages: runnerMessages,
        userId,
        corpId: 'test',
        sessionId,
        scenario,
        strategySource: 'testing',
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionStatus = errorMsg.includes('timeout')
        ? ExecutionStatus.TIMEOUT
        : ExecutionStatus.FAILURE;
      errorMessage = errorMsg;
    }

    const durationMs = Date.now() - startTime;

    const actualOutput = loopResult?.text ?? '';
    const toolCalls = loopResult?.toolCalls ?? [];
    const tokenUsage = loopResult?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const agentRequest = {
      messages: [
        ...turn.history.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user' as const, content: turn.userMessage },
      ],
      userId,
      corpId: 'test',
      sessionId,
      scenario,
      strategySource: 'testing' as const,
    };

    let similarityScore: number | null = null;
    let rating: SimilarityRating | null = null;
    let evaluationReason: string | null = null;
    let evaluationSummary: string | null = null;
    let dimensions: EvaluationDimensions | null = null;

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
      evaluationSummary = evaluation.summary;
      dimensions = evaluation.dimensions;

      this.logger.debug(
        `LLM 评估完成: 轮次 ${turn.turnNumber}, 分数: ${evaluation.score}, 通过: ${evaluation.passed}`,
      );
    }

    const reviewStatus =
      similarityScore !== null && similarityScore >= SIMILARITY_THRESHOLD
        ? ReviewStatus.PASSED
        : ReviewStatus.PENDING;

    if (existingExecution) {
      await this.executionRepository.updateExecution(existingExecution.id, {
        agent_request: agentRequest,
        agent_response: loopResult,
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
        agentRequest,
        agentResponse: loopResult,
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
      evaluationSummary,
      dimensions,
    };
  }

  private aggregateDimensionScores(
    turnResults: Array<{ dimensions: EvaluationDimensions | null }>,
  ): ConversationExecutionResult['dimensionScores'] {
    const validDimensions = turnResults
      .map((turn) => turn.dimensions)
      .filter((dimensions): dimensions is EvaluationDimensions => dimensions !== null);

    if (validDimensions.length === 0) {
      return {
        factualAccuracy: null,
        responseEfficiency: null,
        processCompliance: null,
        toneNaturalness: null,
      };
    }

    const average = (selector: (dimensions: EvaluationDimensions) => number) =>
      Math.round(
        validDimensions.reduce((sum, dimensions) => sum + selector(dimensions), 0) /
          validDimensions.length,
      );

    return {
      factualAccuracy: average((dimensions) => dimensions.factualAccuracy.score),
      responseEfficiency: average((dimensions) => dimensions.responseEfficiency.score),
      processCompliance: average((dimensions) => dimensions.processCompliance.score),
      toneNaturalness: average((dimensions) => dimensions.toneNaturalness.score),
    };
  }

  private pickLowestScoreSummary(
    turnResults: Array<{
      similarityScore: number | null;
      evaluationSummary: string | null;
    }>,
  ): string | null {
    const worstTurn = turnResults
      .filter(
        (turn): turn is { similarityScore: number; evaluationSummary: string | null } =>
          turn.similarityScore !== null,
      )
      .sort((a, b) => a.similarityScore - b.similarityScore)[0];

    return worstTurn?.evaluationSummary ?? null;
  }
}
