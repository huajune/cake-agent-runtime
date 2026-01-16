import { Injectable, Logger } from '@nestjs/common';
import { AgentService } from '@agent';
import { randomUUID } from 'crypto';
import { SimilarityRating } from '../enums';

/**
 * LLM 评估结果接口
 */
export interface LlmEvaluationResult {
  /** 评估分数 (0-100) */
  score: number;
  /** 是否通过 (score >= 60) */
  passed: boolean;
  /** 评估理由 */
  reason: string;
  /** 评估 ID（用于追踪） */
  evaluationId: string;
  /** Token 消耗 */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * 评估输入参数
 */
export interface EvaluationInput {
  /** 用户消息 */
  userMessage: string;
  /** 期望回复（真人参考） */
  expectedOutput: string;
  /** 实际回复（Agent 生成） */
  actualOutput: string;
  /** 对话历史（可选，提供上下文） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** 通过分数阈值 */
const PASS_THRESHOLD = 60;

/** 评估使用的模型（Claude Sonnet 4.5 - 最佳评估准确度） */
const EVALUATION_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

/**
 * LLM 评估服务
 *
 * 使用 LLM 评估 Agent 回复是否正确，替代传统的语义相似度计算。
 * 优势：能理解"意图相同但用词不同"的情况，避免误判。
 */
@Injectable()
export class LlmEvaluationService {
  private readonly logger = new Logger(LlmEvaluationService.name);

  constructor(private readonly agentService: AgentService) {
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
      // 构建评估 prompt
      const evaluationPrompt = this.buildEvaluationPrompt(input);

      // 调用 Agent API 进行评估
      // 注意：必须禁用工具调用，确保获得纯文本 JSON 响应
      const result = await this.agentService.chat({
        conversationId: evaluationId,
        userMessage: '',
        model: EVALUATION_MODEL,
        allowedTools: [], // 禁用所有工具，只需要纯 LLM 回复
        systemPrompt: evaluationPrompt,
      });

      // 提取响应文本
      const responseText = this.extractResponseText(result);

      // 调试日志：记录原始响应和提取结果
      if (!responseText) {
        this.logger.warn(
          `LLM 评估响应为空, result.status=${result.status}, ` +
            `hasData=${!!result.data}, hasFallback=${!!result.fallback}`,
        );
        this.logger.warn(`完整响应: ${JSON.stringify(result).slice(0, 1000)}`);
      } else {
        this.logger.debug(`提取的文本 (${responseText.length}字): ${responseText.slice(0, 300)}`);
      }

      // 解析评估结果
      const evaluation = this.parseEvaluationResult(responseText, evaluationId);

      // 添加 token 使用信息
      if (result.data?.usage) {
        evaluation.tokenUsage = {
          inputTokens: result.data.usage.inputTokens,
          outputTokens: result.data.usage.outputTokens,
          totalTokens: result.data.usage.totalTokens,
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
   * 构建评估 prompt
   */
  private buildEvaluationPrompt(input: EvaluationInput): string {
    const { userMessage, expectedOutput, actualOutput, history } = input;

    let historyContext = '';
    if (history && history.length > 0) {
      historyContext =
        '\n【对话历史】\n' +
        history.map((h) => `${h.role === 'user' ? '用户' : '客服'}: ${h.content}`).join('\n') +
        '\n';
    }

    return `你是一个 AI 客服回复评估专家。请严格按照评分规则评估 AI 客服的回复质量。
${historyContext}
【用户消息】
${userMessage}

【参考回复（真人客服）】
${expectedOutput}

【实际回复（AI 客服）】
${actualOutput}

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

请严格按以下 JSON 格式输出，不要输出其他内容：
{"score": 85, "passed": true, "reason": "回复正确理解了用户需求，虽然用词不同但意图一致"}

注意：
- score 为 0-100 的整数
- passed 为 true 当且仅当 score >= 60
- reason 用简短中文说明评估理由（不超过100字）
- "意思对"不等于"内容对"：即使语气友好，事实错误也必须严厉扣分`;
  }

  /**
   * 从 Agent 响应中提取文本
   */
  private extractResponseText(result: any): string {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return '';

      return response.messages
        .map((msg: any) => {
          if (msg.parts) {
            return msg.parts.map((p: any) => p.text || '').join('');
          }
          return '';
        })
        .join('');
    } catch {
      return '';
    }
  }

  /**
   * 解析评估结果 JSON（增强版）
   */
  private parseEvaluationResult(responseText: string, evaluationId: string): LlmEvaluationResult {
    try {
      // 1. 清理可能的 markdown 代码块标记
      const cleanedText = responseText
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();

      // 2. 尝试多种方式提取 JSON
      let jsonMatch = cleanedText.match(
        /\{[\s\S]*?"score"[\s\S]*?"passed"[\s\S]*?"reason"[\s\S]*?\}/,
      );

      if (!jsonMatch) {
        // 3. 如果没找到，尝试整段解析（可能就是纯 JSON）
        try {
          const parsed = JSON.parse(cleanedText);
          if (
            parsed.score !== undefined &&
            parsed.passed !== undefined &&
            parsed.reason !== undefined
          ) {
            jsonMatch = [cleanedText];
          }
        } catch {
          // 继续下面的错误处理
        }
      }

      if (!jsonMatch) {
        this.logger.warn(`未找到有效 JSON: ${responseText.slice(0, 300)}`);
        this.logEvaluationFailure(evaluationId, responseText, '未找到有效JSON');
        return this.createDefaultResult(evaluationId, '无法解析评估结果：未找到JSON格式');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // 4. 严格验证字段类型
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

      // 5. 验证数值范围并修正
      let score = parsed.score;
      if (score < 0 || score > 100) {
        this.logger.warn(`分数超出范围: ${score}，已修正到 [0, 100]`);
        score = Math.max(0, Math.min(100, score));
      }
      score = Math.round(score);

      // 6. 验证 passed 与 score 的一致性
      const shouldPass = score >= PASS_THRESHOLD;
      let passed = parsed.passed;
      if (passed !== shouldPass) {
        this.logger.warn(
          `passed值不一致，score=${score}, passed=${passed}，已自动修正为 ${shouldPass}`,
        );
        passed = shouldPass;
      }

      // 7. 限制 reason 长度
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
