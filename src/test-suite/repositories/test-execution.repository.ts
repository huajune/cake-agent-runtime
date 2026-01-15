import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase/repositories/base.repository';
import { SupabaseService } from '@core/supabase';
import { ExecutionStatus, ReviewStatus } from '../enums';

/**
 * 测试执行记录（数据库格式）
 */
export interface TestExecution {
  id: string;
  batch_id: string | null;
  case_id: string | null;
  case_name: string | null;
  category: string | null;
  test_input: unknown;
  expected_output: string | null;
  agent_request: unknown;
  agent_response: unknown;
  actual_output: string | null;
  tool_calls: unknown;
  execution_status: ExecutionStatus;
  duration_ms: number | null;
  token_usage: unknown;
  error_message: string | null;
  review_status: ReviewStatus;
  review_comment: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  failure_reason: string | null;
  test_scenario: string | null;
  created_at: string;
  // 对话验证相关字段
  conversation_source_id: string | null;
  turn_number: number | null;
  similarity_score: number | null;
  input_message: string | null;
}

/**
 * 创建执行记录数据
 */
export interface CreateExecutionData {
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
  // 对话验证相关字段
  conversationSourceId?: string;
  turnNumber?: number;
  similarityScore?: number | null;
  inputMessage?: string;
  reviewStatus?: ReviewStatus;
}

/**
 * 更新执行结果数据
 */
export interface UpdateExecutionResultData {
  agentRequest?: unknown;
  agentResponse?: unknown;
  actualOutput?: string;
  toolCalls?: unknown[];
  executionStatus: ExecutionStatus;
  durationMs: number;
  tokenUsage?: unknown;
  errorMessage?: string;
}

/**
 * 更新评审数据
 */
export interface UpdateReviewData {
  reviewStatus: ReviewStatus;
  reviewComment?: string;
  failureReason?: string;
  testScenario?: string;
  reviewedBy?: string;
}

/**
 * 执行记录筛选条件
 */
