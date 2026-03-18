/**
 * Completion 服务 — 简单一次性 LLM 调用
 *
 * 适用于不需要 memory / tools / 多步循环的场景：
 * - 群通知发布
 * - 评估系统
 * - 分类判断
 *
 * 复杂场景（私聊咨询、群内咨询）请使用 LoopService。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage, generateText } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@providers/types';

export interface CompletionParams {
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话消息列表 */
  messages: ModelMessage[];
  /** 模型角色（默认 'chat'），映射到 AGENT_{ROLE}_MODEL */
  role?: ModelRole;
  /** 精确指定模型 ID（优先于 role） */
  modelId?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

@Injectable()
export class CompletionService {
  private readonly logger = new Logger(CompletionService.name);

  constructor(private readonly router: RouterService) {}

  /**
   * 执行一次性 LLM 调用
   */
  async generate(params: CompletionParams): Promise<CompletionResult> {
    const { systemPrompt, messages, role = 'chat', modelId, temperature, maxOutputTokens } = params;

    const model = modelId ? this.router.resolve(modelId) : this.router.resolveByRole(role);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      temperature,
      maxOutputTokens,
    });

    this.logger.debug(`Completion 完成: tokens=${result.usage.totalTokens}`);

    return {
      text: result.text,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens,
      },
    };
  }

  /**
   * 便捷方法：单条用户消息 → 文本响应
   */
  async generateSimple(params: {
    systemPrompt: string;
    userMessage: string;
    role?: ModelRole;
    modelId?: string;
  }): Promise<string> {
    const { systemPrompt, userMessage, role, modelId } = params;

    const result = await this.generate({
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      role,
      modelId,
    });

    return result.text;
  }
}
