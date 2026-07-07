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
  stage: string | null;
  lastCandidateMessageAt?: number;
  terminal?: 'booked' | 'handed_off' | 'rejected' | 'onboarded';
}
