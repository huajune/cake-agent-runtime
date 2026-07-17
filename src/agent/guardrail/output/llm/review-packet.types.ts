export interface GuardrailReviewPacket {
  draftReply: string;
  latestUserMessages: Array<{
    role: 'user';
    content: string;
    messageType: 'text' | 'image' | 'emotion' | 'quote' | 'revoke';
    timestamp?: number;
  }>;
  evidence: {
    jobList?: JobListEvidence;
    precheck?: PrecheckEvidence;
    booking?: BookingEvidence;
    geocode?: GeocodeEvidence;
    sentLocation?: SentLocationEvidence;
  };
  policies: {
    redLines: string[];
    outputRuleHits: string[];
  };
}

export interface JobListEvidence {
  /** 查询意图字段的白名单投影（城市/区域/品牌/工种等），非原始 args 全量透传。 */
  args: Record<string, unknown>;
  resultCount?: number;
  status?: string;
  /** 结构化岗位数组或 markdown 摘录是否提供了可核验岗位证据。 */
  hasEvidence: boolean;
  jobs: JobListEvidenceItem[];
  /** 工具实际正向查询的品牌（exclude 模式不计入，§11 第三切换点）。 */
  requestedBrands: string[];
  /** 工具实际排除的品牌；仅 filterMode=exclude 时存在。 */
  excludedBrands?: string[];
  /** 未过品牌库验证被拒绝的品牌入参（不构成"候选人要的品牌"权威依据）。 */
  rejectedBrandInputs?: string[];
  /**
   * 岗位工具 markdown 原文摘录（截断）。duliday_job_list 默认只返回 markdown
   * （rawData 需显式请求），此时结构化 jobs 解析为空，本字段就是岗位事实的
   * ground truth——没有它 reviewer 会把已接地的推荐误判成无证据（2026-07-03 回归
   * 发现的 enforce 前必修项）。结构化 jobs 可用时不带，避免证据重复烧 token。
   */
  markdownExcerpt?: string;
  markdownExcerptChars?: number;
}

export interface JobListEvidenceItem {
  jobId?: number | string;
  brandName?: string;
  storeName?: string;
  distanceKm?: number;
  jobSalary?: string;
  scheduleText?: string;
  address?: string;
}

export interface PrecheckEvidence {
  nextAction?: string;
  requiredFieldsToCollectNow: string[];
  starterFields: string[];
  missingFields: string[];
  interviewTimeMode?: string;
  blockedReason?: string;
}

export interface BookingEvidence {
  success: boolean;
  status?: string;
  errorType?: string;
  confirmedInterviewTimeHuman?: string;
  onSiteScript?: string;
  interviewAddress?: string;
  interviewMode?: string;
}

export interface GeocodeEvidence {
  resolution?: string;
  errorType?: string;
  confidence?: string | number;
  formattedAddress?: string;
  latitude?: number;
  longitude?: number;
  areaLevelQuery?: boolean;
  /** unique 解析常没有 candidates 数组；有坐标即代表地理解析成功。 */
  hasResolvedCoordinate: boolean;
  candidates: string[];
}

export interface SentLocationEvidence {
  success: boolean;
  destination?: 'interview' | 'store';
  interviewMethod?: string;
  locationNotRequired?: boolean;
  storeName?: string;
  storeAddress?: string;
  interviewAddress?: string;
  sentAddress?: string;
  addressConflict?: boolean;
  errorType?: string;
}
