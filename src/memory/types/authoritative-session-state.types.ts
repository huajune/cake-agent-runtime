import type { SessionTerminalState } from './session-facts.types';
import type { CandidateCollectedField, CandidateFieldKey } from '@resolution/candidate/types';

// 信封唯一定义在 @resolution/candidate/types（§2.3 信封终态）；此处仅作存储侧别名转发，
// 供 memory/reengagement 既有消费者沿用旧名，不得在本文件重新定义字段形状。
export type { CandidateFieldKey };
export type CollectedField<T = string | number> = CandidateCollectedField<T>;

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
  terminal?: SessionTerminalState;
}
