import { detectOnlineInterviewLocationClaim } from '@agent/guardrail/output/rules/online-interview-location.rule';
import type { AgentToolCall } from '@shared-types/agent-telemetry.types';

/**
 * 线上面试却给到店指引（2026-07-30 连续第二天复发、当日 4 次）。
 *
 * 候选人会为一场线上面试白跑一趟门店。destination='store' 是最主要的假阳来源
 * ——候选人问"工作地点在哪"时发门店定位是正确行为，必须区分。
 */
describe('detectOnlineInterviewLocationClaim', () => {
  const loc = (result: Record<string, unknown>): AgentToolCall =>
    ({ toolName: 'send_store_location', status: 'ok', result }) as AgentToolCall;

  describe('命中：无需到店却给到店指引', () => {
    // 生产实证 6a69674e：实际是电话面试，回复却说"门店位置我发你了…门店在 1 层，别走错"。
    it('flags navigation guidance for a phone interview', () => {
      const hit = detectOnlineInterviewLocationClaim(
        '门店位置我发你了，点开就能看导航。门店在 1 层 1-51 号，别走错。',
        [loc({ success: true, destination: 'interview', interviewMethod: '电话面试' })],
      );
      expect(hit?.ruleId).toBe('online_interview_location_claim');
      expect(hit?.label).toContain('电话面试');
    });

    it('flags AI interview told to go to the store', () => {
      expect(
        detectOnlineInterviewLocationClaim('面试当天直接去店里面试就行。', [
          loc({ success: true, interviewMethod: 'AI 面试' }),
        ]),
      ).not.toBeNull();
    });

    it('flags video interview claiming the interview location was sent', () => {
      expect(
        detectOnlineInterviewLocationClaim('面试的定位发你了哈。', [
          loc({ success: true, interviewMethod: '视频面试' }),
        ]),
      ).not.toBeNull();
    });

    // interviewMethod 缺失但工具已明说无需到店时同样成立。
    it('flags on locationNotRequired even without interviewMethod', () => {
      expect(
        detectOnlineInterviewLocationClaim('点开就能看导航。', [
          loc({ success: true, locationNotRequired: true }),
        ]),
      ).not.toBeNull();
    });
  });

  describe('放行', () => {
    // 最主要的假阳来源：候选人问的是工作地点，不是面试地点。
    it('passes when destination=store (candidate asked where the job is)', () => {
      expect(
        detectOnlineInterviewLocationClaim('门店位置我发你了，点开就能看导航。', [
          loc({ success: true, destination: 'store', interviewMethod: 'AI 面试' }),
        ]),
      ).toBeNull();
    });

    it('passes for a genuine on-site interview', () => {
      expect(
        detectOnlineInterviewLocationClaim('面试的位置发你了，点开就能看导航。', [
          loc({ success: true, destination: 'interview', interviewMethod: '线下面试' }),
        ]),
      ).toBeNull();
    });

    // 线上初筛 + 线下复试：方式串同时含两种形态时保守放行，交语义审查。
    it('passes when the method mentions both online and offline stages', () => {
      expect(
        detectOnlineInterviewLocationClaim('面试的位置发你了。', [
          loc({ success: true, interviewMethod: '线上初筛后线下复试' }),
        ]),
      ).toBeNull();
    });

    it('passes when the reply gives no on-site guidance', () => {
      expect(
        detectOnlineInterviewLocationClaim(
          '这家是 AI 面试，链接会短信发到你手机上，按提示做完就行。',
          [loc({ success: true, interviewMethod: 'AI 面试' })],
        ),
      ).toBeNull();
    });

    it('passes when send_store_location was never called', () => {
      expect(detectOnlineInterviewLocationClaim('点开就能看导航。', [])).toBeNull();
    });
  });
});
