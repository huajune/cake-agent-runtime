import { Injectable, Logger } from '@nestjs/common';
import { CandidateProfileEnrichmentService } from '@biz/user/services/candidate-profile-enrichment.service';
import { mergeSupplementalGenderFact, normalizeGenderValue } from '../facts/high-confidence-facts';
import type { AgentMemoryContext } from '../types/memory-runtime.types';

/**
 * 记忆加载链路中，"用外部数据源补全快照缺失字段" 的协调者。
 *
 * 约定：
 * - onTurnStart 并发加载完四类记忆后调用本 service
 * - 每个 enricher 自行判断快照是否"已经够用"以决定是否出手
 * - enricher 失败不应阻塞 agent，就地 warn 并返回原快照
 *
 * 新的补全需求（年龄、姓名、历史画像等）都在这里加：暴露新方法 → 或
 * 在 enrich() 内追加新的条件分支，保持 MemoryLifecycleService 的调用方不变。
 */
export interface CandidateIdentityHint {
  token?: string;
  imBotId?: string;
  imContactId?: string;
  wecomUserId?: string;
  externalUserId?: string;
}

@Injectable()
export class MemoryEnrichmentService {
  private readonly logger = new Logger(MemoryEnrichmentService.name);

  constructor(private readonly candidateProfile: CandidateProfileEnrichmentService) {}

  /**
   * 按需富化快照。当前只处理性别兜底，后续补全字段在此叠加。
   */
  async enrich(
    snapshot: AgentMemoryContext,
    identity: CandidateIdentityHint,
  ): Promise<AgentMemoryContext> {
    const enriched = await this.supplementGender(snapshot, identity);
    return enriched;
  }

  private async supplementGender(
    snapshot: AgentMemoryContext,
    identity: CandidateIdentityHint,
  ): Promise<AgentMemoryContext> {
    if (this.resolveKnownGender(snapshot)) {
      return snapshot;
    }

    try {
      const gender = await this.candidateProfile.lookupGenderFromCustomerDetail(identity);
      if (!gender) return snapshot;

      const highConfidenceFacts = mergeSupplementalGenderFact(
        snapshot.highConfidenceFacts,
        gender,
        '客户详情接口',
      );
      this.logger.log(`客户详情补充性别成功: gender=${gender}`);
      return { ...snapshot, highConfidenceFacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`客户详情补充性别失败: ${message}`);
      return snapshot;
    }
  }

  /** 从快照任一层读取已知性别；profile / facts 均可能存数字或多形态字符串，统一归一化。 */
  private resolveKnownGender(snapshot: AgentMemoryContext): '男' | '女' | null {
    return (
      normalizeGenderValue(snapshot.longTerm.profile?.gender) ??
      normalizeGenderValue(snapshot.sessionMemory?.facts?.interview_info.gender) ??
      normalizeGenderValue(snapshot.highConfidenceFacts?.interview_info.gender)
    );
  }
}
