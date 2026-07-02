import { Injectable, Optional } from '@nestjs/common';
import {
  RiskInterceptService,
  type PreAgentRiskPrecheckResult,
  type RiskInterceptEvaluation,
  type RiskInterceptInput,
} from './risk-intercept.service';
import type { InputGuardrailDecision, InputGuardrailRequest } from './types';

/**
 * Input guardrail 编排入口。
 *
 * 这里不放具体检测规则；高置信业务风险由 RiskInterceptService 负责，
 * prompt injection 由 PromptInjectionService 在 preparation 阶段处理。
 */
@Injectable()
export class InputGuardrailService {
  constructor(@Optional() private readonly riskIntercept?: RiskInterceptService) {}

  async evaluate(input: InputGuardrailRequest): Promise<InputGuardrailDecision> {
    const risk = await this.evaluateInputRisk(input);
    if (!risk.hit) {
      return { decision: 'pass' };
    }

    return {
      decision: 'block',
      source: 'input_risk',
      disposition: 'side_effects',
      reasonCode: risk.riskType ?? 'input_risk',
      riskType: risk.riskType,
      riskLabel: risk.label,
      reason: risk.reason,
      inspectedText: input.scanContent,
      sideEffects: risk.sideEffect ? [risk.sideEffect] : [],
    };
  }

  async evaluateInputRisk(input: RiskInterceptInput): Promise<RiskInterceptEvaluation> {
    if (!this.riskIntercept) {
      return { hit: false };
    }
    return this.riskIntercept.evaluate(input);
  }

  async precheckInputRisk(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    const evaluation = await this.evaluateInputRisk(input);
    if (!evaluation.hit) {
      return { hit: false };
    }
    return {
      hit: true,
      riskType: evaluation.riskType,
      reason: evaluation.reason,
      label: evaluation.label,
    };
  }
}
