import { Injectable, Logger } from '@nestjs/common';
import { toErrorMessage } from '@infra/utils/error.util';
import { unwrapUserProfileFactValue } from '@memory/long-term/long-term.types';
import type { AgentMemoryContext } from '@memory/recall.types';
import { unwrapSessionFactValue } from '@memory/short-term/short-term.types';
import {
  mergeSupplementalGenderClaims,
  normalizeGenderValue,
} from '@resolution/turn-hints/producers/rule-track';
import { getTurnHintValue } from '@resolution/turn-hints/reducer';
import {
  CandidateProfileEnrichmentService,
  type CandidateGenderLookupParams,
} from '@biz/user/services/candidate-profile-enrichment.service';

/** 外部候选人详情的定位入参；形状即 biz 侧查询契约，不另立一份。 */
export type CandidateIdentityHint = CandidateGenderLookupParams;

/** 外部候选人详情只补快照空位，失败时 fail-open。 */
@Injectable()
export class SnapshotEnrichmentService {
  private readonly logger = new Logger(SnapshotEnrichmentService.name);

  constructor(private readonly candidateProfile: CandidateProfileEnrichmentService) {}

  async enrich(
    snapshot: AgentMemoryContext,
    identity: CandidateIdentityHint,
  ): Promise<AgentMemoryContext> {
    if (this.resolveKnownGender(snapshot)) return snapshot;
    try {
      const gender = await this.candidateProfile.lookupGenderFromCustomerDetail(identity);
      if (!gender) return snapshot;
      const turnHints = mergeSupplementalGenderClaims(snapshot.turnHints, gender, '客户详情接口');
      this.logger.log(`客户详情补充性别成功: gender=${gender}`);
      return { ...snapshot, turnHints };
    } catch (error) {
      this.logger.warn(`客户详情补充性别失败: ${toErrorMessage(error)}`);
      return snapshot;
    }
  }

  private resolveKnownGender(snapshot: AgentMemoryContext): '男' | '女' | null {
    return (
      normalizeGenderValue(
        unwrapUserProfileFactValue(snapshot.longTerm.semantic.profile?.gender),
      ) ??
      normalizeGenderValue(
        unwrapSessionFactValue(snapshot.shortTerm.sessionState?.facts?.interview_info.gender),
      ) ??
      normalizeGenderValue(getTurnHintValue(snapshot.turnHints, 'interview_info.gender'))
    );
  }
}
