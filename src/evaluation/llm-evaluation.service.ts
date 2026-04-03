import { Injectable, Logger } from '@nestjs/common';
import { CompletionService } from '@agent/completion.service';
import { ModelRole } from '@providers/types';
import { randomUUID } from 'crypto';
import {
  SimilarityRating,
  LlmEvaluationResult,
  EvaluationInput,
  EvaluationStructuredOutputSchema,
  DefaultEvaluationDimensions,
  type EvaluationStructuredOutput,
  type EvaluationDimensions,
} from './evaluation.types';

export type { LlmEvaluationResult, EvaluationInput };

/** 通过分数阈值 */
const PASS_THRESHOLD = 60;
const DIMENSION_WEIGHTS = {
  factualAccuracy: 0.4,
  responseEfficiency: 0.2,
  processCompliance: 0.3,
  toneNaturalness: 0.1,
} as const;

/**
 * LLM 评估服务
 *
 * 使用 LLM 评估 Agent 回复是否正确，替代传统的语义相似度计算。
 * 优势：能理解"意图相同但用词不同"的情况，避免误判。
 */
@Injectable()
export class LlmEvaluationService {
  private readonly logger = new Logger(LlmEvaluationService.name);

  constructor(private readonly completion: CompletionService) {
    this.logger.log('LlmEvaluationService 初始化完成');
  }

  /**
   * 评估 Agent 回复
   *
   * @param input 评估输入（用户消息、期望回复、实际回复）
   * @returns 评估结果（分数、是否通过、理由）
   */
  async evaluate(input: EvaluationInput): Promise<LlmEvaluationResult> {
    const evaluationId = `eval-${randomUUID().slice(0, 8)}`;
    const startTime = Date.now();

    this.logger.debug(`开始 LLM 评估: ${evaluationId}`);

    try {
      // 构建系统提示词（定义评估者角色和规则）和用户消息（待评估内容）
      const { systemPrompt, userMessage } = this.buildEvaluationPrompts(input);

      // 调用 LLM 进行结构化评估（通过 schema 约束输出格式）
      const completionResult = await this.completion.generateStructured({
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        role: ModelRole.Evaluate,
        schema: EvaluationStructuredOutputSchema,
        outputName: 'LlmEvaluationResult',
      });

      const evaluation = this.normalizeEvaluationResult(completionResult.object, evaluationId);

      // 添加 token 使用信息
      evaluation.tokenUsage = {
        inputTokens: completionResult.usage.inputTokens,
        outputTokens: completionResult.usage.outputTokens,
        totalTokens: completionResult.usage.totalTokens,
      };

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `LLM 评估完成: ${evaluationId}, 分数: ${evaluation.score}, ` +
          `通过: ${evaluation.passed}, 耗时: ${durationMs}ms`,
      );

      return evaluation;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`LLM 评估失败: ${evaluationId}, 错误: ${errorMsg}`);

