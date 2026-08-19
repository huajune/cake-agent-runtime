import type { AgentToolCall } from '@agent/generator/generator.types';
import { detectDanglingReplyPromise } from '@agent/guardrail/output/rules/dangling-promise.rule';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

const jobListCall = { toolName: 'duliday_job_list', result: {} } as unknown as AgentToolCall;

describe('detectDanglingReplyPromise', () => {
  describe('2026-07-29 日报 L1 实证的两条真悬空', () => {
    it('"我先帮你查下…稍等哈"独立成句且无下文时命中', () => {
      const hit = detectDanglingReplyPromise('我先帮你查下汽车北站附近的岗位，稍等哈');
      expect(hit?.ruleId).toBe('dangling_reply_promise');
      expect(hit?.action).toBe(GUARDRAIL_ACTION.OBSERVE);
    });

    it('命中时在 label 里标出本轮有没有查过岗，便于事后定性', () => {
      expect(detectDanglingReplyPromise('我帮你查下附近的岗位')?.label).toContain(
        '本轮未调用 duliday_job_list',
      );
      expect(detectDanglingReplyPromise('我帮你查下附近的岗位', [jobListCall])?.label).toContain(
        '结果未落入回复',
      );
    });
  });

  describe('不误杀（判据刻意保守，与 runner 侧同一谓词）', () => {
    it('已经给出结果的回复不算悬空', () => {
      expect(detectDanglingReplyPromise('帮你查了下，附近有 3 家在招，时薪 22 元')).toBeNull();
    });

    it('如实说没查到的不算悬空', () => {
      expect(detectDanglingReplyPromise('暂时没查到你附近的在招岗位')).toBeNull();
    });

    it('反问收集信息的不算悬空', () => {
      expect(detectDanglingReplyPromise('方便说下你在哪个区吗')).toBeNull();
    });

    it('祈使句"你先看一下"不是承诺，不命中', () => {
      expect(detectDanglingReplyPromise('你先看一下上面的岗位介绍')).toBeNull();
    });

    it('长回复默认视为带实质内容，不参与判定', () => {
      const longReply = `我帮你查下附近的岗位${'，另外这家门店的班次安排是早晚轮班'.repeat(3)}`;
      expect(detectDanglingReplyPromise(longReply)).toBeNull();
    });
  });
});
