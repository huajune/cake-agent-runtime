import { Module } from '@nestjs/common';
import { ConversationParserService } from './conversation-parser.service';

/**
 * Evaluation 模块
 *
 * 现只剩对话文本解析（ConversationParserService）。
 * LLM 相似度评分器已删除：拿真人历史回复当标准答案在动态岗位数据下不成立，
 * 评估体系口径见 docs/architecture/agent-quality-evaluation.md。
 *
 * 无 DB、无 HTTP 接口、无外部集成。
 */
@Module({
  providers: [ConversationParserService],
  exports: [ConversationParserService],
})
export class EvaluationModule {}
