import { Injectable } from '@nestjs/common';
import { RecruitmentCaseRecord } from '../entities/recruitment-case.entity';

const NEW_JOB_CONSULT_PATTERNS: RegExp[] = [
  /还有.*岗位/,
  /还有.*工作/,
  /其他.*岗位/,
  /其他.*工作/,
  /别的.*岗位/,
  /别的.*工作/,
  /换.*岗位/,
  /重新.*找工作/,
  /重新.*找岗/,
  /再推荐.*岗位/,
  /再看看.*岗位/,
];

const FOLLOWUP_HINT_PATTERNS: RegExp[] = [
  /面试/,
  /到店/,
  /门店/,
  /店长/,
  /定位/,
  /地址/,
  /导航/,
  /报到/,
  /上岗/,
  /入职/,
  /办理/,
  /资料/,
  /预约/,
];

@Injectable()
export class RecruitmentStageResolverService {
  resolve(params: {
    proceduralStage?: string | null;
    recruitmentCase: RecruitmentCaseRecord | null;
    currentMessageContent?: string | null;
  }): string | undefined {
    const content = params.currentMessageContent?.trim() ?? '';

    if (
      params.recruitmentCase &&
      this.isRelevantToOnboardFollowup(content, params.recruitmentCase)
    ) {
      return 'onboard_followup';
    }

    return params.proceduralStage ?? undefined;
  }

  isRelevantToOnboardFollowup(content: string, recruitmentCase: RecruitmentCaseRecord): boolean {
    const normalized = this.normalize(content);
    if (!normalized) return true;

    if (NEW_JOB_CONSULT_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    const caseKeywords = [
      recruitmentCase.brand_name,
      recruitmentCase.store_name,
      recruitmentCase.job_name,
      recruitmentCase.interview_time ? recruitmentCase.interview_time.slice(0, 16) : null,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => this.normalize(value));

    if (caseKeywords.some((keyword) => keyword && normalized.includes(keyword))) {
      return true;
    }

    if (FOLLOWUP_HINT_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return true;
    }

    return true;
  }

  private normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, '');
  }
}
