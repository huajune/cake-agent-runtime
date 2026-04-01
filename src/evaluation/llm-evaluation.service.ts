import { Injectable, Logger } from '@nestjs/common';
import { CompletionService } from '@agent/completion.service';
import { ModelRole } from '@providers/types';
import { randomUUID } from 'crypto';
import {
  SimilarityRating,
  LlmEvaluationResult,
  EvaluationInput,
  EvaluationStructuredOutputSchema,
} from './evaluation.types';

export type { LlmEvaluationResult, EvaluationInput };

/** 通过分数阈值 */
const PASS_THRESHOLD = 60;

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
    const systemPrompt = `你是一个 AI 客服回复评估专家。请严格按照评分规则评估 AI 客服的回复质量。

【评分规则 - 严格执行】

一、一票否决项（出现即 0-20 分）：
1. 事实性错误：给出与真人客服相反的结论（如"招人"说成"不招"，"不招"说成"招"）
2. 关键信息完全错误：岗位要求、薪资、时间、地点等核心信息完全错误

二、严重扣分项（每项扣 20-30 分）：
1. 遗漏关键信息：用户明确询问的核心信息（薪资/时间/地点/岗位要求）完全未提供
2. 逻辑矛盾：前后回复自相矛盾
3. 未完成任务：用户明确要求预约/报名，但未收集信息或确认

三、一般扣分项（每项扣 5-15 分）：
1. 信息不完整：提供了部分信息但不够详细（缺少重要细节）
2. 回复效率低：仅说"我查一下"等拖延回复，未提供任何有效信息
3. 语气不当：过于生硬或过于随意

四、加分项（满足可加分）：
1. 主动提供替代方案（+5分）
2. 信息完整且结构清晰（+5分）
3. 语气友好专业（+5分）

【评分计算】
基础分：60分
最终分 = 60 + 加分项 - 扣分项（若触发一票否决，直接给 0-20 分）
分数范围：0-100

【优先级】准确性 > 完整性 > 效率 > 语气

注意：
- score 为 0-100 的整数
- reason 用简短中文说明评估理由（不超过100字），不要使用英文双引号，用「」代替
- "意思对"不等于"内容对"：即使语气友好，事实错误也必须严厉扣分

请只返回结构化评估结果，不要输出额外解释。`;

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
    result: { score: number; reason: string },
    evaluationId: string,
  ): LlmEvaluationResult {
    const score = Math.round(result.score);
    const passed = score >= PASS_THRESHOLD;
    const reason = result.reason.slice(0, 200);

    return {
      score,
      passed,
      reason,
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
      evaluationId,
    };
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
