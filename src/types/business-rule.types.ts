/** Audit linkage only. Runtime policy continues to live with its consumer. */
export type BusinessRuleTopic = 'IB' | 'SW' | 'ID' | 'SH' | 'GEO' | 'GP' | 'HO';
export type BusinessRuleId = `${BusinessRuleTopic}-${number}`;

export interface BusinessRuleLink {
  /** null is reserved for mechanisms that do not decide recruiting policy. */
  businessRule: BusinessRuleId | null;
  mechanismReason?: string;
}
