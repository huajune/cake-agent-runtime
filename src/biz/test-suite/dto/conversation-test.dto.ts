import { IsString, IsOptional, IsNumber, IsEnum, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConversationSourceStatus,
  SimilarityRating,
  ReviewStatus,
  ReviewerSource,
} from '../enums/test.enum';

/**
 * 解析后的对话消息
 */
export interface ParsedMessage {
  /** 角色: user(候选人) | assistant(招募经理) */
  role: 'user' | 'assistant';
  /** 消息内容 */
  content: string;
  /** 发送时间（原始格式，如 "12/04 17:20"） */
  timestamp?: string;
}

/**
 * 回归验证轮次数据
 * 用于拆解后的单轮测试执行
 */
export interface ConversationTurn {
  /** 轮次编号（从1开始） */
  turnNumber: number;
  /** 历史上下文（前 N-1 轮的完整对话） */
  history: ParsedMessage[];
  /** 当前轮用户消息 */
  userMessage: string;
  /** 参考输出；真实对话拆轮时为历史下一条真人回复，动态工具场景不能当硬断言 */
  expectedOutput: string;
}

/**
 * 对话源实体（用于展示）
 */
export interface ConversationSource {
  id: string;
  batchId: string;
  feishuRecordId: string;
  conversationId: string;
  validationTitle: string | null;
  participantName: string | null;
  fullConversation: ParsedMessage[];
  rawText: string | null;
  totalTurns: number;
  avgSimilarityScore: number | null;
  minSimilarityScore: number | null;
  status: ConversationSourceStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 对话轮次执行记录（用于展示）
 */
export interface ConversationTurnExecution {
  id: string;
  conversationSnapshotId: string;
  turnNumber: number;
  inputMessage: string;
  /** 真人对话历史（候选人 + 招募经理的对话，作为 Agent 的上下文） */
  history: ParsedMessage[];
  expectedOutput: string | null;
  /** Agent 原始响应快照，用于前端还原思考/工具/回复的调用链 */
  agentResponse: unknown | null;
  /** 完整测试执行 trace bundle */
  executionTrace?: unknown | null;
  /** 记忆评测 trace bundle */
  memoryTrace?: unknown | null;
  actualOutput: string | null;
  similarityScore: number | null;
  /** LLM 评估理由 */
  evaluationReason: string | null;
  executionStatus: string;
  toolCalls: unknown[] | null;
  durationMs: number | null;
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  reviewStatus: string;
  reviewComment: string | null;
  failureReason: string | null;
  reviewedBy: string | null;
  reviewerSource: ReviewerSource | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/**
 * 对话源列表响应
 */
export interface ConversationSourceListResponse {
  sources: ConversationSource[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 轮次列表响应
 */
export interface TurnListResponse {
  turns: ConversationTurnExecution[];
  conversationInfo: {
    id: string;
    participantName: string | null;
    totalTurns: number;
    avgSimilarityScore: number | null;
  };
}

/**
 * 相似度评估结果
 */
export interface SimilarityResult {
  /** 相似度分数 (0-100) */
  score: number;
  /** 评级 */
  rating: SimilarityRating;
  /** 真人回复分词结果 */
  expectedTokens: string[];
  /** Agent回复分词结果 */
  actualTokens: string[];
  /** 共同词汇数 */
  commonTokenCount: number;
}

/**
 * 回归验证批次统计
 */
export interface ConversationBatchStats {
  totalConversations: number;
  completedConversations: number;
  totalTurns: number;
  executedTurns: number;
  avgSimilarityScore: number | null;
  passedCount: number;
  failedCount: number;
  pendingCount: number;
}

/**
 * 获取对话源列表请求 DTO
 */
export class GetConversationSourcesDto {
  @ApiProperty({ description: '批次ID' })
  @IsString()
  batchId: string;

  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页数量', default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({ description: '按状态筛选', enum: ConversationSourceStatus })
  @IsOptional()
  @IsEnum(ConversationSourceStatus)
  status?: ConversationSourceStatus;
}

/**
 * 获取轮次列表请求 DTO
 */
export class GetConversationTurnsDto {
  @ApiProperty({ description: '对话源ID' })
  @IsString()
  sourceId: string;
}

/**
 * 更新轮次评审请求 DTO
 */
export class UpdateTurnReviewDto {
  @ApiPropertyOptional({ description: '执行记录ID；路由参数已包含，body 中可省略' })
  @IsOptional()
  @IsString()
  executionId?: string;

  @ApiProperty({ description: '评审状态', enum: ReviewStatus })
  @IsEnum(ReviewStatus)
  reviewStatus: ReviewStatus;

  @ApiPropertyOptional({ description: '评审备注' })
  @IsOptional()
  @IsString()
  reviewComment?: string;

  @ApiPropertyOptional({ description: '评审人' })
  @IsOptional()
  @IsString()
  reviewedBy?: string;

  @ApiPropertyOptional({
    description: '评审来源（manual/codex/claude/system/api）',
    enum: ReviewerSource,
  })
  @IsOptional()
  @IsEnum(ReviewerSource)
  reviewerSource?: ReviewerSource;
}

/**
 * 批量执行回归验证请求 DTO
 */
export class ExecuteConversationBatchDto {
  @ApiPropertyOptional({ description: '是否强制重新执行已完成的测试', default: false })
  @IsOptional()
  forceRerun?: boolean;
}

/**
 * 执行单个回归验证请求 DTO
 */
export class ExecuteConversationDto {
  @ApiPropertyOptional({ description: '是否强制重新执行', default: false })
  @IsOptional()
  forceRerun?: boolean;
}

/**
 * 同步回归验证请求 DTO
 */
export class SyncConversationTestsDto {
  @ApiPropertyOptional({ description: '批次名称（可选，默认自动生成）' })
  @IsOptional()
  @IsString()
  batchName?: string;

  @ApiPropertyOptional({ description: '飞书表格 app_token（可选，使用默认配置）' })
  @IsOptional()
  @IsString()
  appToken?: string;

  @ApiPropertyOptional({ description: '飞书表格 table_id（可选，使用默认配置）' })
  @IsOptional()
  @IsString()
  tableId?: string;
}

/**
 * 对话解析结果
 */
export interface ConversationParseResult {
  /** 是否解析成功 */
  success: boolean;
  /** 解析后的消息列表 */
  messages: ParsedMessage[];
  /** 总轮数（候选人发言次数） */
  totalTurns: number;
  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * 回归验证执行结果
 */
export interface ConversationExecutionResult {
  sourceId: string;
  conversationId: string;
  totalTurns: number;
  executedTurns: number;
  avgSimilarityScore: number | null;
  minSimilarityScore: number | null;
  evaluationSummary: string | null;
  dimensionScores: {
    factualAccuracy: number | null;
    responseEfficiency: number | null;
    processCompliance: number | null;
    toneNaturalness: number | null;
  };
  turns: Array<{
    turnNumber: number;
    similarityScore: number | null;
    rating: SimilarityRating | null;
    executionStatus: string;
  }>;
}
