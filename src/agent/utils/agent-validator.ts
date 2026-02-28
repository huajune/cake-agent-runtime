import { Injectable, Logger } from '@nestjs/common';
import { AgentProfile } from '../utils/agent-profile-sanitizer';

/**
 * Agent 配置验证器
 * 负责验证各种配置的完整性和有效性
 *
 * 职责：
 * 1. 验证 profile 必填字段
 * 2. 验证上下文数据完整性
 */
@Injectable()
export class AgentConfigValidator {
  private readonly logger = new Logger(AgentConfigValidator.name);

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
}
