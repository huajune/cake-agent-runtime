/**
 * Completion 服务 — 简单一次性 LLM 调用
 *
 * 适用于不需要 memory / tools / 多步循环的场景：
 * - 群通知发布
 * - 评估系统
 * - 分类判断
 *
 * 复杂场景（私聊咨询、群内咨询）请使用 AgentRunnerService。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelMessage, Output, generateText } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@providers/types';
import { z } from 'zod';

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

export interface StructuredCompletionParams<TSchema extends z.ZodTypeAny> {
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话消息列表 */
  messages: ModelMessage[];
  /** 输出 schema */
  schema: TSchema;
  /** Structured Output 名称 */
  outputName?: string;
  /** 模型角色（默认 'chat'），映射到 AGENT_{ROLE}_MODEL */
  role?: ModelRole;
  /** 精确指定模型 ID（优先于 role） */
  modelId?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
}

export interface StructuredCompletionResult<TOutput> {
  object: TOutput;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

@Injectable()
export class CompletionService {
  private readonly logger = new Logger(CompletionService.name);
  private readonly defaultMaxOutputTokens: number;

  constructor(
    private readonly router: RouterService,
    private readonly configService: ConfigService,
  ) {
    this.defaultMaxOutputTokens = parseInt(
      this.configService.get('AGENT_MAX_OUTPUT_TOKENS', '4096'),
      10,
    );
  }

  /**
   * 执行一次性 LLM 调用
   */
  async generate(params: CompletionParams): Promise<CompletionResult> {
    const {
      systemPrompt,
      messages,
      role = 'chat',
      modelId,
      temperature,
      maxOutputTokens = this.defaultMaxOutputTokens,
    } = params;

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
   * 执行一次结构化 LLM 调用。
   */
  async generateStructured<TSchema extends z.ZodTypeAny>(
    params: StructuredCompletionParams<TSchema>,
  ): Promise<StructuredCompletionResult<z.infer<TSchema>>> {
    const {
      systemPrompt,
      messages,
      schema,
      outputName = 'StructuredOutput',
      role = 'chat',
      modelId,
      temperature,
      maxOutputTokens = this.defaultMaxOutputTokens,
    } = params;

    const model = modelId ? this.router.resolve(modelId) : this.router.resolveByRole(role);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      temperature,
      maxOutputTokens,
      output: Output.object({
        schema,
        name: outputName,
      }),
    });

    if (!result.output) {
      throw new Error('No structured output returned');
    }

    this.logger.debug(`Structured completion 完成: tokens=${result.usage.totalTokens}`);

    return {
      object: result.output as z.infer<TSchema>,
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