      // 返回默认失败结果
      return {
        score: 0,
        passed: false,
        reason: `评估失败: ${errorMsg}`,
        dimensions: DefaultEvaluationDimensions,
        evaluationId,
      };
    }
  }

  /**
   * 构建评估的 systemPrompt 和 userMessage
   * - systemPrompt: 定义评估者角色和评分规则（稳定不变）
   * - userMessage: 待评估的具体内容（每次评估不同）
   */
  private buildEvaluationPrompts(input: EvaluationInput): {
    systemPrompt: string;
    userMessage: string;
  } {
    const { userMessage: originalUserMessage, expectedOutput, actualOutput, history } = input;

    // 系统提示词：定义评估者角色和规则
    const systemPrompt = `你是一个招聘对话评估专家。请按 4 个维度评估 AI 回复质量，并给出简短总结。

【维度定义】
1. factualAccuracy（事实正确）
- 是否与真人参考回复的结论一致
- 是否编造或说错岗位、薪资、地点、时间、班次、规则
- 一旦出现核心事实相反或强幻觉，这个维度必须低分

2. responseEfficiency（提问效率）
- 是否优先回答用户当前问题
- 是否有无必要的追问、拖延、绕圈
- 如果该直接给结果却只说「我看看」「你先说下别的信息」，应扣分

3. processCompliance（流程合规）
- 是否符合招聘/报名/约面流程
- 是否错误承诺能约、漏收必填、乱收无关字段、流程顺序错乱
- 涉及约面和报名时，这个维度权重很高

4. toneNaturalness（话术自然）
- 是否自然、可信、不机械
- 是否复读昵称、语气生硬、像脚本

【打分要求】
- 每个维度输出 0-100 整数分
- 每个维度给一句简短中文理由，控制在 40 字内
- summary 用 1 句中文总结整体问题或亮点，控制在 80 字内
- 不要输出总分，系统会按权重自行计算

【关键原则】
- 准确性和流程合规优先级最高
- 「意思差不多」不代表可高分，事实错或流程错必须严厉扣分
- 如果 AI 回复比真人更完整，但不违背事实和流程，可以给更高分

请只返回结构化结果，不要输出额外解释。`;

    // 构建对话历史上下文
    let historyContext = '';
    if (history && history.length > 0) {
      historyContext =
        '【对话历史】\n' +
        history.map((h) => `${h.role === 'user' ? '用户' : '客服'}: ${h.content}`).join('\n') +
        '\n\n';
    }

    // 用户消息：包含待评估的具体内容
    const userMessage = `请评估以下 AI 客服回复的质量：

${historyContext}【用户消息】
${originalUserMessage}

【参考回复（真人客服）】
${expectedOutput}

【实际回复（AI 客服）】
${actualOutput}

请按照评分规则进行评估。`;

    return { systemPrompt, userMessage };
  }

  /**
   * 统一整理结构化评估结果。
   */
  private normalizeEvaluationResult(
    result: EvaluationStructuredOutput,
    evaluationId: string,
  ): LlmEvaluationResult {
    const dimensions = this.normalizeDimensions(result.dimensions);
    const score = this.computeOverallScore(dimensions);
    const passed = score >= PASS_THRESHOLD;
    const reason = this.buildEvaluationReason(dimensions, result.summary);

    return {
      score,
      passed,
      reason,
      dimensions,
      evaluationId,
    };
  }

  /**
   * 创建默认失败结果
   */
  private createDefaultResult(evaluationId: string, reason: string): LlmEvaluationResult {
    return {
      score: 0,
      passed: false,
      reason,
      dimensions: DefaultEvaluationDimensions,
      evaluationId,
    };
  }

  private normalizeDimensions(
    dimensions: EvaluationStructuredOutput['dimensions'],
  ): EvaluationDimensions {
    return {
      factualAccuracy: {
        score: Math.round(dimensions.factualAccuracy.score),
        reason: dimensions.factualAccuracy.reason.slice(0, 80),
      },
      responseEfficiency: {
        score: Math.round(dimensions.responseEfficiency.score),
        reason: dimensions.responseEfficiency.reason.slice(0, 80),
      },
      processCompliance: {
        score: Math.round(dimensions.processCompliance.score),
        reason: dimensions.processCompliance.reason.slice(0, 80),
      },
      toneNaturalness: {
        score: Math.round(dimensions.toneNaturalness.score),
        reason: dimensions.toneNaturalness.reason.slice(0, 80),
      },
    };
  }

  private computeOverallScore(dimensions: EvaluationDimensions): number {
    const score =
      dimensions.factualAccuracy.score * DIMENSION_WEIGHTS.factualAccuracy +
      dimensions.responseEfficiency.score * DIMENSION_WEIGHTS.responseEfficiency +
      dimensions.processCompliance.score * DIMENSION_WEIGHTS.processCompliance +
      dimensions.toneNaturalness.score * DIMENSION_WEIGHTS.toneNaturalness;

    return Math.round(score);
  }

  private buildEvaluationReason(dimensions: EvaluationDimensions, summary: string): string {
    const prefix =
      `事实${dimensions.factualAccuracy.score}` +
      ` / 效率${dimensions.responseEfficiency.score}` +
      ` / 合规${dimensions.processCompliance.score}` +
      ` / 话术${dimensions.toneNaturalness.score}`;

    return `${prefix}：${summary}`.slice(0, 200);
  }

  /**
   * 根据分数获取评级
   */
  getRating(score: number): SimilarityRating {
    if (score >= 80) return SimilarityRating.EXCELLENT;
    if (score >= 60) return SimilarityRating.GOOD;
    if (score >= 40) return SimilarityRating.FAIR;
    return SimilarityRating.POOR;
  }
}
