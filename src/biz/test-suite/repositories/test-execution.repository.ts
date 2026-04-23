import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ExecutionStatus, ReviewStatus } from '../enums/test.enum';
import { TestExecution } from '../entities/test-execution.entity';
import {
  CreateExecutionData,
  UpdateExecutionResultData,
  UpdateReviewData,
  ExecutionFilters,
} from '../types/test-suite.types';

/**
 * 测试执行记录 Repository
 *
 * 职责：
 * - 封装执行记录表的 CRUD 操作
 * - 管理评审状态更新
 * - 查询执行记录
 *
 * 继承 BaseRepository，复用通用 CRUD 方法
 */
@Injectable()
export class TestExecutionRepository extends BaseRepository {
  protected readonly tableName = 'test_executions';
  private readonly MAX_JSON_DEPTH = 6;
  private readonly MAX_OBJECT_KEYS = 40;
  private readonly MAX_ARRAY_ITEMS = 20;
  private readonly MAX_STRING_LENGTH = 2000;

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
    this.logger.log('TestExecutionRepository 初始化完成');
  }

  // ==================== 基础 CRUD ====================

  /**
   * 清理 agentRequest 中的大字段，减少存储空间
   * 移除: context, systemPrompt, toolContext (这些字段占用大量空间但查询时不需要)
   * 保留: model, messages, allowedTools, stream 等有用信息
   */
  private sanitizeAgentRequest(agentRequest: unknown): unknown {
    if (!agentRequest || typeof agentRequest !== 'object') {
      return agentRequest;
    }

    const request = agentRequest as Record<string, unknown>;
    const sanitized = { ...request };

    // 移除大字段
    delete sanitized.context;
    delete sanitized.systemPrompt;
    delete sanitized.toolContext;

    return sanitized;
  }

  /**
   * 清理 agentResponse，避免重复存储大体积 toolCalls/rawData
   */
  private sanitizeAgentResponse(agentResponse: unknown): unknown {
    if (!agentResponse || typeof agentResponse !== 'object') {
      return agentResponse;
    }

    const response = agentResponse as Record<string, unknown>;
    const sanitized = {
      text: typeof response.text === 'string' ? this.truncateText(response.text) : response.text,
      steps: response.steps,
      usage: this.sanitizeJsonValue(response.usage),
    } as Record<string, unknown>;

    if (Array.isArray(response.toolCalls)) {
      sanitized.toolCallSummary = response.toolCalls.map((toolCall) => {
        const item =
          toolCall && typeof toolCall === 'object' ? (toolCall as Record<string, unknown>) : {};
        return {
          toolName:
            typeof item.toolName === 'string'
              ? item.toolName
              : typeof item.name === 'string'
                ? item.name
                : 'unknown',
        };
      });
    }

    return this.sanitizeJsonValue(sanitized);
  }

  private sanitizeToolCalls(toolCalls: unknown): unknown[] {
    const sanitized = this.sanitizeJsonValue(Array.isArray(toolCalls) ? toolCalls : []);
    return Array.isArray(sanitized) ? sanitized : [sanitized];
  }

  private sanitizeJsonValue(value: unknown, depth = 0): unknown {
    if (value == null) {
      return value;
    }

    if (typeof value === 'string') {
      return this.truncateText(value);
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (depth >= this.MAX_JSON_DEPTH) {
      return '[truncated depth]';
    }

    if (Array.isArray(value)) {
      const items = value
        .slice(0, this.MAX_ARRAY_ITEMS)
        .map((item) => this.sanitizeJsonValue(item, depth + 1));

      if (value.length > this.MAX_ARRAY_ITEMS) {
        items.push(`[truncated ${value.length - this.MAX_ARRAY_ITEMS} items]`);
      }

      return items;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const sanitized: Record<string, unknown> = {};

    for (const [key, entryValue] of entries.slice(0, this.MAX_OBJECT_KEYS)) {
      sanitized[key] = this.sanitizeJsonValue(entryValue, depth + 1);
    }

    if (entries.length > this.MAX_OBJECT_KEYS) {
      sanitized.__truncatedKeys__ = entries.length - this.MAX_OBJECT_KEYS;
    }

    return sanitized;
  }

  private truncateText(text: string): string {
    return text.length > this.MAX_STRING_LENGTH
      ? `${text.slice(0, this.MAX_STRING_LENGTH)}...(truncated)`
      : text;
  }

  /**
   * 创建执行记录
   */
  async create(data: CreateExecutionData): Promise<TestExecution> {
    const execution = await this.insert<TestExecution>({
      batch_id: data.batchId || null,
      case_id: data.caseId || null,
      case_name: data.caseName || null,
      category: data.category || null,
      test_input: data.testInput,
      expected_output: data.expectedOutput || null,
      agent_request: this.sanitizeAgentRequest(data.agentRequest),
      agent_response: this.sanitizeAgentResponse(data.agentResponse),
      actual_output: data.actualOutput,
      tool_calls: this.sanitizeToolCalls(data.toolCalls),
      execution_status: data.executionStatus,
      duration_ms: data.durationMs,
      token_usage: this.sanitizeJsonValue(data.tokenUsage),
      error_message: data.errorMessage,
      conversation_snapshot_id: data.conversationSnapshotId || null,
      turn_number: data.turnNumber || null,
      similarity_score: data.similarityScore ?? null,
      input_message: data.inputMessage || null,
      review_status: data.reviewStatus || ReviewStatus.PENDING,
      reviewer_source: data.reviewerSource || null,
      evaluation_reason: data.evaluationReason || null,
    });

    if (!execution) {
      throw new Error('创建执行记录失败');
    }

    return execution;
  }

  /**
   * 获取执行记录详情
   */
  async findById(executionId: string): Promise<TestExecution | null> {
    return this.selectOne<TestExecution>('*', (q) => q.eq('id', executionId));
  }

  /**
   * 获取执行记录列表
   */
  async findMany(limit = 50, offset = 0): Promise<TestExecution[]> {
    return this.select<TestExecution>('*', (q) =>
      q.order('created_at', { ascending: false }).range(offset, offset + limit - 1),
    );
  }

  /**
   * 获取批次的执行记录（完整数据，用于详情展示）
   */
  async findByBatchId(batchId: string, filters?: ExecutionFilters): Promise<TestExecution[]> {
    return this.select<TestExecution>('*', (q) => {
      let r = q.eq('batch_id', batchId).order('created_at');
      if (filters?.reviewStatus) {
        r = r.eq('review_status', filters.reviewStatus);
      }
      if (filters?.executionStatus) {
        r = r.eq('execution_status', filters.executionStatus);
      }
      if (filters?.category) {
        r = r.eq('category', filters.category);
      }
      return r;
    });
  }

  /**
   * 获取批次的执行记录（轻量版，用于统计计算）
   * 只选择统计所需字段，排除大型 JSON 字段以提升性能
   */
  async findByBatchIdLite(
    batchId: string,
    filters?: ExecutionFilters,
  ): Promise<
    Pick<
      TestExecution,
      | 'id'
      | 'execution_status'
      | 'review_status'
      | 'category'
      | 'duration_ms'
      | 'token_usage'
      | 'failure_reason'
    >[]
  > {
    return this.select(
      'id,execution_status,review_status,category,duration_ms,token_usage,failure_reason',
      (q) => {
        let r = q.eq('batch_id', batchId).order('created_at');
        if (filters?.reviewStatus) {
          r = r.eq('review_status', filters.reviewStatus);
        }
        if (filters?.executionStatus) {
          r = r.eq('execution_status', filters.executionStatus);
        }
        if (filters?.category) {
          r = r.eq('category', filters.category);
        }
        return r;
      },
    );
  }

  /**
   * 获取批次的执行记录（列表版，用于前端列表展示）
   * 只选择列表展示所需字段，排除大型 JSON 字段以提升性能
   */
  async findByBatchIdForList(
    batchId: string,
    filters?: ExecutionFilters,
  ): Promise<
    (Pick<
      TestExecution,
      | 'id'
      | 'case_id'
      | 'case_name'
      | 'category'
      | 'execution_status'
      | 'review_status'
      | 'created_at'
    > & { input_message?: string })[]
  > {
    const results = await this.select<TestExecution>(
      'id,case_id,case_name,category,execution_status,review_status,created_at,test_input',
      (q) => {
        let r = q.eq('batch_id', batchId).order('created_at');
        if (filters?.reviewStatus) {
          r = r.eq('review_status', filters.reviewStatus);
        }
        if (filters?.executionStatus) {
          r = r.eq('execution_status', filters.executionStatus);
        }
        if (filters?.category) {
          r = r.eq('category', filters.category);
        }
        return r;
      },
    );

    // 从 test_input 中提取 input_message，然后清除大字段
    return results.map((r) => ({
      id: r.id,
      case_id: r.case_id,
      case_name: r.case_name,
      category: r.category,
      execution_status: r.execution_status,
      review_status: r.review_status,
      created_at: r.created_at,
      input_message: (r.test_input as { message?: string } | null)?.message || '',
    }));
  }

  /**
   * 统计批次中已完成的执行记录数量（非 pending 状态）
   */
  async countCompletedByBatchId(batchId: string): Promise<{
    total: number;
    success: number;
    failure: number;
    timeout: number;
  }> {
    // 获取所有非 pending 状态的记录
    const records = await this.select<TestExecution>('execution_status', (q) =>
      q.eq('batch_id', batchId).neq('execution_status', 'pending'),
    );

    return {
      total: records.length,
      success: records.filter((r) => r.execution_status === ExecutionStatus.SUCCESS).length,
      failure: records.filter((r) => r.execution_status === ExecutionStatus.FAILURE).length,
      timeout: records.filter((r) => r.execution_status === ExecutionStatus.TIMEOUT).length,
    };
  }

  // ==================== 更新操作 ====================

  /**
   * 根据 batchId 和 caseId 更新执行结果
   */
  async updateByBatchAndCase(
    batchId: string,
    caseId: string,
    data: UpdateExecutionResultData,
  ): Promise<void> {
    const updated = await this.update(
      {
        agent_request: this.sanitizeAgentRequest(data.agentRequest) || null,
        agent_response: this.sanitizeAgentResponse(data.agentResponse) || null,
        actual_output: data.actualOutput || '',
        tool_calls: this.sanitizeToolCalls(data.toolCalls || []),
        execution_status: data.executionStatus,
        duration_ms: data.durationMs,
        token_usage: this.sanitizeJsonValue(data.tokenUsage) || null,
        error_message: data.errorMessage || null,
      },
      (q) => q.eq('batch_id', batchId).eq('case_id', caseId),
    );

    if (updated.length === 0) {
      throw new Error(`更新执行记录失败: batchId=${batchId}, caseId=${caseId}`);
    }
  }

  /**
   * 更新评审状态
   */
  async updateReview(executionId: string, review: UpdateReviewData): Promise<TestExecution> {
    const results = await this.update<TestExecution>(
      {
        review_status: review.reviewStatus,
        review_comment: review.reviewComment || null,
        failure_reason: review.failureReason || null,
        test_scenario: review.testScenario || null,
        reviewed_by: review.reviewedBy || null,
        reviewer_source: review.reviewerSource || null,
        reviewed_at: new Date().toISOString(),
      },
      (q) => q.eq('id', executionId),
    );

    return results[0];
  }

  /**
   * 批量更新评审状态
   */
  async batchUpdateReview(
    executionIds: string[],
    review: UpdateReviewData,
  ): Promise<TestExecution[]> {
    return this.update<TestExecution>(
      {
        review_status: review.reviewStatus,
        review_comment: review.reviewComment || null,
        failure_reason: review.failureReason || null,
        test_scenario: review.testScenario || null,
        reviewed_by: review.reviewedBy || null,
        reviewer_source: review.reviewerSource || null,
        reviewed_at: new Date().toISOString(),
      },
      (q) => q.in('id', executionIds),
    );
  }

  // ==================== 回归验证相关查询 ====================

  /**
   * 根据对话快照ID和轮次查询执行记录
   */
  async findByConversationSourceAndTurn(
    conversationSnapshotId: string,
    turnNumber: number,
  ): Promise<TestExecution | null> {
    return this.selectOne<TestExecution>('*', (q) =>
      q.eq('conversation_snapshot_id', conversationSnapshotId).eq('turn_number', turnNumber),
    );
  }

  /**
   * 根据对话快照ID查询所有轮次的执行记录
   */
  async findByConversationSourceId(conversationSnapshotId: string): Promise<TestExecution[]> {
    return this.select<TestExecution>('*', (q) =>
      q.eq('conversation_snapshot_id', conversationSnapshotId).order('turn_number'),
    );
  }

  /**
   * 更新执行记录（通用方法）
   */
  async updateExecution(
    id: string,
    data: Partial<{
      agent_request: unknown;
      agent_response: unknown;
      actual_output: string;
      tool_calls: unknown[];
      execution_status: ExecutionStatus;
      duration_ms: number;
      token_usage: unknown;
      error_message: string | null;
      similarity_score: number | null;
      review_status: ReviewStatus;
      review_comment: string | null;
      evaluation_reason: string | null;
    }>,
  ): Promise<TestExecution> {
    // 如果包含 agent_request，清理大字段
    const sanitizedData =
      data.agent_request !== undefined
        ? { ...data, agent_request: this.sanitizeAgentRequest(data.agent_request) }
        : { ...data };

    if (sanitizedData.agent_response !== undefined) {
      sanitizedData.agent_response = this.sanitizeAgentResponse(sanitizedData.agent_response);
    }

    if (sanitizedData.tool_calls !== undefined) {
      sanitizedData.tool_calls = this.sanitizeToolCalls(sanitizedData.tool_calls);
    }

    if (sanitizedData.token_usage !== undefined) {
      sanitizedData.token_usage = this.sanitizeJsonValue(sanitizedData.token_usage);
    }

    const results = await this.update<TestExecution>(sanitizedData, (q) => q.eq('id', id));
    if (!results[0]) {
      throw new Error(`更新执行记录失败: ${id}`);
    }
    return results[0];
  }
}
