import type { AgentMemorySnapshot, AgentToolCall } from '@/types/agent-telemetry.types';
import { detectJobDetailLookupRequired } from '@agent/guardrail/output/rules/job-detail-grounding.rule';
import { GUARDRAIL_ACTION } from '@/types/guardrail.contract';

const snapshot = (partial: Partial<AgentMemorySnapshot>): AgentMemorySnapshot => ({
  currentStage: null,
  presentedJobIds: null,
  recommendedJobIds: null,
  sessionFacts: null,
  profileKeys: null,
  ...partial,
});

const jobListLookup = (jobId: number): AgentToolCall => ({
  toolName: 'duliday_job_list',
  args: { jobIdList: [jobId] },
  status: 'ok',
});

describe('job-detail-grounding.rule', () => {
  describe('唯一已展示岗位、焦点未锁定（badcase chat 6a62c6f8：兼职说成全职、周结说成月结）', () => {
    const singlePresented = snapshot({ presentedJobIds: [528527] });

    it('replans when employment is asked without a jobId lookup（"兼职还是全职的"零工具作答）', () => {
      const verdict = detectJobDetailLookupRequired([], singlePresented, '兼职还是全职的');
      expect(verdict?.action).toBe(GUARDRAIL_ACTION.REPLAN);
      expect(verdict?.ruleId).toBe('job_detail_lookup_required');
      expect(verdict?.label).toContain('jobId=528527');
      expect(verdict?.label).toContain('employment');
    });

    it('replans when settlement is asked without a jobId lookup', () => {
      const verdict = detectJobDetailLookupRequired([], singlePresented, '是周结还是月结呀');
      expect(verdict?.action).toBe(GUARDRAIL_ACTION.REPLAN);
      expect(verdict?.label).toContain('settlement');
    });

    it('passes when the turn already looked up the presented job by jobId', () => {
      expect(
        detectJobDetailLookupRequired([jobListLookup(528527)], singlePresented, '兼职还是全职的'),
      ).toBeNull();
    });

    it('passes when the user message contains no detail inquiry', () => {
      expect(detectJobDetailLookupRequired([], singlePresented, '好的谢谢')).toBeNull();
    });
  });

  describe('多岗已展示、焦点未锁定（既有行为回归）', () => {
    const multiPresented = snapshot({ presentedJobIds: [1, 2] });

    it('only observes shift inquiries', () => {
      const verdict = detectJobDetailLookupRequired([], multiPresented, '几点上班呀');
      expect(verdict?.action).toBe(GUARDRAIL_ACTION.OBSERVE);
    });

    it('still passes employment inquiries through', () => {
      expect(detectJobDetailLookupRequired([], multiPresented, '兼职还是全职的')).toBeNull();
    });
  });

  it('passes when nothing has been presented at all', () => {
    expect(
      detectJobDetailLookupRequired([], snapshot({ presentedJobIds: [] }), '兼职还是全职的'),
    ).toBeNull();
  });
});
