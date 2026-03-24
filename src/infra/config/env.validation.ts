import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUrl,
  Min,
  IsOptional,
  validateSync,
} from 'class-validator';
import { Environment } from '@enums/environment.enum';
export { Environment };

/**
 * 环境变量配置类
 * 使用 class-validator 装饰器进行验证
 */
export class EnvironmentVariables {
  // ==================== 基础配置 ====================
  @IsEnum(Environment, {
    message: 'NODE_ENV 必须是 development、production 或 test',
  })
  @IsNotEmpty({ message: 'NODE_ENV 环境变量未配置，请在 .env 文件中设置' })
  NODE_ENV: Environment;

  @IsNumber({}, { message: 'PORT 必须是数字' })
  @Min(1, { message: 'PORT 必须大于 0' })
  @IsNotEmpty({ message: 'PORT 环境变量未配置，请在 .env 文件中设置' })
  PORT: number;

  // ==================== Stride API 配置 ====================
  @IsUrl({ require_tld: false }, { message: 'STRIDE_API_BASE_URL 必须是有效的 URL' })
  @IsNotEmpty({
    message: 'STRIDE_API_BASE_URL 环境变量未配置，请在 .env 文件中设置',
  })
  STRIDE_API_BASE_URL: string;

  @IsUrl({ require_tld: false }, { message: 'STRIDE_ENTERPRISE_API_BASE_URL 必须是有效的 URL' })
  @IsNotEmpty({
    message: 'STRIDE_ENTERPRISE_API_BASE_URL 环境变量未配置，请在 .env 文件中设置',
  })
  STRIDE_ENTERPRISE_API_BASE_URL: string;

  // ==================== 模型角色映射 ====================
  @IsString({ message: 'AGENT_CHAT_MODEL 必须是字符串' })
  @IsNotEmpty({
    message: 'AGENT_CHAT_MODEL 环境变量未配置，请在 .env 文件中设置',
  })
  AGENT_CHAT_MODEL: string;

  @IsOptional()
  @IsString({ message: 'AGENT_EXTRACT_MODEL 必须是字符串' })
  AGENT_EXTRACT_MODEL?: string;

  @IsOptional()
  @IsString({ message: 'AGENT_EVALUATE_MODEL 必须是字符串' })
  AGENT_EVALUATE_MODEL?: string;

  @IsOptional()
  @IsString({ message: 'AGENT_VISION_MODEL 必须是字符串' })
  AGENT_VISION_MODEL?: string;

  // ==================== Agent 安全护栏 ====================
  @IsOptional()
  @IsNumber({}, { message: 'AGENT_MAX_OUTPUT_TOKENS 必须是数字' })
  @Min(100, { message: 'AGENT_MAX_OUTPUT_TOKENS 必须大于等于 100' })
  AGENT_MAX_OUTPUT_TOKENS?: number;

  @IsOptional()
  @IsNumber({}, { message: 'AGENT_MAX_INPUT_CHARS 必须是数字' })
  @Min(100, { message: 'AGENT_MAX_INPUT_CHARS 必须大于等于 100' })
  AGENT_MAX_INPUT_CHARS?: number;

  @IsOptional()
  @IsString({ message: 'API_GUARD_TOKEN 必须是字符串' })
  API_GUARD_TOKEN?: string;

  // ==================== 会话管理配置（可选，暂未使用）====================
  @IsOptional()
  @IsNumber({}, { message: 'CONVERSATION_MAX_MESSAGES 必须是数字' })
  @Min(1, { message: 'CONVERSATION_MAX_MESSAGES 必须大于 0' })
  CONVERSATION_MAX_MESSAGES?: number;

  @IsOptional()
  @IsNumber({}, { message: 'CONVERSATION_TIMEOUT_MS 必须是数字' })
  @Min(1000, { message: 'CONVERSATION_TIMEOUT_MS 必须大于等于 1000ms' })
  CONVERSATION_TIMEOUT_MS?: number;

  @IsOptional()
  @IsNumber({}, { message: 'CONVERSATION_CLEANUP_INTERVAL_MS 必须是数字' })
  @Min(1000, {
    message: 'CONVERSATION_CLEANUP_INTERVAL_MS 必须大于等于 1000ms',
  })
  CONVERSATION_CLEANUP_INTERVAL_MS?: number;

  // ==================== HTTP 客户端配置 ====================
  @IsOptional()
  @IsNumber({}, { message: 'HTTP_CLIENT_TIMEOUT 必须是数字' })
  @Min(1000, { message: 'HTTP_CLIENT_TIMEOUT 必须大于等于 1000ms' })
  HTTP_CLIENT_TIMEOUT?: number;

  // ==================== Redis 配置 ====================
  @IsString({ message: 'UPSTASH_REDIS_REST_URL 必须是字符串' })
  @IsUrl({ require_tld: false }, { message: 'UPSTASH_REDIS_REST_URL 必须是有效的 URL' })
  @IsNotEmpty({
    message: 'UPSTASH_REDIS_REST_URL 环境变量未配置，请在 .env 文件中设置',
  })
  UPSTASH_REDIS_REST_URL: string;

