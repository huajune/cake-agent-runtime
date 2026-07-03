import {
  GUARDRAIL_DECISION,
  type InputDecision,
  type InputRiskType,
} from '@shared-types/guardrail.contract';
import type { TurnSideEffectIntent } from '@agent/runner/turn-side-effect.types';

export interface InputGuardrailRequest {
  corpId: string;
  chatId: string;
  userId: string;
  pauseTargetId: string;
  scanContent: string;
  messageId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
}

export type InputGuardrailDecision =
  | {
      decision: Extract<InputDecision, typeof GUARDRAIL_DECISION.PASS>;
    }
  | {
      decision: Extract<InputDecision, typeof GUARDRAIL_DECISION.BLOCK>;
      source: 'input_risk';
      disposition: 'side_effects';
      reasonCode: string;
      reason?: string;
      riskType?: InputRiskType;
      riskLabel?: string;
      inspectedText: string;
      sideEffects: TurnSideEffectIntent[];
    };
