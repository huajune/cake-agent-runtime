import { Module } from '@nestjs/common';
import { LlmModule } from '@/llm/llm.module';
import { LlmEvaluationService } from './llm-evaluation.service';
import { ConversationParserService } from './conversation-parser.service';

/**
 * Evaluation 模块
 *
 * 聚焦 Agent 评估的核心算法实现：
 * - LlmEvaluationService: 基于 LLM 的回复质量评分
 * - ConversationParserService: 对话文本解析
 *
 * 无 DB、无 HTTP 接口、无外部集成。
 */
@Module({
  imports: [LlmModule],
  providers: [LlmEvaluationService, ConversationParserService],
  exports: [LlmEvaluationService, ConversationParserService],
})
export class EvaluationModule {}
