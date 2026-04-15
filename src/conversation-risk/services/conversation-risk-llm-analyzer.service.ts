import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { CompletionService } from '@agent/completion.service';
import { ModelRole } from '@providers/types';
import {
  buildConversationRiskAnalysisPrompt,
  CONVERSATION_RISK_ANALYSIS_SYSTEM_PROMPT,
} from '../prompts/conversation-risk-analysis.prompt';
import type {
  ConversationRiskContext,
  ConversationRiskDetectionResult,
  ConversationRiskReviewSignal,
} from '../types/conversation-risk.types';

const ConversationRiskLlmSchema = z.object({
  hit: z.boolean(),
  riskType: z.enum(['abuse', 'complaint_risk', 'escalation', 'none']),
  riskLabel: z.string().nullable(),
  summary: z.string().nullable(),
  reason: z.string().nullable(),
});

type ConversationRiskLlmOutput = z.infer<typeof ConversationRiskLlmSchema>;

@Injectable()
export class ConversationRiskLlmAnalyzerService {
  private readonly logger = new Logger(ConversationRiskLlmAnalyzerService.name);
  private readonly timeoutMs = 6000;

  constructor(private readonly completion: CompletionService) {}

  async analyze(
    context: ConversationRiskContext,
    signal: ConversationRiskReviewSignal,
  ): Promise<ConversationRiskDetectionResult> {
    try {
      const completionPromise = this.completion.generateStructured({
        systemPrompt: CONVERSATION_RISK_ANALYSIS_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildConversationRiskAnalysisPrompt(context, signal),
          },
        ],
        role: ModelRole.Evaluate,
        schema: ConversationRiskLlmSchema,
        outputName: 'ConversationRiskLlmDecision',
        temperature: 0,
        maxOutputTokens: 300,
      });

      const result = await this.withTimeout(completionPromise, this.timeoutMs);
      return this.toDetectionResult(result.object, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[交流异常LLM复判] 分析失败，已忽略: ${message}`);
      return { hit: false };
    }
  }

  private toDetectionResult(
    output: ConversationRiskLlmOutput,
    signal: ConversationRiskReviewSignal,
  ): ConversationRiskDetectionResult {
    if (!output.hit || output.riskType === 'none') {
      return { hit: false };
    }

    return {
      hit: true,
      riskType: output.riskType,
      riskLabel: output.riskLabel || this.defaultRiskLabel(output.riskType),
      summary: output.summary || signal.summary,
      reason: output.reason || signal.reason,
      matchedKeywords: signal.matchedKeywords,
      evidenceMessages: signal.evidenceMessages,
      analysisMode: 'llm',
    };
  }

  private defaultRiskLabel(
    riskType: Exclude<ConversationRiskLlmOutput['riskType'], 'none'>,
  ): string {
    switch (riskType) {
      case 'abuse':
        return '辱骂/攻击';
      case 'complaint_risk':
        return '投诉/举报风险';
      case 'escalation':
      default:
        return '连续质问/情绪升级';
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
