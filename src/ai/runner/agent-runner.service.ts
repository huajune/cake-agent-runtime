import { Injectable, Logger } from '@nestjs/common';
import { generateText, streamText, stepCountIs, Output, ToolSet, LanguageModel } from 'ai';
import { ModelService } from '../model/model.service';
import {
  AgentRunParams,
  AgentRunResult,
  GenerateParams,
  GenerateResult,
  GenerateObjectParams,
  GenerateObjectResult,
} from './agent.types';

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(private readonly modelService: ModelService) {}

  private resolveModel(model: AgentRunParams['model']): LanguageModel {
    if (model === undefined || typeof model === 'string')
      return this.modelService.get(model as string | undefined);
    return model as LanguageModel;
  }

  /** Agent 模式 — 多步工具调用循环（单聊场景） */
  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const model = this.resolveModel(params.model);
    this.logger.log(
      'Agent执行, 工具: ' +
        Object.keys(params.tools ?? {}).length +
        ', 最大步数: ' +
        (params.maxSteps ?? 10),
    );
    try {
      const r = await generateText({
        model,
        system: params.systemPrompt,
        messages: params.messages,
        tools: params.tools as ToolSet,
        stopWhen: stepCountIs(params.maxSteps ?? 10),
      });
      this.logger.log('Agent完成, 步数: ' + r.steps.length + ', Tokens: ' + r.usage.totalTokens);
      return {
        text: r.text,
        steps: r.steps.length,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
      };
    } catch (err) {
      this.logger.error('Agent执行失败', err);
      throw err;
    }
  }

  /** 流式 Agent 模式 */
  stream(params: AgentRunParams): ReturnType<typeof streamText> {
    const model = this.resolveModel(params.model);
    this.logger.log('Agent流式执行, 工具: ' + Object.keys(params.tools ?? {}).length);
    return streamText({
      model,
      system: params.systemPrompt,
      messages: params.messages,
      tools: params.tools as ToolSet,
      stopWhen: stepCountIs(params.maxSteps ?? 10),
      onFinish: ({ usage, steps }) =>
        this.logger.log('流式完成, 步数: ' + steps.length + ', Tokens: ' + usage.totalTokens),
    });
  }

  /** 简单文本生成（群任务文案等） — 不带工具，单次调用 */
  async generate(params: GenerateParams): Promise<GenerateResult> {
    const model = this.resolveModel(params.model);
    this.logger.log('文本生成');
    try {
      const r = await generateText({
        model,
        system: params.systemPrompt,
        prompt: params.prompt,
      });
      this.logger.log('文本生成完成, Tokens: ' + r.usage.totalTokens);
      return {
        text: r.text,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
      };
    } catch (err) {
      this.logger.error('文本生成失败', err);
      throw err;
    }
  }

  /** 结构化输出（评估、事实提取等） — 使用 Output.object + Zod schema */
  async generateObject<T>(params: GenerateObjectParams<T>): Promise<GenerateObjectResult<T>> {
    const model = this.resolveModel(params.model);
    this.logger.log('结构化生成' + (params.schemaName ? ': ' + params.schemaName : ''));
    try {
      const r = await generateText({
        model,
        system: params.systemPrompt,
        prompt: params.prompt,
        output: Output.object({
          schema: params.schema,
          name: params.schemaName,
          description: params.schemaDescription,
        }),
      });
      this.logger.log('结构化生成完成, Tokens: ' + r.usage.totalTokens);
      return {
        object: r.output!,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
      };
    } catch (err) {
      this.logger.error('结构化生成失败', err);
      throw err;
    }
  }
}
