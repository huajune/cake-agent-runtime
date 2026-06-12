import { Module } from '@nestjs/common';
import { CandidateBlacklistRepository } from './repositories/candidate-blacklist.repository';
import { CandidateBlacklistService } from './services/candidate-blacklist.service';
import { CandidateBlacklistController } from './candidate-blacklist.controller';

/**
 * 候选人黑名单模块
 *
 * 独立业务域：candidate_blacklist 表的管理（拉黑/移除/命中回溯）。
 * 消息过滤层（wecom）通过导出的 CandidateBlacklistService 做命中判定。
 */
@Module({
  providers: [CandidateBlacklistRepository, CandidateBlacklistService],
  controllers: [CandidateBlacklistController],
  exports: [CandidateBlacklistService],
})
export class CandidateBlacklistModule {}
