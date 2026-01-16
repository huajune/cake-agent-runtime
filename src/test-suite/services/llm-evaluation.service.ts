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

/** 评估使用的模型（使用便宜快速的模型） */
const EVALUATION_MODEL = 'openai/gpt-5-mini';

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
        userMessage: evaluationPrompt,
        model: EVALUATION_MODEL,
        allowedTools: [], // 禁用所有工具，只需要纯 LLM 回复
        systemPrompt:
          '你是一个 AI 回复评估助手。你的任务是评估 AI 客服回复的质量，并严格按照要求的 JSON 格式输出结果。不要输出任何其他内容。',
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

    return `你是一个 AI 客服回复评估专家。请评估 AI 客服的回复是否正确完成了用户请求。
${historyContext}
【用户消息】
${userMessage}

【参考回复（真人客服）】
${expectedOutput}

【实际回复（AI 客服）】
${actualOutput}

评估标准：
1. 意图正确性：是否正确理解用户意图并做出恰当响应
2. 信息完整性：是否包含关键信息（不要求用词完全一样，意思对即可）
3. 语气适当性：是否友好、专业

请严格按以下 JSON 格式输出，不要输出其他内容：
{"score": 85, "passed": true, "reason": "回复正确理解了用户需求，虽然用词不同但意图一致"}

注意：
- score 为 0-100 的整数
- passed 为 true 当且仅当 score >= 60
- reason 用简短中文说明评估理由`;
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
   * 解析评估结果 JSON
   */
  private parseEvaluationResult(responseText: string, evaluationId: string): LlmEvaluationResult {
    try {
      // 尝试从响应中提取 JSON
      const jsonMatch = responseText.match(
        /\{[\s\S]*"score"[\s\S]*"passed"[\s\S]*"reason"[\s\S]*\}/,
      );

      if (!jsonMatch) {
        this.logger.warn(`未找到有效 JSON: ${responseText.slice(0, 200)}`);
        return this.createDefaultResult(evaluationId, '无法解析评估结果');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // 验证必要字段
      if (typeof parsed.score !== 'number' || typeof parsed.reason !== 'string') {
        return this.createDefaultResult(evaluationId, '评估结果格式错误');
      }

      const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
      const passed = score >= PASS_THRESHOLD;

      return {
        score,
        passed,
        reason: parsed.reason,
        evaluationId,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`解析评估结果失败: ${errorMsg}, 原文: ${responseText.slice(0, 200)}`);
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
   * 根据分数获取评级
   */
  getRating(score: number): SimilarityRating {
    if (score >= 80) return SimilarityRating.EXCELLENT;
    if (score >= 60) return SimilarityRating.GOOD;
    if (score >= 40) return SimilarityRating.FAIR;
    return SimilarityRating.POOR;
  }
}
