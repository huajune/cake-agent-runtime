export type FieldProvenance = 'user_text' | 'booking_writeback' | 'llm_extract' | 'model_arg';

export type CandidateFieldKey =
  | 'name'
  | 'phone'
  | 'age'
  | 'gender'
  | 'education'
  | 'healthCert'
  | 'householdProvince'
  | 'height'
  | 'weight'
  | 'supplementAnswers';

export interface CollectedField<T = string> {
  value: T;
  provenance: FieldProvenance;
  evidence?: string;
  at: number;
}

export interface PresentedStore {
  storeId?: number | string;
  jobId: number;
  presentedAt?: number;
}

export interface AuthoritativeSessionState {
  collectedFields: Partial<Record<CandidateFieldKey, CollectedField>>;
  recalledJobIds: Set<number>;
  hardConstraints: Array<{
    kind: 'shift' | 'duration' | 'location' | 'household' | 'other';
    value: string;
    source: 'candidate' | 'precheck';
  }>;
  presentedStores: PresentedStore[];
  /** 本会话已成功邀请/核验在群的记录；复聊到点核验据此停止推店未回。 */
  invitedGroups?: Array<{
    groupName: string;
    city: string;
    industry?: string;
    invitedAt: string;
  }>;
  stage: string | null;
  lastCandidateMessageAt?: number;
  /**
   * 已被系统成功处理（正常回复或有意沉默）的候选人消息时间水位。
   * lastCandidateMessageAt 在入站接收层就写入，timeout 静默丢弃的消息也会计入；
   * 复聊停止判定须比对此水位，才能区分「已回话且被回应」与「回话被静默吞掉」。
   */
  lastProcessedCandidateMessageAt?: number;
  terminal?: 'booked' | 'handed_off' | 'rejected' | 'onboarded';
}
