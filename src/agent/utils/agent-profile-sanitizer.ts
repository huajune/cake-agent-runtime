import { Logger } from '@nestjs/common';
import { ContextStrategy } from './agent-enums';

/**
 * Agent 配置档案
 */
export interface AgentProfile {
  model: string;
  systemPrompt?: string;
  allowedTools?: string[];
  context?: any;
  toolContext?: any;
  contextStrategy?: ContextStrategy;
  prune?: boolean;
  pruneOptions?: any;
}

/**
 * Profile 清洗器
 * 负责深拷贝、补齐默认值、清洗上下文
 *
 * 职责：
 * 1. 深拷贝 profile，避免 mutate 传入对象
 * 2. 补齐默认的 system prompt
 * 3. 清洗和验证 context
 * 4. 确保所有字段类型正确
 */
export class ProfileSanitizer {
  private static readonly logger = new Logger(ProfileSanitizer.name);

  /**
   * 默认系统提示词
   */
  private static readonly DEFAULT_SYSTEM_PROMPT =
    '你是一个专业且友好的 HR 助手，负责帮助候选人了解职位信息、解答疑问、协助预约面试。' +
    '请使用自然、专业的语气回复，避免过于生硬。';

  /**
   * 清洗配置档案
   * @param profile 原始配置档案
   * @returns 清洗后的配置档案（深拷贝）
   */
  static sanitize(profile: AgentProfile): AgentProfile {
    // 深拷贝，避免修改原对象
    const sanitized = this.deepClone(profile);

    // 补齐默认 system prompt
    if (!sanitized.systemPrompt) {
      sanitized.systemPrompt = this.DEFAULT_SYSTEM_PROMPT;
      this.logger.debug('使用默认系统提示词');
    }

    // 清洗 context
    if (sanitized.context) {
      sanitized.context = this.sanitizeContext(sanitized.context);
    }

    // 清洗 toolContext
    if (sanitized.toolContext) {
      sanitized.toolContext = this.sanitizeContext(sanitized.toolContext);
    }

    // 确保 allowedTools 是数组
    if (sanitized.allowedTools && !Array.isArray(sanitized.allowedTools)) {
      this.logger.warn('allowedTools 不是数组，转换为空数组');
      sanitized.allowedTools = [];
    }

    return sanitized;
  }

  /**
   * 深拷贝对象
   * 使用 JSON.parse/stringify 进行深拷贝
   * 注意：会丢失函数、Date、RegExp 等特殊对象
   */
  private static deepClone<T>(obj: T): T {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (error) {
      this.logger.error('深拷贝失败，返回原对象', error);
      return obj;
    }
  }

  /**
   * 清洗上下文对象
   * 移除空值、null、undefined
   * @param context 原始上下文
   * @returns 清洗后的上下文
   */
  private static sanitizeContext(context: any): any {
    if (!context || typeof context !== 'object') {
      return context;
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(context)) {
      // 跳过 null、undefined 和空对象
      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        // 递归清洗嵌套对象
        const cleaned = this.sanitizeContext(value);
        if (Object.keys(cleaned).length > 0) {
          sanitized[key] = cleaned;
        }
      } else if (Array.isArray(value) && value.length > 0) {
        // 保留非空数组
        sanitized[key] = value;
      } else if (typeof value !== 'object') {
        // 保留基本类型
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 合并配置档案和覆盖参数
   * @param profile 基础配置档案
   * @param overrides 覆盖参数
   * @returns 合并后的配置档案
   */
  static merge(profile: AgentProfile, overrides?: Partial<AgentProfile>): AgentProfile {
    if (!overrides) {
      return this.sanitize(profile);
    }

    // 深拷贝两个对象
    const baseProfile = this.deepClone(profile);
    const overrideProfile = this.deepClone(overrides);

    // 合并
    const merged = { ...baseProfile, ...overrideProfile };

    // 清洗
    return this.sanitize(merged);
  }
}
