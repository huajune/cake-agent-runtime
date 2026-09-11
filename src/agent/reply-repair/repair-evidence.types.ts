/** 回复修复专用的工具与视觉证据投影；保留既有 packet 形状，具体 Prompt 由 ReplyRepairAgent 渲染。 */
export interface RepairEvidencePacket {
  draftReply: string;
  latestUserMessages: Array<{
    role: 'user';
    content: string;
    messageType: 'text' | 'image' | 'emotion' | 'quote' | 'revoke';
    timestamp?: number;
  }>;
  /**
   * 往轮助手已发出的候选人可见回复（正序，最近在最后；条数与单条长度均截断）。
   * 保留已有 packet 字段，它不属于工具 evidence；目前修复 Agent 的对话历史另走 messages。
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
   * 事实依据。结构化 jobs 可用时不带，避免重复传入证据。
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
  /** 工具回执的一句话结论（`_outcome`），失败/查重时说明本轮到底发生了什么。 */
  outcome?: string;
  /** 命中在途工单查重：预约已存在、本轮未重复提交（不是失败）。 */
  alreadyBooked?: boolean;
  existingWorkOrderId?: number | string;
  existingInterviewTimeHuman?: string;
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
 * 视觉事实证据：保留截图中落档的预约、岗位等事实。
 * ownership 原样保留，用于区分候选人自陈与发布方标注。
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
