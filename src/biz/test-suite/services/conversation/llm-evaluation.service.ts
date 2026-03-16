import { Injectable, Logger } from '@nestjs/common';
import { RouterService } from '@providers/router.service';
import { generateText } from 'ai';
import { randomUUID } from 'crypto';
import { SimilarityRating } from '../../enums/test.enum';
import { LlmEvaluationResult, EvaluationInput } from '../../types/test-suite.types';

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

  constructor(private readonly router: RouterService) {
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

      // 调用 LLM 进行评估
      // 注意：不注册任何工具，确保获得纯文本 JSON 响应
      const model = this.router.resolveByRole('chat');
      const aiResult = await generateText({
        model,
        system: systemPrompt,
        prompt: userMessage,
      });

      // 提取响应文本
      const responseText = aiResult.text;

      // 调试日志：记录原始响应和提取结果
      if (!responseText) {
        this.logger.warn(`LLM 评估响应为空, evaluationId=${evaluationId}`);
      } else {
        this.logger.debug(`提取的文本 (${responseText.length}字): ${responseText.slice(0, 300)}`);
      }

      // 解析评估结果
      const evaluation = this.parseEvaluationResult(responseText, evaluationId);

      // 添加 token 使用信息
      if (aiResult.usage) {
        evaluation.tokenUsage = {
          inputTokens: aiResult.usage.inputTokens ?? 0,
          outputTokens: aiResult.usage.outputTokens ?? 0,
          totalTokens: aiResult.usage.totalTokens,
        };
      }

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

【输出格式】
请严格按以下 JSON 格式输出，不要输出其他内容：
{"score": 85, "passed": true, "reason": "回复正确理解了用户需求，虽然用词不同但意图一致"}

注意：
- score 为 0-100 的整数
- passed 为 true 当且仅当 score >= 60
- reason 用简短中文说明评估理由（不超过100字），不要使用英文双引号，用「」代替
- "意思对"不等于"内容对"：即使语气友好，事实错误也必须严厉扣分`;

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

请按照评分规则进行评估，直接输出 JSON 结果。`;

    return { systemPrompt, userMessage };
  }

  /**
   * 解析评估结果 JSON
   */
  private parseEvaluationResult(responseText: string, evaluationId: string): LlmEvaluationResult {
    try {
      // 1. 清理 markdown 代码块：去掉 ```json 和 ```
      const cleanedText = responseText
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

      // 2. 提取 JSON 对象：找到第一个 { 和最后一个 }
      const firstBrace = cleanedText.indexOf('{');
      const lastBrace = cleanedText.lastIndexOf('}');

      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        this.logger.warn(`未找到 JSON 边界: ${responseText.slice(0, 200)}`);
        return this.createDefaultResult(evaluationId, '无法解析评估结果：未找到JSON');
      }

      const jsonStr = cleanedText.slice(firstBrace, lastBrace + 1);

      // 3. 解析 JSON
      const parsed = JSON.parse(jsonStr) as {
        score?: number;
        passed?: boolean;
        reason?: string;
      };

      // 4. 验证必需字段
      if (
        parsed?.score === undefined ||
        parsed?.passed === undefined ||
        parsed?.reason === undefined
      ) {
        this.logger.warn(`JSON 缺少必需字段: ${jsonStr.slice(0, 200)}`);
        return this.createDefaultResult(evaluationId, '评估结果缺少必需字段');
      }

      // 5. 严格验证字段类型
      if (
        typeof parsed.score !== 'number' ||
        typeof parsed.passed !== 'boolean' ||
        typeof parsed.reason !== 'string'
      ) {
        this.logger.warn(
          `字段类型错误: score=${typeof parsed.score}, passed=${typeof parsed.passed}, reason=${typeof parsed.reason}`,
        );
        this.logEvaluationFailure(evaluationId, responseText, '字段类型错误');
        return this.createDefaultResult(evaluationId, '评估结果格式错误：字段类型不匹配');
      }

      // 6. 验证数值范围并修正
      let score = parsed.score;
      if (score < 0 || score > 100) {
        this.logger.warn(`分数超出范围: ${score}，已修正到 [0, 100]`);
        score = Math.max(0, Math.min(100, score));
      }
      score = Math.round(score);

      // 7. 验证 passed 与 score 的一致性
      const shouldPass = score >= PASS_THRESHOLD;
      let passed = parsed.passed;
      if (passed !== shouldPass) {
        this.logger.warn(
          `passed值不一致，score=${score}, passed=${passed}，已自动修正为 ${shouldPass}`,
        );
        passed = shouldPass;
      }

      // 8. 限制 reason 长度
      const reason = parsed.reason.slice(0, 200);

      return {
        score,
        passed,
        reason,
        evaluationId,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`解析评估结果异常: ${errorMsg}, 原文: ${responseText.slice(0, 300)}`);
      this.logEvaluationFailure(evaluationId, responseText, errorMsg);
      return this.createDefaultResult(evaluationId, `解析失败: ${errorMsg}`);
    }
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
   * 记录评估失败日志（用于后续分析和优化）
   */
  private logEvaluationFailure(evaluationId: string, responseText: string, reason: string): void {
    this.logger.error(
      `[评估失败] ID=${evaluationId}, 原因=${reason}, 响应前200字=${responseText.slice(0, 200)}`,
    );
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