  @IsString({ message: 'UPSTASH_REDIS_REST_TOKEN 必须是字符串' })
  @IsNotEmpty({
    message: 'UPSTASH_REDIS_REST_TOKEN 环境变量未配置，请在 .env 文件中设置',
  })
  UPSTASH_REDIS_REST_TOKEN: string;

  // ==================== DuLiDay API 配置 ====================
  @IsString({ message: 'DULIDAY_API_TOKEN 必须是字符串' })
  @IsNotEmpty({
    message: 'DULIDAY_API_TOKEN 环境变量未配置，请在 .env 文件中设置',
  })
  DULIDAY_API_TOKEN: string;

  // ==================== 告警系统配置（可选）====================
  @IsOptional()
  @IsString({ message: 'ALERT_ENABLED 必须是字符串' })
  ALERT_ENABLED?: string;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_SUCCESS_RATE_WARNING 必须是数字' })
  @Min(0, { message: 'ALERT_SUCCESS_RATE_WARNING 必须大于等于 0' })
  ALERT_SUCCESS_RATE_WARNING?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_SUCCESS_RATE_CRITICAL 必须是数字' })
  @Min(0, { message: 'ALERT_SUCCESS_RATE_CRITICAL 必须大于等于 0' })
  ALERT_SUCCESS_RATE_CRITICAL?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_AVG_DURATION_WARNING 必须是数字' })
  @Min(0, { message: 'ALERT_AVG_DURATION_WARNING 必须大于等于 0' })
  ALERT_AVG_DURATION_WARNING?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_AVG_DURATION_CRITICAL 必须是数字' })
  @Min(0, { message: 'ALERT_AVG_DURATION_CRITICAL 必须大于等于 0' })
  ALERT_AVG_DURATION_CRITICAL?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_QUEUE_DEPTH_WARNING 必须是数字' })
  @Min(0, { message: 'ALERT_QUEUE_DEPTH_WARNING 必须大于等于 0' })
  ALERT_QUEUE_DEPTH_WARNING?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_QUEUE_DEPTH_CRITICAL 必须是数字' })
  @Min(0, { message: 'ALERT_QUEUE_DEPTH_CRITICAL 必须大于等于 0' })
  ALERT_QUEUE_DEPTH_CRITICAL?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_ERROR_RATE_WARNING 必须是数字' })
  @Min(0, { message: 'ALERT_ERROR_RATE_WARNING 必须大于等于 0' })
  ALERT_ERROR_RATE_WARNING?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_ERROR_RATE_CRITICAL 必须是数字' })
  @Min(0, { message: 'ALERT_ERROR_RATE_CRITICAL 必须大于等于 0' })
  ALERT_ERROR_RATE_CRITICAL?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_THROTTLE_WINDOW_MS 必须是数字' })
  @Min(1000, { message: 'ALERT_THROTTLE_WINDOW_MS 必须大于等于 1000ms' })
  ALERT_THROTTLE_WINDOW_MS?: number;

  @IsOptional()
  @IsNumber({}, { message: 'ALERT_THROTTLE_MAX_OCCURRENCES 必须是数字' })
  @Min(1, { message: 'ALERT_THROTTLE_MAX_OCCURRENCES 必须大于等于 1' })
  ALERT_THROTTLE_MAX_OCCURRENCES?: number;

  // ==================== 可选配置 ====================
  @IsOptional()
  @IsString({ message: 'ENABLE_AI_REPLY 必须是字符串' })
  ENABLE_AI_REPLY?: string;

  @IsOptional()
  @IsString({ message: 'ENABLE_MESSAGE_SPLIT_SEND 必须是字符串' })
  ENABLE_MESSAGE_SPLIT_SEND?: string;
}

/**
 * 环境变量验证函数
 * 在应用启动时调用，验证所有必需的环境变量
 *
 * @param config - 原始环境变量对象
 * @returns 验证并转换后的环境变量对象
 * @throws 如果验证失败，抛出详细错误信息
 */
export function validate(config: Record<string, unknown>) {
  // 将普通对象转换为 EnvironmentVariables 类实例
  // enableImplicitConversion: true 自动进行类型转换（如字符串 "3000" -> 数字 3000）
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  // 执行验证
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false, // 不跳过缺失的属性
  });

  // 如果有验证错误，格式化错误信息并抛出
  if (errors.length > 0) {
    const errorMessages = errors
      .map((error) => {
        const constraints = error.constraints ? Object.values(error.constraints) : [];
        return `  - ${error.property}: ${constraints.join(', ')}`;
      })
      .join('\n');

    throw new Error(`\n❌ 环境变量验证失败：\n${errorMessages}\n\n请检查你的 .env 文件配置。`);
  }

  return validatedConfig;
}