export interface ExecutionFilters {
  reviewStatus?: ReviewStatus;
  executionStatus?: ExecutionStatus;
  category?: string;
}

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
   * 创建执行记录
   */
  async create(data: CreateExecutionData): Promise<TestExecution> {
    return this.insert<TestExecution>({
      batch_id: data.batchId || null,
      case_id: data.caseId || null,
      case_name: data.caseName || null,
      category: data.category || null,
      test_input: data.testInput,
      expected_output: data.expectedOutput || null,
      agent_request: this.sanitizeAgentRequest(data.agentRequest),
      agent_response: data.agentResponse,
      actual_output: data.actualOutput,
      tool_calls: data.toolCalls,
      execution_status: data.executionStatus,
      duration_ms: data.durationMs,
      token_usage: data.tokenUsage,
      error_message: data.errorMessage,
      conversation_source_id: data.conversationSourceId || null,
      turn_number: data.turnNumber || null,
      similarity_score: data.similarityScore || null,
      input_message: data.inputMessage || null,
      review_status: data.reviewStatus || ReviewStatus.PENDING,
    });
  }

  /**
   * 获取执行记录详情
   */
  async findById(executionId: string): Promise<TestExecution | null> {
    return this.selectOne<TestExecution>({ id: `eq.${executionId}` });
  }

  /**
   * 获取执行记录列表
   */
  async findMany(limit = 50, offset = 0): Promise<TestExecution[]> {
    return this.select<TestExecution>({
      order: 'created_at.desc',
      limit: String(limit),
      offset: String(offset),
    });
  }

  /**
   * 获取批次的执行记录（完整数据，用于详情展示）
   */
  async findByBatchId(batchId: string, filters?: ExecutionFilters): Promise<TestExecution[]> {
    const params: Record<string, string> = {
      batch_id: `eq.${batchId}`,
      order: 'created_at.asc',
    };

    if (filters?.reviewStatus) {
      params.review_status = `eq.${filters.reviewStatus}`;
    }
    if (filters?.executionStatus) {
      params.execution_status = `eq.${filters.executionStatus}`;
    }
    if (filters?.category) {
      params.category = `eq.${filters.category}`;
    }

    return this.select<TestExecution>(params);
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
    const params: Record<string, string> = {
      batch_id: `eq.${batchId}`,
      order: 'created_at.asc',
      // 只选择统计所需字段，排除 agent_request, agent_response, test_input, actual_output 等大字段
      select: 'id,execution_status,review_status,category,duration_ms,token_usage,failure_reason',
    };

    if (filters?.reviewStatus) {
      params.review_status = `eq.${filters.reviewStatus}`;
    }
    if (filters?.executionStatus) {
      params.execution_status = `eq.${filters.executionStatus}`;
    }
    if (filters?.category) {
      params.category = `eq.${filters.category}`;
    }

    return this.select(params);
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
    const params: Record<string, string> = {
      batch_id: `eq.${batchId}`,
      order: 'created_at.asc',
      // 列表展示需要的字段：id, case_id, case_name, category, execution_status, review_status
      // 排除大字段：agent_request, agent_response, test_input, actual_output, tool_calls
      select: 'id,case_id,case_name,category,execution_status,review_status,created_at,test_input',
    };

    if (filters?.reviewStatus) {
      params.review_status = `eq.${filters.reviewStatus}`;
    }
    if (filters?.executionStatus) {
      params.execution_status = `eq.${filters.executionStatus}`;
    }
    if (filters?.category) {
      params.category = `eq.${filters.category}`;
    }

    const results = await this.select<TestExecution>(params);

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
    const records = await this.select<TestExecution>({
      batch_id: `eq.${batchId}`,
      execution_status: 'neq.pending',
      select: 'execution_status',
    });

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
    await this.update(
      {
        batch_id: `eq.${batchId}`,
        case_id: `eq.${caseId}`,
      },
      {
        agent_request: this.sanitizeAgentRequest(data.agentRequest) || null,
        agent_response: data.agentResponse || null,
        actual_output: data.actualOutput || '',
        tool_calls: data.toolCalls || [],
        execution_status: data.executionStatus,
        duration_ms: data.durationMs,
        token_usage: data.tokenUsage || null,
        error_message: data.errorMessage || null,
      },
    );
  }

  /**
   * 更新评审状态
   */
  async updateReview(executionId: string, review: UpdateReviewData): Promise<TestExecution> {
    const results = await this.update<TestExecution>(
      { id: `eq.${executionId}` },
      {
        review_status: review.reviewStatus,
        review_comment: review.reviewComment || null,
        failure_reason: review.failureReason || null,
        test_scenario: review.testScenario || null,
        reviewed_by: review.reviewedBy || null,
        reviewed_at: new Date().toISOString(),
      },
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
      { id: `in.(${executionIds.join(',')})` },
      {
        review_status: review.reviewStatus,
        review_comment: review.reviewComment || null,
        failure_reason: review.failureReason || null,
        test_scenario: review.testScenario || null,
        reviewed_by: review.reviewedBy || null,
        reviewed_at: new Date().toISOString(),
      },
    );
  }

  // ==================== 对话验证相关查询 ====================

  /**
   * 根据对话源ID和轮次查询执行记录
   */
  async findByConversationSourceAndTurn(
    conversationSourceId: string,
    turnNumber: number,
  ): Promise<TestExecution | null> {
    return this.selectOne<TestExecution>({
      conversation_source_id: `eq.${conversationSourceId}`,
      turn_number: `eq.${turnNumber}`,
    });
  }

  /**
   * 根据对话源ID查询所有轮次的执行记录
   */
  async findByConversationSourceId(conversationSourceId: string): Promise<TestExecution[]> {
    return this.select<TestExecution>({
      conversation_source_id: `eq.${conversationSourceId}`,
      order: 'turn_number.asc',
    });
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
    }>,
  ): Promise<TestExecution> {
    // 如果包含 agent_request，清理大字段
    const sanitizedData =
      data.agent_request !== undefined
        ? { ...data, agent_request: this.sanitizeAgentRequest(data.agent_request) }
        : data;
    const results = await this.update<TestExecution>({ id: `eq.${id}` }, sanitizedData);
    return results[0];
  }
}
