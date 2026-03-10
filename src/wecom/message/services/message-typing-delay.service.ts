import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentReplyConfig } from '@db';
import { SystemConfigService } from '@db/config';
import {
  TYPING_MIN_DELAY_MS,
  TYPING_MAX_DELAY_MS,
  TYPING_RANDOM_VARIATION,
} from '@core/config/constants/message.constants';

/**
 * 智能打字延迟服务
 * 模拟真人打字速度，避免机器人感
 *
 * 核心策略：
 * 1. 根据文字长度动态计算延迟
 * 2. 添加随机波动（±20%），更像真人
 * 3. 支持通过环境变量和 Supabase 动态调整
 */
@Injectable()
export class TypingDelayService implements OnModuleInit {
  private readonly logger = new Logger(TypingDelayService.name);

  // 基础配置（支持动态更新）
  private baseTypingSpeed: number; // 字符/秒
  private minDelay: number; // 最小延迟（毫秒）
  private maxDelay: number; // 最大延迟（毫秒）
  private randomVariation: number; // 随机波动比例 (0.2 = ±20%)

  constructor(
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {
    // 从环境变量读取配置，提供合理的默认值
    // 注意：这些值随后会被 Supabase 的动态配置覆盖
    this.baseTypingSpeed = 8; // 8字符/秒

    // 使用常量配置
    this.minDelay = TYPING_MIN_DELAY_MS;
    this.maxDelay = TYPING_MAX_DELAY_MS;
    this.randomVariation = TYPING_RANDOM_VARIATION;

    // 注册配置变更回调
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.onConfigChange(config);
    });

    this.logger.log(`智能打字延迟服务已初始化`);
    this.logger.log(`- 打字速度: ${this.baseTypingSpeed} 字符/秒`);
    this.logger.log(`- 延迟范围: ${this.minDelay}ms ~ ${this.maxDelay}ms`);
    this.logger.log(`- 随机波动: ±${this.randomVariation * 100}%`);
  }

  /**
   * 模块初始化：从 Supabase 加载动态配置
   */
  async onModuleInit() {
    try {
      const config = await this.systemConfigService.getAgentReplyConfig();
      // 从 Supabase 加载配置
      if (config.typingSpeedCharsPerSec) {
        this.baseTypingSpeed = config.typingSpeedCharsPerSec;
      } else if (config.typingDelayPerCharMs) {
        // 兼容旧字段
        this.baseTypingSpeed = Math.round(1000 / config.typingDelayPerCharMs);
      }
      this.logger.log(`已从 Supabase 加载配置: 打字速度=${this.baseTypingSpeed}字符/秒`);
    } catch (error) {
      this.logger.warn('从 Supabase 加载配置失败，使用环境变量默认值');
    }
  }

  /**
   * 配置变更回调
   */
  private onConfigChange(config: AgentReplyConfig): void {
    const oldSpeed = this.baseTypingSpeed;

    // 从 Supabase 配置更新
    if (config.typingSpeedCharsPerSec) {
      this.baseTypingSpeed = config.typingSpeedCharsPerSec;
    } else if (config.typingDelayPerCharMs) {
      this.baseTypingSpeed = Math.round(1000 / config.typingDelayPerCharMs);
    }

    if (oldSpeed !== this.baseTypingSpeed) {
      this.logger.log(
        `打字延迟配置已更新: 打字速度 ${oldSpeed}字符/秒 → ${this.baseTypingSpeed}字符/秒`,
      );
    }
  }

  /**
   * 计算消息段落之间的延迟时间
   * @param text 消息文本内容
   * @param isFirstSegment 是否是第一个片段
   * @param agentProcessTime Agent 处理耗时（毫秒），用于第一个片段的延迟决策
   * @returns 延迟时间（毫秒）
   */
  calculateDelay(text: string, isFirstSegment: boolean = false, agentProcessTime?: number): number {
    // 1. 计算文本长度（中英文都算 1 个字符）
    const textLength = text.length;

    // 2. 计算基础延迟：文本长度 ÷ 打字速度
    // 例如：40 个字符 ÷ 8 字符/秒 = 5 秒 = 5000ms
    const baseDelay = (textLength / this.baseTypingSpeed) * 1000;

    // 3. 添加随机波动（±20%）
    const variation = 1 + (Math.random() * 2 - 1) * this.randomVariation;
    let delay = baseDelay * variation;

    // 4. 第一个片段的特殊处理：考虑 Agent 处理时间
    if (isFirstSegment) {
      // 如果提供了 Agent 处理时间
      if (agentProcessTime !== undefined) {
        const minReasonableWaitTime = 2000; // 用户可接受的最小等待时间（2秒）

        if (agentProcessTime >= minReasonableWaitTime) {
          // Agent 已经花了足够长的时间（≥2秒），用户已经等待了，立即发送
          this.logger.debug(
            `第一条消息，Agent 已处理 ${Math.round(agentProcessTime)}ms，立即发送（无额外延迟）`,
          );
          delay = 0; // 立即发送第一条消息
        } else {
          // Agent 处理很快（<2秒），添加补偿延迟，避免回复太快（显得像机器人）
          const compensationDelay = minReasonableWaitTime - agentProcessTime;
          delay = Math.max(delay, compensationDelay); // 确保总耗时达到最小等待时间

          this.logger.debug(
            `第一条消息，Agent 处理 ${Math.round(agentProcessTime)}ms（较快），补偿延迟 ${Math.round(delay)}ms`,
          );
        }
      }
    }

    // 5. 限制在合理范围内
    // 如果 delay 为 0（特殊情况，如 Agent 处理超时），则不应用最小延迟
    if (delay > 0) {
      delay = Math.max(this.minDelay, Math.min(this.maxDelay, delay));
    }

    this.logger.debug(
      `计算延迟: 文本长度=${textLength}, 基础延迟=${Math.round(baseDelay)}ms, 实际延迟=${Math.round(delay)}ms`,
    );

    return Math.round(delay);
  }

  /**
   * 计算多个消息段落的延迟数组
   * @param segments 消息段落数组
   * @param agentProcessTime Agent 处理耗时（毫秒）
   * @returns 延迟时间数组（毫秒）
   */
  calculateDelays(segments: string[], agentProcessTime?: number): number[] {
    return segments.map((segment, index) => {
      const isFirstSegment = index === 0;
      return this.calculateDelay(
        segment,
        isFirstSegment,
        isFirstSegment ? agentProcessTime : undefined,
      );
    });
  }

  /**
   * 执行延迟
   * @param delayMs 延迟时间（毫秒）
   */
  async delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      baseTypingSpeed: this.baseTypingSpeed,
      minDelay: this.minDelay,
      maxDelay: this.maxDelay,
      randomVariation: this.randomVariation,
    };
  }
}
