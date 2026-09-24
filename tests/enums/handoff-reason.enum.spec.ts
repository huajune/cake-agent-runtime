import {
  HANDOFF_REASON_CATALOG,
  HANDOFF_REASON_CODES,
  HANDOFF_REASON_LABELS,
  MANUAL_RESUME_HANDOFF_REASON_CODES,
  STORE_NO_SHOW_REASON_CODES,
  URGENT_HANDOFF_REASON_CODES,
  getHandoffReasonLabel,
  isUrgentHandoff,
  isUrgentHandoffReason,
  requiresManualResumeForReason,
  resolveHandoffTaskCategory,
} from '@enums/handoff-reason.enum';
import { INPUT_RISK_TYPES } from '@shared-types/guardrail.contract';

/**
 * 原因码权威目录（PRD R5.2）：所有消费方（工具枚举 / 卡片标急 / 永久暂停 / 标签表）
 * 都从这一份派生，这里锁定目录本身的不变式与新码的三项属性。
 */
describe('handoff-reason catalog', () => {
  it('codes are unique and every code has a non-empty label', () => {
    const codes = HANDOFF_REASON_CATALOG.map((item) => item.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const item of HANDOFF_REASON_CATALOG) {
      expect(HANDOFF_REASON_LABELS[item.code]).toBe(item.label);
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('tool-selectable codes keep the legacy 15 codes plus the 7 new ones, other last', () => {
    expect(HANDOFF_REASON_CODES).toEqual(
      expect.arrayContaining([
        'cannot_find_store',
        'no_reception',
        'booking_conflict',
        'onboarding_paperwork',
        'interview_result_inquiry',
        'modify_appointment',
        'self_recruited_or_completed',
        'no_match_or_group_full',
        'system_blocked',
        'booking_capacity_full',
        'group_invite_failed',
        'salary_admin_inquiry',
        'interview_slot_coordination',
        'identity_age_exception',
        'store_no_show',
        'out_of_band_booking_inquiry',
        'store_hiring_status_check',
        'duplicate_signup',
        'employment_affairs',
        'personal_pay_attendance',
        'platform_operation',
        'other',
      ]),
    );
    expect(HANDOFF_REASON_CODES).toHaveLength(22);
    expect(HANDOFF_REASON_CODES[HANDOFF_REASON_CODES.length - 1]).toBe('other');
  });

  it('system-only codes are not selectable by the model but still labelled', () => {
    for (const code of [
      'interview_group_invite_required',
      'onboarding_failed',
      'onboarding_follow_up_required',
    ]) {
      expect(HANDOFF_REASON_CODES).not.toContain(code);
      expect(HANDOFF_REASON_LABELS[code]).toEqual(expect.stringMatching(/\S/));
    }
  });

  it('every input risk type is a catalog code so inbound handoffs can be recorded', () => {
    for (const riskType of INPUT_RISK_TYPES) {
      expect(HANDOFF_REASON_LABELS[riskType]).toEqual(expect.stringMatching(/\S/));
      expect(resolveHandoffTaskCategory(riskType)).toBe(
        riskType === 'interview_result_inquiry' ? 'T3' : 'T7',
      );
    }
    expect(HANDOFF_REASON_LABELS.escalation).toEqual(expect.stringMatching(/\S/));
  });

  it('urgent set: legacy urgent codes + cannot_find_store + new store_no_show / out_of_band', () => {
    for (const code of [
      'modify_appointment',
      'no_reception',
      'booking_conflict',
      'interview_group_invite_required',
      'cannot_find_store',
      'store_no_show',
      'out_of_band_booking_inquiry',
    ]) {
      expect(URGENT_HANDOFF_REASON_CODES.has(code)).toBe(true);
      expect(isUrgentHandoffReason(code)).toBe(true);
    }
    expect(isUrgentHandoffReason('salary_admin_inquiry')).toBe(false);
    expect(isUrgentHandoffReason(undefined)).toBe(false);
  });

  it('isUrgentHandoff: urgent codes stay urgent; employment_affairs escalates only on work-injury reason', () => {
    expect(isUrgentHandoff('modify_appointment')).toBe(true);
    expect(isUrgentHandoff('modify_appointment', '')).toBe(true);
    expect(isUrgentHandoff('employment_affairs', '候选人说上班工伤了')).toBe(true);
    expect(isUrgentHandoff('employment_affairs', '问离职手续')).toBe(false);
    expect(isUrgentHandoff('employment_affairs')).toBe(false);
    expect(isUrgentHandoff('employment_affairs', null)).toBe(false);
    // 工伤词只对在职事务升急，其他非急码不因 reason 文本升急
    expect(isUrgentHandoff('salary_admin_inquiry', '工伤')).toBe(false);
    expect(isUrgentHandoff(undefined, '工伤')).toBe(false);
  });

  it('risk-type labels are the single source for input catalog and raise_risk_alert wording', () => {
    expect(HANDOFF_REASON_LABELS.abuse).toBe('辱骂/攻击');
    expect(HANDOFF_REASON_LABELS.complaint_risk).toBe('投诉/举报风险');
    expect(HANDOFF_REASON_LABELS.escalation).toBe('情绪升级');
    expect(HANDOFF_REASON_LABELS.interview_result_inquiry).toBe('面试结果追问');
    expect(HANDOFF_REASON_LABELS.human_handoff_request).toBe('候选人主动要求人工');
    expect(HANDOFF_REASON_LABELS.disability_disclosure).toBe('候选人披露残障身份');
  });

  it('manual-resume set: three post-interview codes + employment_affairs; onboarding_follow_up does not pause', () => {
    expect([...MANUAL_RESUME_HANDOFF_REASON_CODES].sort()).toEqual(
      [
        'employment_affairs',
        'interview_result_inquiry',
        'onboarding_paperwork',
        'self_recruited_or_completed',
      ].sort(),
    );
    expect(requiresManualResumeForReason('onboarding_follow_up_required')).toBe(false);
    expect(requiresManualResumeForReason(null)).toBe(false);
  });

  it('maps new codes to their PRD task categories', () => {
    expect(resolveHandoffTaskCategory('store_no_show')).toBe('T1');
    expect(resolveHandoffTaskCategory('out_of_band_booking_inquiry')).toBe('T2');
    expect(resolveHandoffTaskCategory('store_hiring_status_check')).toBe('T2');
    expect(resolveHandoffTaskCategory('duplicate_signup')).toBe('T2');
    expect(resolveHandoffTaskCategory('employment_affairs')).toBe('T3');
    expect(resolveHandoffTaskCategory('personal_pay_attendance')).toBe('T4');
    expect(resolveHandoffTaskCategory('salary_admin_inquiry')).toBe('T5');
    expect(resolveHandoffTaskCategory('platform_operation')).toBe('T8');
    expect(resolveHandoffTaskCategory('other')).toBeNull();
    expect(resolveHandoffTaskCategory('unknown_code')).toBeNull();
  });

  it('store no-show leaderboard codes all exist in the catalog', () => {
    for (const code of STORE_NO_SHOW_REASON_CODES) {
      expect(HANDOFF_REASON_LABELS[code]).toEqual(expect.stringMatching(/\S/));
    }
  });

  it('label lookup falls back to the provided fallback, then the code itself', () => {
    expect(getHandoffReasonLabel('no_reception')).toBe('到店无人接待');
    expect(getHandoffReasonLabel('legacy_code', '旧码')).toBe('旧码');
    expect(getHandoffReasonLabel('legacy_code')).toBe('legacy_code');
  });
});
