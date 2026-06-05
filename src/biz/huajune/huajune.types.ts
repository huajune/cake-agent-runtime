/**
 * 花卷（huajune）招聘事件上报 Open API 契约类型。
 *
 * 端点：POST {HUAJUNE_API_BASE_URL}/api/v1/recruitment-events
 * 鉴权：Authorization: Bearer {HUAJUNE_API_TOKEN}
 * 必填：agentId、eventType、candidate.name；幂等：同 agentId+idempotencyKey → existing。
 */

export type HuajuneEventType =
  | 'message_received'
  | 'message_sent'
  | 'candidate_contacted'
  | 'wechat_exchanged'
  | 'interview_booked'
  | 'candidate_hired';

export type HuajuneSourcePlatform = 'zhipin' | 'yupao' | 'duliday';

export interface HuajuneCandidate {
  /** 候选人姓名（必填）。 */
  name: string;
  /** 职位；缺省时花卷用 job.jobName 组 candidateKey。 */
  position?: string;
  age?: string;
  gender?: string;
  education?: string;
  expectedSalary?: string;
  expectedLocation?: string;
}

export interface HuajuneJob {
  /** 外部岗位 ID（number）。 */
  jobId?: number;
  jobName?: string;
}

export interface HuajuneEvent {
  /** 外部事件唯一键；复用 ops_events idempotency_key 防重复。 */
  idempotencyKey?: string;
  /** Agent/账号标识：{manager_name}-cake-{index}。 */
  agentId: string;
  sourcePlatform?: HuajuneSourcePlatform;
  dataSource?: 'api_callback' | 'manual';
  eventType: HuajuneEventType;
  /** ISO 时间；不能晚于服务端当前 5min、不能早于 90 天。缺省=服务端当前。 */
  eventTime?: string;
  candidate: HuajuneCandidate;
  job?: HuajuneJob;
  brandId?: number;
  /** 每种 eventType 的事件详情（message_sent.content / interview_booked.interviewTime 必填）。 */
  details?: Record<string, unknown>;
}
