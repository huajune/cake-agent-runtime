import { Injectable, Logger } from '@nestjs/common';
import { generateText, streamText, stepCountIs, ToolSet, LanguageModel } from 'ai';
import { ModelService } from '../model/model.service';
import { AgentRunParams, AgentRunResult } from './agent.types';

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);
  constructor(private readonly modelService: ModelService) {}
  private resolveModel(model: AgentRunParams['model']) {
    if (model === undefined || typeof model === 'string')
      return this.modelService.get(model as string | undefined);
    return model as LanguageModel;
  }

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
}
