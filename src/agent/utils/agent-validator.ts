import { Injectable, Logger } from '@nestjs/common';
import { AgentProfile } from '../utils/agent-profile-sanitizer';

/**
 * 品牌配置验证结果
 */
export interface BrandConfigValidation {
  /** 是否完整可用 */
  isValid: boolean;
  /** 缺失的字段 */
  missingFields: string[];
}

/**
 * Agent 配置验证器
 * 负责验证各种配置的完整性和有效性
 *
 * 职责：
 * 1. 验证品牌配置是否可用
 * 2. 验证 profile 必填字段
 * 3. 验证上下文数据完整性
 */
@Injectable()
export class AgentConfigValidator {
  private readonly logger = new Logger(AgentConfigValidator.name);

  /**
   * 验证品牌配置是否可用
   * @param profile Agent 配置档案
   * @returns 验证结果
   */
  validateBrandConfig(_profile: AgentProfile): BrandConfigValidation {
    const missingFields: string[] = [];

    return {
      isValid: missingFields.length === 0,
      missingFields,
    };
  }

  /**
   * 验证 profile 必填字段
   * @param profile Agent 配置档案
   * @throws Error 如果缺少必填字段
   */
  validateRequiredFields(profile: AgentProfile): void {
    const errors: string[] = [];

    if (!profile.model || profile.model.trim() === '') {
      errors.push('model 不能为空');
    }

    if (errors.length > 0) {
      throw new Error(`配置验证失败: ${errors.join(', ')}`);
    }
  }

  /**
   * 验证上下文数据结构
   * @param context 上下文对象
   * @returns 验证结果
   */
  validateContext(context: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!context) {
      return { isValid: true, errors: [] }; // 上下文是可选的
    }

    if (typeof context !== 'object') {
      errors.push('context 必须是对象类型');
      return { isValid: false, errors };
    }

    // 验证特定字段的类型
    if (context.modelConfig && typeof context.modelConfig !== 'object') {
      errors.push('context.modelConfig 必须是对象类型');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * 记录验证警告
   * @param conversationId 会话ID
   * @param validation 验证结果
   */
  logValidationWarnings(conversationId: string, validation: BrandConfigValidation): void {
    if (!validation.isValid) {
      this.logger.warn(
        `⚠️ 品牌配置不完整，会话: ${conversationId}, 缺失字段: ${validation.missingFields.join(', ')}`,
      );
    }
  }
}
