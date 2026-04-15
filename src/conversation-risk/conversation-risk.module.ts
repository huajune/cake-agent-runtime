import { Module } from '@nestjs/common';
import { ConversationRiskContextService } from './services/conversation-risk-context.service';
import { ConversationRiskDetectorService } from './services/conversation-risk-detector.service';
import { BizMessageModule } from '@biz/message/message.module';
import { MemoryModule } from '@memory/memory.module';

/**
 * 交流风险模块（精简版）
 *
 * 仅保留规则层检测与上下文构建。
 * - 高置信度关键词 → Pre-Agent 同步拦截（见 PreAgentRiskInterceptService）
 * - 语义/情绪判断 → Agent 主动调用 raise_risk_alert 工具
 *
 * 已移除：LLM 复判、异步火发忘记触发、内存节流 Map。
 */
@Module({
  imports: [BizMessageModule, MemoryModule],
  providers: [ConversationRiskContextService, ConversationRiskDetectorService],
  exports: [ConversationRiskContextService, ConversationRiskDetectorService],
})
export class ConversationRiskModule {}
