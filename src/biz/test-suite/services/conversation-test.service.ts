import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRunnerService, type AgentRunResult } from '@agent/runner.service';
import { CallerKind } from '@enums/agent.enum';
import { LlmEvaluationService } from '@evaluation/llm-evaluation.service';
import { type EvaluationDimensions } from '@evaluation/evaluation.types';
import { ConversationParserService } from '@evaluation/conversation-parser.service';
import {
  type BitableRecord,
  FeishuBitableApiService,
} from '@infra/feishu/services/bitable-api.service';
import { validationSetFieldNames } from '@infra/feishu/constants/feishu-bitable.config';
import { ConversationSnapshotRepository } from '../repositories/conversation-snapshot.repository';
import { TestExecutionRepository } from '../repositories/test-execution.repository';
import { type ConversationSnapshotRecord } from '../entities/conversation-snapshot.entity';
import { type TestExecution } from '../entities/test-execution.entity';
import { MemoryFixtureService } from './memory-fixture.service';
import { TestBatchService } from './test-batch.service';
import { TestWriteBackService } from './test-write-back.service';
import type {
  TestExecutionTraceBundle,
  TestMemoryTraceBundle,
  TestRuntimeScope,
} from '../types/test-debug-trace.types';
import {
  ExecutionStatus,
  ReviewStatus,
  ReviewerSource,
  ConversationSourceStatus,
  SimilarityRating,
  FeishuTestStatus,
  getReviewerSourceLabel,
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

/** 会随生产数据变化的工具；这类轮次不能把历史真人回复当作动态事实断言 */
const DYNAMIC_FACT_TOOL_NAMES = new Set([
  'duliday_job_list',
  'geocode',
  'duliday_interview_precheck',
  'duliday_interview_booking',
  'send_store_location',
  'invite_to_group',
]);

/** 允许策展后的验证集显式写成行为断言，此时仍按 expectedOutput 评估 */
const ASSERTION_EXPECTATION_PATTERN =
  /^(期望行为|核心检查点|检查点|断言|评审标准|验收标准|Rubric|rubric)[:：]/;

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
  private readonly turnTimeoutMs: number;
  private readonly conversationConcurrency: number;

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly llmEvaluationService: LlmEvaluationService,
    private readonly parserService: ConversationParserService,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly executionRepository: TestExecutionRepository,
    private readonly writeBackService: TestWriteBackService,
    @Optional() private readonly memoryFixtureService?: MemoryFixtureService,
    @Optional() private readonly batchService?: TestBatchService,
    @Optional() private readonly bitableApi?: FeishuBitableApiService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.turnTimeoutMs = this.readPositiveInt('TEST_SUITE_CONVERSATION_TURN_TIMEOUT_MS', 180_000, {
      min: 1_000,
      max: 600_000,
    });
    this.conversationConcurrency = this.readPositiveInt('TEST_SUITE_CONVERSATION_CONCURRENCY', 20, {
      min: 1,
      max: 20,
    });
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
      if (turns.length === 0) {
        throw new Error(`对话源 ${sourceId} 没有可执行的候选人轮次`);
      }

      const memoryScope = this.buildConversationRuntimeScope(source);
      await this.memoryFixtureService?.reset(memoryScope);
      await this.memoryFixtureService?.seed(memoryScope, source.memory_setup);

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

      const result = {
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

      await this.writeBackConversationResult(source, result);

      return result;
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
        agentResponse: exec.agent_response ?? null,
        executionTrace: exec.execution_trace ?? null,
        memoryTrace: exec.memory_trace ?? null,
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
        failureReason: exec.failure_reason,
        reviewedBy: exec.reviewed_by,
        reviewerSource: exec.reviewer_source,
        reviewedAt: exec.reviewed_at ? new Date(exec.reviewed_at) : null,
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
    const validationTitleMap = await this.resolveMissingValidationTitles(result.data);

    return {
      sources: result.data.map((source) => ({
        id: source.id,
        batchId: source.batch_id,
        feishuRecordId: source.feishu_record_id,
        conversationId: source.conversation_id,
        participantName: source.participant_name,
        validationTitle:
          source.validation_title ?? validationTitleMap.get(source.feishu_record_id) ?? null,
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
    let cursor = 0;

    const concurrency = Math.min(sources.length, this.conversationConcurrency);
    const runWorker = async () => {
      while (cursor < sources.length) {
        const source = sources[cursor++];
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
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

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
    reviewerSource: ReviewerSource = ReviewerSource.MANUAL,
    reviewedBy = 'dashboard-user',
  ): Promise<{
    id: string;
    reviewStatus: ReviewStatus;
    reviewComment: string | null;
    failureReason: string | null;
    reviewedBy: string | null;
    reviewerSource: ReviewerSource | null;
    reviewedAt: Date | null;
  }> {
    await this.executionRepository.updateReview(executionId, {
      reviewStatus,
      reviewComment,
      failureReason: reviewStatus === ReviewStatus.FAILED ? reviewComment : undefined,
      reviewedBy,
      reviewerSource,
    });

    const execution = await this.executionRepository.findById(executionId);
    if (!execution) {
      throw new Error(`执行记录不存在: ${executionId}`);
    }

    const response = {
      id: execution.id,
      reviewStatus: execution.review_status,
      reviewComment: execution.review_comment,
      failureReason: execution.failure_reason,
      reviewedBy: execution.reviewed_by,
      reviewerSource: execution.reviewer_source,
      reviewedAt: execution.reviewed_at ? new Date(execution.reviewed_at) : null,
    };

    if (!execution.conversation_snapshot_id) {
      return response;
    }

    const source = await this.conversationSnapshotRepository.findById(
      execution.conversation_snapshot_id,
    );
    if (!source?.feishu_record_id) {
      return response;
    }

    const turnExecutions = await this.executionRepository.findByConversationSourceId(source.id);
    const reviewSummary = this.buildConversationReviewSummary(turnExecutions);
    const manualStatus = this.resolveConversationManualStatus(turnExecutions);

    if (manualStatus || reviewSummary) {
      const writeBackResult = await this.writeBackService.writeBackSimilarityScore(
        source.feishu_record_id,
        source.avg_similarity_score,
        {
          batchId: source.batch_id || undefined,
          testStatus: manualStatus,
          minSimilarityScore: source.min_similarity_score,
          evaluationSummary: reviewSummary || undefined,
        },
      );
      if (!writeBackResult.success) {
        this.logger.warn(`回写回归验证评审结果失败: ${writeBackResult.error}`);
      }
    }

    if (source.batch_id && this.batchService) {
      try {
        await this.batchService.updateBatchStats(source.batch_id);
      } catch (error) {
        this.logger.warn(
          `刷新回归验证批次统计失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return response;
  }

  // ========== 私有方法 ==========

  private async resolveMissingValidationTitles(
    sources: ConversationSnapshotRecord[],
  ): Promise<Map<string, string>> {
    const missingRecordIds = sources
      .filter((source) => !source.validation_title && source.feishu_record_id)
      .map((source) => source.feishu_record_id);

    if (missingRecordIds.length === 0 || !this.bitableApi) {
      return new Map();
    }

    try {
      const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');
      if (!appToken || !tableId) {
        return new Map();
      }

      const missingSet = new Set(missingRecordIds);
      const fields = await this.bitableApi.getFields(appToken, tableId);
      const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);
      const records = await this.bitableApi.getAllRecords(appToken, tableId);
      const titleMap = new Map<string, string>();

      for (const record of records) {
        if (!missingSet.has(record.record_id)) {
          continue;
        }

        const title = this.extractValidationTitle(record, fieldNameToId);
        if (title) {
          titleMap.set(record.record_id, title);
        }
      }

      return titleMap;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`读取验证集标题失败，将使用本地快照字段: ${errorMsg}`);
      return new Map();
    }
  }

  private extractValidationTitle(
    record: BitableRecord,
    fieldNameToId: Record<string, string>,
  ): string | null {
    for (const name of validationSetFieldNames.title) {
      const fieldId = fieldNameToId[name];
      const rawValue =
        (fieldId ? record.fields[fieldId] : undefined) ?? record.fields[name] ?? undefined;
      const normalized = this.normalizeFieldValue(rawValue);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private normalizeFieldValue(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'string') {
      return value.trim() || null;
    }

    if (Array.isArray(value)) {
      const text = value
        .map((item: unknown) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'text' in item) {
            return (item as { text: string }).text;
          }
          return String(item);
        })
        .join('\n')
        .trim();
      return text || null;
    }

    if (typeof value === 'object') {
      if ('text' in value) return String((value as { text: string }).text).trim() || null;
      if ('value' in value) return String((value as { value: unknown }).value).trim() || null;
    }

    const text = String(value).trim();
    return text || null;
  }

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

    const userId = this.buildConversationTestUserId(source);
    const runtimeScope = this.buildConversationRuntimeScope(source);
    let turnEnd: TestMemoryTraceBundle['turnEnd'] = { status: 'skipped' };
    let postTurnState: unknown = null;

    try {
      const runnerMessages = [
        ...turn.history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: turn.userMessage },
      ];

      loopResult = await this.withTimeout(
        this.runner.invoke({
          callerKind: CallerKind.TEST_SUITE,
          messages: runnerMessages,
          userId,
          corpId: 'test',
          sessionId,
          scenario,
          strategySource: 'testing',
          disableFallbacks: true,
          deferTurnEnd: true,
        }),
        this.turnTimeoutMs,
        `回归验证轮次执行超时: source=${source.id}, turn=${turn.turnNumber}`,
      );
      turnEnd = await this.runDeferredTurnEnd(loopResult);
      postTurnState = await this.readMemoryStateBestEffort(runtimeScope);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionStatus = errorMsg.includes('timeout')
        ? ExecutionStatus.TIMEOUT
        : ExecutionStatus.FAILURE;
      errorMessage = errorMsg;
      postTurnState = await this.readMemoryStateBestEffort(runtimeScope);
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
      callerKind: CallerKind.TEST_SUITE,
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
      disableFallbacks: true,
    };
    const executionTrace = this.buildConversationExecutionTrace({
      source,
      turn,
      runtimeScope,
      loopResult,
      toolCalls,
      tokenUsage,
      startedAt: startTime,
      completedAt: Date.now(),
      durationMs,
    });
    const memoryTrace = this.buildConversationMemoryTrace({
      runtimeScope,
      source,
      loopResult,
      postTurnState,
      turnEnd,
    });

    let similarityScore: number | null = null;
    let rating: SimilarityRating | null = null;
    let evaluationReason: string | null = null;
    let evaluationSummary: string | null = null;
    let dimensions: EvaluationDimensions | null = null;

    if (executionStatus === ExecutionStatus.SUCCESS && turn.expectedOutput && actualOutput) {
      const toolGroundedEvaluation = this.shouldUseToolGroundedEvaluation(turn, toolCalls);
      const evaluation = await this.withTimeout(
        this.llmEvaluationService.evaluate({
          userMessage: turn.userMessage,
          expectedOutput: turn.expectedOutput,
          actualOutput,
          history: turn.history,
          evaluationMode: toolGroundedEvaluation ? 'tool_grounded' : 'reference_reply',
          toolCalls: toolGroundedEvaluation ? toolCalls : undefined,
        }),
        this.turnTimeoutMs,
        `回归验证评估超时: source=${source.id}, turn=${turn.turnNumber}`,
      );
      similarityScore = evaluation.score;
      rating = this.llmEvaluationService.getRating(evaluation.score);
      evaluationReason = toolGroundedEvaluation
        ? `动态工具评审：${evaluation.reason}`
        : evaluation.reason;
      evaluationSummary = evaluation.summary
        ? toolGroundedEvaluation
          ? `动态工具评审：${evaluation.summary}`
          : evaluation.summary
        : evaluationReason;
      dimensions = evaluation.dimensions ?? null;

      this.logger.debug(
        `LLM 评估完成: 轮次 ${turn.turnNumber}, 模式: ${
          toolGroundedEvaluation ? 'tool_grounded' : 'reference_reply'
        }, 分数: ${evaluation.score}, 通过: ${evaluation.passed}`,
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
        execution_trace: executionTrace,
        memory_trace: memoryTrace,
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
        sourceTrace: source.source_trace,
        executionTrace,
        memorySetup: source.memory_setup,
        memoryAssertions: source.memory_assertions,
        memoryTrace,
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

  private shouldUseToolGroundedEvaluation(turn: ConversationTurn, toolCalls: unknown[]): boolean {
    if (!turn.expectedOutput || ASSERTION_EXPECTATION_PATTERN.test(turn.expectedOutput.trim())) {
      return false;
    }

    return this.collectToolNames(toolCalls).some((toolName) =>
      DYNAMIC_FACT_TOOL_NAMES.has(toolName),
    );
  }

  private buildConversationRuntimeScope(source: ConversationSnapshotRecord): TestRuntimeScope {
    return {
      corpId: 'test',
      userId: this.buildConversationTestUserId(source),
      sessionId: source.conversation_id,
      callerKind: CallerKind.TEST_SUITE,
      strategySource: 'testing',
      scenario: DEFAULT_SCENARIO,
    };
  }

  private buildConversationTestUserId(source: ConversationSnapshotRecord): string {
    return `conversation-test-${source.id}`;
  }

  private async runDeferredTurnEnd(
    loopResult: AgentRunResult | null,
  ): Promise<TestMemoryTraceBundle['turnEnd']> {
    if (!loopResult?.runTurnEnd) {
      return { status: 'skipped' };
    }

    const startedAt = Date.now();
    try {
      await loopResult.runTurnEnd();
      return { status: 'completed', durationMs: Date.now() - startedAt };
    } catch (error: unknown) {
      return {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readMemoryStateBestEffort(scope: TestRuntimeScope): Promise<unknown> {
    try {
      if (!this.memoryFixtureService) {
        return null;
      }
      return await this.memoryFixtureService.read(scope);
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private buildConversationExecutionTrace(params: {
    source: ConversationSnapshotRecord;
    turn: ConversationTurn;
    runtimeScope: TestRuntimeScope;
    loopResult: AgentRunResult | null;
    toolCalls: unknown[];
    tokenUsage: unknown;
    startedAt: number;
    completedAt: number;
    durationMs: number;
  }): TestExecutionTraceBundle {
    return {
      schemaVersion: 1,
      sourceTrace: params.source.source_trace,
      asset: {
        batchId: params.source.batch_id,
        feishuRecordId: params.source.feishu_record_id,
        conversationSnapshotId: params.source.id,
        validationTitle: params.source.validation_title,
        turnNumber: params.turn.turnNumber,
      },
      runtime: {
        ...params.runtimeScope,
        startedAt: new Date(params.startedAt).toISOString(),
        completedAt: new Date(params.completedAt).toISOString(),
        durationMs: params.durationMs,
      },
      agent: {
        memorySnapshot: params.loopResult?.memorySnapshot,
        toolCalls: params.toolCalls,
        steps: params.loopResult?.agentSteps,
        usage: params.tokenUsage,
      },
    };
  }

  private buildConversationMemoryTrace(params: {
    runtimeScope: TestRuntimeScope;
    source: ConversationSnapshotRecord;
    loopResult: AgentRunResult | null;
    postTurnState: unknown;
    turnEnd: TestMemoryTraceBundle['turnEnd'];
  }): TestMemoryTraceBundle {
    return {
      schemaVersion: 1,
      scope: params.runtimeScope,
      setup: params.source.memory_setup,
      assertions: params.source.memory_assertions,
      entrySnapshot: params.loopResult?.memorySnapshot,
      postTurnState: params.postTurnState,
      turnEnd: params.turnEnd,
    };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${message} timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private readPositiveInt(
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): number {
    const raw = this.configService?.get<string | number>(key);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(bounds.min, Math.min(bounds.max, Math.floor(parsed)));
  }

  private collectToolNames(toolCalls: unknown[]): string[] {
    if (!Array.isArray(toolCalls)) return [];

    return toolCalls
      .map((toolCall) => {
        if (!toolCall || typeof toolCall !== 'object') return null;
        const record = toolCall as Record<string, unknown>;
        const name = record.toolName ?? record.name ?? record.tool;
        return typeof name === 'string' && name.trim() ? name.trim() : null;
      })
      .filter((name): name is string => Boolean(name));
  }

  private async writeBackConversationResult(
    source: ConversationSnapshotRecord,
    resultPayload: {
      avgSimilarityScore: number | null;
      minSimilarityScore: number | null;
      evaluationSummary: string | null;
      dimensionScores: {
        factualAccuracy: number | null;
        responseEfficiency: number | null;
        processCompliance: number | null;
        toneNaturalness: number | null;
      };
    },
  ): Promise<void> {
    if (!source.feishu_record_id) {
      this.logger.warn(`对话源 ${source.id} 缺少飞书记录ID，跳过回写`);
      return;
    }

    try {
      const result = await this.writeBackService.writeBackSimilarityScore(
        source.feishu_record_id,
        resultPayload.avgSimilarityScore,
        {
          batchId: source.batch_id || undefined,
          minSimilarityScore: resultPayload.minSimilarityScore,
          evaluationSummary: resultPayload.evaluationSummary,
          dimensionScores: resultPayload.dimensionScores,
        },
      );

      if (!result.success) {
        this.logger.warn(`对话 ${source.id} 回写飞书失败: ${result.error}`);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`对话 ${source.id} 回写飞书异常: ${errorMsg}`);
    }
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

  private resolveConversationManualStatus(
    executions: TestExecution[],
  ): FeishuTestStatus | undefined {
    if (executions.some((execution) => execution.review_status === ReviewStatus.FAILED)) {
      return FeishuTestStatus.FAILED;
    }

    const reviewedExecutions = executions.filter(
      (execution) => execution.review_status !== ReviewStatus.PENDING,
    );
    if (reviewedExecutions.length === executions.length && reviewedExecutions.length > 0) {
      const allSkipped = reviewedExecutions.every(
        (execution) => execution.review_status === ReviewStatus.SKIPPED,
      );
      if (allSkipped) {
        return FeishuTestStatus.SKIPPED;
      }
      return FeishuTestStatus.PASSED;
    }

    return undefined;
  }

  private buildConversationReviewSummary(executions: TestExecution[]): string | null {
    const reviewedExecutions = executions.filter(
      (execution) => execution.review_status !== ReviewStatus.PENDING,
    );
    if (reviewedExecutions.length === 0) {
      return null;
    }

    const lines = reviewedExecutions
      .sort((left, right) => (left.turn_number ?? 0) - (right.turn_number ?? 0))
      .slice(-6)
      .map((execution) => {
        const turnLabel = execution.turn_number ? `第${execution.turn_number}轮` : '未标轮次';
        const reviewerLabel = getReviewerSourceLabel(execution.reviewer_source);
        const statusLabel =
          execution.review_status === ReviewStatus.PASSED
            ? '通过'
            : execution.review_status === ReviewStatus.FAILED
              ? '失败'
              : execution.review_status === ReviewStatus.SKIPPED
                ? '跳过'
                : '待定';
        const reason =
          execution.review_comment?.trim() ||
          execution.evaluation_reason?.trim() ||
          (execution.review_status === ReviewStatus.PASSED
            ? `${reviewerLabel || '评审'}通过`
            : `${reviewerLabel || '评审'}已更新`);
        return `${turnLabel} ${statusLabel}${reviewerLabel ? `（${reviewerLabel}）` : ''}：${reason}`;
      });

    return `评审摘要\n${lines.join('\n')}`;
  }
}
