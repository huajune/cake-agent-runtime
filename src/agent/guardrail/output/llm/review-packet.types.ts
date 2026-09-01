export interface GuardrailReviewPacket {
  draftReply: string;
  latestUserMessages: Array<{
    role: 'user';
    content: string;
    messageType: 'text' | 'image' | 'emotion' | 'quote' | 'revoke';
    timestamp?: number;
  }>;
  /**
   * 往轮助手已发出的候选人可见回复（正序，最近在最后；条数与单条长度均截断）。
   *
   * evidence 只有回合作用域，而跨轮复述需要看到往轮已发送的回复。
   * 本字段专门向 reviewer 提供该信号，用于区分忠实复述与本轮新编造。
   *
   * ⚠️ 它不是工具证据：不进 evidence、不参与"证据是否为空"的判定（EVIDENCE_KEYS
   * 编译期穷尽断言强制了这一边界），只用于区分「跨轮复述」与「本轮新编造」；
   * 往轮表述本身的真假交跨轮编造治理。
   */
  recentAssistantMessages: string[];
  evidence: {
    jobList?: JobListEvidence;
    precheck?: PrecheckEvidence;
    booking?: BookingEvidence;
    geocode?: GeocodeEvidence;
    sentLocation?: SentLocationEvidence;
    groupInvite?: GroupInviteEvidence;
    visualFacts?: VisualFactsEvidence;
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
   * ground truth——没有它 reviewer 会把已接地的推荐误判成无证据。结构化 jobs 可用时不带，
   * 避免证据重复烧 token。
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

/**
 * 群邀请证据。当轮 `invite_to_group:ok` 能支撑「群邀请已发送」的完成态表述，
 * 因此必须纳入 evidence 字段集。
 */
export interface GroupInviteEvidence {
  success: boolean;
  groupName?: string;
  alreadyInGroup?: boolean;
  errorType?: string;
}

/**
 * 视觉事实证据。截图中落档的预约、岗位等事实可支撑助手回复，
 * reviewer 必须看到它们；否则会把有视觉证据的表述误判为零证据编造。
 *
 * ownership 必须原样带上：截图里的字段分候选人自陈与发布方标注两类，
 * 混为一谈正是"发布方品牌劫持"类误判的温床，reviewer 需要自行区分。
 */
export interface VisualFactsEvidence {
  sheets: Array<{
    kind: import('@resolution/signal/visual').VisualFactKind;
    /** vision 原始描述，截断防爆 packet。 */
    description?: string;
    fields: import('@resolution/signal/visual').FinalizedVisualFactField[];
  }>;
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
