import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { CandidateProfileEnrichmentService } from '@biz/user/services/candidate-profile-enrichment.service';
import {
  mergeSupplementalGenderClaims,
  normalizeGenderValue,
} from '@resolution/evidence/producers/rule-track';
import { getTurnHintValue } from '@resolution/evidence/merge';
import { unwrapUserProfileFactValue } from './long-term/long-term.types';
import { unwrapSessionFactValue } from './short-term/short-term.types';
import type { AgentMemoryContext } from './recall.types';

/**
 * 记忆加载链路中，"用外部数据源补全快照缺失字段" 的协调者。
 *
 * 约定：
 * - onTurnStart 并发加载完四类记忆后调用本 service
 * - 每个 enricher 自行判断快照是否"已经够用"以决定是否出手
 * - enricher 失败不应阻塞 agent，就地 warn 并返回原快照
 * - 性别优先级固定为 candidate > system：系统标签只补空，候选人后续自陈可覆盖；
 *   已有任意性别时都不再请求外部接口，避免系统标签反向覆盖或每轮重复查询
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

      const turnHints = mergeSupplementalGenderClaims(snapshot.turnHints, gender, '客户详情接口');
      this.logger.log(`客户详情补充性别成功: gender=${gender}`);
      return { ...snapshot, turnHints };
    } catch (error) {
      const message = toErrorMessage(error);
      this.logger.warn(`客户详情补充性别失败: ${message}`);
      return snapshot;
    }
  }

  /**
   * 从快照任一层读取已知性别；profile / facts 均可能存数字或多形态字符串，统一归一化。
   * 这里是「system 只补空」的入口守卫；candidate 覆盖 system 则由正常会话事实合并完成。
   */
  private resolveKnownGender(snapshot: AgentMemoryContext): '男' | '女' | null {
    return (
      normalizeGenderValue(
        unwrapUserProfileFactValue(snapshot.longTerm.semantic.profile?.gender),
      ) ??
      normalizeGenderValue(
        unwrapSessionFactValue(snapshot.sessionMemory?.facts?.interview_info.gender),
      ) ??
      normalizeGenderValue(getTurnHintValue(snapshot.turnHints, 'interview_info.gender'))
    );
  }
}
