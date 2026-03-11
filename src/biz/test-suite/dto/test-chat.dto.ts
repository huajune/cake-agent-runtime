import { IsString, IsOptional, IsArray, IsBoolean, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ExecutionStatus,
  ReviewStatus,
  BatchSource,
  FeishuTestStatus,
  MessageRole,
  FeedbackType,
  TestType,
} from '../enums/test.enum';

/**
 * 简单消息结构（用于对话历史）
 */
export class SimpleMessageDto {
  @ApiProperty({ description: '角色', enum: MessageRole })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({ description: '消息内容' })
  @IsString()
  content: string;
}

/**
 * Vercel AI SDK UIMessage 格式的消息部件
 */
export class UIMessagePartDto {
  @ApiProperty({ description: '部件类型', example: 'text' })
  @IsString()
  type: string;

  @ApiPropertyOptional({ description: '文本内容（type=text时）' })
  @IsOptional()
  @IsString()
  text?: string;
}

/**
 * Vercel AI SDK UIMessage 格式
 */
export class UIMessageDto {
  @ApiProperty({ description: '消息ID' })
  @IsString()
  id: string;

  @ApiProperty({ description: '角色', enum: MessageRole })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({ description: '消息部件数组', type: [UIMessagePartDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UIMessagePartDto)
  parts: UIMessagePartDto[];
}

/**
 * Vercel AI SDK useChat 请求格式
 * 用于接收 DefaultChatTransport 发送的请求
 */
export class VercelAIChatRequestDto {
  @ApiProperty({ description: '消息数组（UIMessage 格式）', type: [UIMessageDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UIMessageDto)
  messages: UIMessageDto[];

  @ApiPropertyOptional({ description: '场景配置', default: 'candidate-consultation' })
  @IsOptional()
  @IsString()
  scenario?: string;

  @ApiPropertyOptional({ description: '是否保存执行记录', default: false })
  @IsOptional()
  @IsBoolean()
  saveExecution?: boolean;

  @ApiPropertyOptional({ description: '会话 ID（同一对话保持一致，清空聊天后生成新值）' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ description: '用户 ID（注入 context，生产为 imContactId）' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: '扩展思考配置（AI SDK extended thinking）' })
  @IsOptional()
  thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };
}

/**
 * 单条测试请求 DTO
 */
export class TestChatRequestDto {
  @ApiProperty({ description: '测试消息内容' })
  @IsString()
  message: string;

  @ApiPropertyOptional({ description: '对话历史', type: [SimpleMessageDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimpleMessageDto)
  history?: SimpleMessageDto[];

  @ApiPropertyOptional({ description: '场景配置', default: 'candidate-consultation' })
  @IsOptional()
  @IsString()
  scenario?: string;

  @ApiPropertyOptional({ description: '是否保存执行记录', default: true })
  @IsOptional()
  @IsBoolean()
  saveExecution?: boolean;

  @ApiPropertyOptional({ description: '用例ID（来自飞书等）' })
  @IsOptional()
  @IsString()
  caseId?: string;

  @ApiPropertyOptional({ description: '用例名称/描述' })
  @IsOptional()
  @IsString()
  caseName?: string;

  @ApiPropertyOptional({ description: '分类/场景标签' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: '预期答案（用于人工对比）' })
  @IsOptional()
  @IsString()
  expectedOutput?: string;

  @ApiPropertyOptional({ description: '批次ID（关联测试批次）' })
  @IsOptional()
  @IsString()
  batchId?: string;

  @ApiPropertyOptional({
    description: '跳过历史截断（ai-stream 等已预处理历史的场景使用）',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipHistoryTrim?: boolean;

  @ApiPropertyOptional({
    description: '会话 ID（同一对话保持一致，自动注入 Agent context.sessionId）',
  })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ description: '用户 ID（注入 context，生产为 imContactId）' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: '扩展思考配置（AI SDK extended thinking）' })
  @IsOptional()
  thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };
}

/**
 * 批量测试请求 DTO
 */
export class BatchTestRequestDto {
  @ApiProperty({ description: '测试用例数组', type: [TestChatRequestDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestChatRequestDto)
  cases: TestChatRequestDto[];

  @ApiPropertyOptional({ description: '批次名称' })
  @IsOptional()
  @IsString()
  batchName?: string;

  @ApiPropertyOptional({ description: '是否并行执行', default: false })
  @IsOptional()
  @IsBoolean()
  parallel?: boolean;
}

/**
 * 创建测试批次请求 DTO
 */
export class CreateBatchRequestDto {
  @ApiProperty({ description: '批次名称' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: '来源', enum: BatchSource, default: BatchSource.MANUAL })
  @IsOptional()
  @IsEnum(BatchSource)
  source?: BatchSource;

  @ApiPropertyOptional({ description: '飞书表格 app_token' })
  @IsOptional()
  @IsString()
  feishuAppToken?: string;

  @ApiPropertyOptional({ description: '飞书表格 table_id' })
  @IsOptional()
  @IsString()
  feishuTableId?: string;

  @ApiPropertyOptional({
    description: '测试类型：scenario-用例测试，conversation-回归验证',
    enum: TestType,
    default: TestType.SCENARIO,
  })
  @IsOptional()
  @IsEnum(TestType)
  testType?: TestType;
}

/**
 * 更新评审状态请求 DTO
 */
export class UpdateReviewRequestDto {
  @ApiProperty({ description: '评审状态', enum: ReviewStatus })
  @IsEnum(ReviewStatus)
  reviewStatus: ReviewStatus;

  @ApiPropertyOptional({ description: '评审备注' })
  @IsOptional()
  @IsString()
  reviewComment?: string;

  @ApiPropertyOptional({ description: '失败原因（问题归因：工具误触发、回复内容错误等）' })
  @IsOptional()
  @IsString()
  failureReason?: string;

  @ApiPropertyOptional({
    description: '测试场景分类（1-缺少品牌名、2-品牌名识别等，用于飞书回写）',
  })
  @IsOptional()
  @IsString()
  testScenario?: string;

  @ApiPropertyOptional({ description: '评审人' })
  @IsOptional()
  @IsString()
  reviewedBy?: string;
}

/**
 * 测试执行响应
 */
export interface TestChatResponse {
  // 执行记录ID
  executionId?: string;

  // 结果
  actualOutput: string;
  status: ExecutionStatus;

  // 请求详情
  request: {
    url: string;
    method: string;
    body: unknown;
  };

  // 响应详情
  response: {
    statusCode: number;
    body: unknown;
    toolCalls?: unknown[];
  };

  // 指标
  metrics: {
    durationMs: number;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  };
}

/**
 * 批次统计信息
 */
export interface BatchStats {
  totalCases: number;
  executedCount: number;
  passedCount: number;
  failedCount: number;
  pendingReviewCount: number;
  passRate: number | null;
  avgDurationMs: number | null;
  avgTokenUsage: number | null;
}

/**
 * 从飞书导入测试用例请求 DTO
 */
export class ImportFromFeishuRequestDto {
  @ApiProperty({ description: '飞书多维表格 app_token' })
  @IsString()
  appToken: string;

  @ApiProperty({ description: '飞书多维表格 table_id' })
  @IsString()
  tableId: string;

  @ApiPropertyOptional({ description: '批次名称（可选，默认自动生成）' })
  @IsOptional()
  @IsString()
  batchName?: string;

  @ApiPropertyOptional({ description: '是否立即执行测试', default: false })
  @IsOptional()
  @IsBoolean()
  executeImmediately?: boolean;

  @ApiPropertyOptional({ description: '是否并行执行', default: false })
  @IsOptional()
  @IsBoolean()
  parallel?: boolean;

  @ApiPropertyOptional({
    description: '测试类型：scenario-用例测试，conversation-回归验证',
    enum: TestType,
    default: TestType.SCENARIO,
  })
  @IsOptional()
  @IsEnum(TestType)
  testType?: TestType;
}

/**
 * 飞书测试用例字段映射配置
 */
export interface FeishuFieldMapping {
  caseName?: string; // 用例名称字段
  category?: string; // 分类字段
  message?: string; // 用户消息字段
  history?: string; // 历史记录字段（JSON 格式）
  expectedOutput?: string; // 预期输出字段
}

/**
 * 导入结果
 */
export interface ImportResult {
  batchId: string;
  batchName: string;
  totalImported: number;
  cases: Array<{
    caseId: string;
    caseName: string;
    category?: string;
    message: string;
  }>;
}

/**
 * 提交反馈请求 DTO
 */
export class SubmitFeedbackRequestDto {
  @ApiProperty({ description: '反馈类型', enum: FeedbackType })
  @IsEnum(FeedbackType)
  type: FeedbackType;

  @ApiProperty({ description: '格式化的聊天记录' })
  @IsString()
  chatHistory: string;

  @ApiPropertyOptional({ description: '用户消息（最后一条用户输入）' })
  @IsOptional()
  @IsString()
  userMessage?: string;

  @ApiPropertyOptional({ description: '错误类型（仅 badcase）' })
  @IsOptional()
  @IsString()
  errorType?: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  remark?: string;

  @ApiPropertyOptional({ description: '会话 ID' })
  @IsOptional()
  @IsString()
  chatId?: string;
}

/**
 * 一键创建批量测试请求 DTO
 * 自动从预配置的飞书测试/验证集表导入并执行
 */
export class QuickCreateBatchRequestDto {
  @ApiPropertyOptional({ description: '批次名称（可选，默认自动生成）' })
  @IsOptional()
  @IsString()
  batchName?: string;

  @ApiPropertyOptional({ description: '是否并行执行', default: false })
  @IsOptional()
  @IsBoolean()
  parallel?: boolean;

  @ApiPropertyOptional({
    description: '测试类型：scenario-用例测试，conversation-回归验证',
    enum: TestType,
    default: TestType.SCENARIO,
  })
  @IsOptional()
  @IsEnum(TestType)
  testType?: TestType;
}

/**
 * 回写飞书测试结果请求 DTO
 */
export class WriteBackFeishuRequestDto {
  @ApiProperty({ description: '执行记录 ID' })
  @IsString()
  executionId: string;

  @ApiProperty({ description: '测试状态', enum: FeishuTestStatus })
  @IsEnum(FeishuTestStatus)
  testStatus: FeishuTestStatus;

  @ApiPropertyOptional({ description: '错误原因 - Agent 错误归因（失败时必填）' })
  @IsOptional()
  @IsString()
  errorReason?: string;
}

/**
 * 回写结果
 */
export interface WriteBackResult {
  success: boolean;
  recordId?: string;
  error?: string;
}
