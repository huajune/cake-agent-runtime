import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import {
  computeFireAt,
  FOLLOW_UP_SCENARIOS,
  getScenario,
  inWindow,
  resolveRolloutEnabled,
  shouldStop,
} from '@agent/reengagement/follow-up-scheduler.service';

const baseState = (over: Partial<AuthoritativeSessionState> = {}): AuthoritativeSessionState => ({
  collectedFields: {},
  recalledJobIds: new Set<number>(),
  hardConstraints: [],
  presentedStores: [],
  stage: null,
  ...over,
});

// 某日 10:00 Shanghai = 02:00 UTC
const at = (utcHour: number, minute = 0): number => Date.UTC(2026, 5, 24, utcHour, minute, 0);

describe('scenario-registry', () => {
  describe('inWindow (9-21 Shanghai)', () => {
    it('true inside window, false outside', () => {
      expect(inWindow(at(2))).toBe(true); // 10:00 Shanghai
      expect(inWindow(at(11))).toBe(true); // 19:00 Shanghai
      expect(inWindow(at(13))).toBe(false); // 21:00 Shanghai (end exclusive)
      expect(inWindow(at(0))).toBe(false); // 08:00 Shanghai
      expect(inWindow(at(15))).toBe(false); // 23:00 Shanghai
    });
  });

  describe('computeFireAt window alignment', () => {
    const scenario = getScenario('opening_no_reply')!;

    it('keeps fireAt when inside window', () => {
      const anchorAt = at(2); // 10:00 Shanghai
      const fireAt = computeFireAt(scenario, { anchorAt, state: baseState() });
      // +15min still inside window
      expect(fireAt).toBe(anchorAt + 15 * 60_000);
    });

    it('pushes pre-9:00 fire to today 09:00 Shanghai', () => {
      const anchorAt = Date.UTC(2026, 5, 24, 0, 0, 0); // 08:00 Shanghai
      const fireAt = computeFireAt(scenario, { anchorAt, state: baseState() });
      // 09:00 Shanghai = 01:00 UTC same day
      expect(fireAt).toBe(Date.UTC(2026, 5, 24, 1, 0, 0));
    });

    it('pushes post-21:00 fire to next day 09:00 Shanghai', () => {
      const anchorAt = Date.UTC(2026, 5, 24, 14, 0, 0); // 22:00 Shanghai
      const fireAt = computeFireAt(scenario, { anchorAt, state: baseState() });
      expect(fireAt).toBe(Date.UTC(2026, 5, 25, 1, 0, 0)); // next day 09:00 Shanghai
    });
  });

  describe('shouldStop', () => {
    const scenario = getScenario('opening_no_reply')!;
    const anchorAt = 1_000_000;

    it('stops on terminal state', () => {
      const r = shouldStop(scenario, baseState({ terminal: 'booked' }), anchorAt);
      expect(r.stop).toBe(true);
      expect(r.reason).toContain('terminal');
    });

    it('allows booked booking.succeeded scenarios to run', () => {
      const s = getScenario('interview_reminder')!;
      const state = baseState({ terminal: 'booked', interviewAt: anchorAt + 3_600_000 } as never);
      const r = shouldStop(s, state, anchorAt);
      expect(r.stop).toBe(false);
    });

    it('allows handed_off booking.succeeded scenarios to run', () => {
      const s = getScenario('interview_reminder')!;
      const r = shouldStop(
        s,
        baseState({ terminal: 'handed_off', interviewAt: anchorAt + 3_600_000 } as never),
        anchorAt,
      );
      expect(r.stop).toBe(false);
    });

    it('stops booking follow-ups when there is no interview time', () => {
      const reminder = getScenario('interview_reminder')!;
      const followup = getScenario('post_interview_followup')!;

      expect(shouldStop(reminder, baseState({ terminal: 'booked' }), anchorAt)).toEqual({
        stop: true,
        reason: 'scenario_no_longer_holds',
      });
      expect(shouldStop(followup, baseState({ terminal: 'booked' }), anchorAt)).toEqual({
        stop: true,
        reason: 'scenario_no_longer_holds',
      });
    });

    it('still stops booking.succeeded scenarios on rejected terminal', () => {
      const s = getScenario('interview_reminder')!;
      const r = shouldStop(s, baseState({ terminal: 'rejected' }), anchorAt);
      expect(r.stop).toBe(true);
      expect(r.reason).toBe('terminal:rejected');
    });

    it('stops when candidate replied after anchor', () => {
      const r = shouldStop(scenario, baseState({ lastCandidateMessageAt: anchorAt + 1 }), anchorAt);
      expect(r.stop).toBe(true);
      expect(r.reason).toBe('candidate_replied_after_anchor');
    });

    it('exempts externally verifiable booking follow-ups from the replied rule', () => {
      // 报名后回一句"好的"不该杀掉面试提醒——带 workOrderId 的任务由到点核验判失效
      const s = getScenario('interview_reminder')!;
      const state = baseState({
        terminal: 'booked',
        lastCandidateMessageAt: anchorAt + 1,
        interviewAt: anchorAt + 3_600_000,
      } as never);
      expect(shouldStop(s, state, anchorAt, { externallyVerifiable: true }).stop).toBe(false);
    });

    it('keeps the replied rule for booking follow-ups without verification capability', () => {
      const s = getScenario('interview_reminder')!;
      const state = baseState({ terminal: 'booked', lastCandidateMessageAt: anchorAt + 1 });
      expect(shouldStop(s, state, anchorAt).stop).toBe(true);
      expect(shouldStop(s, state, anchorAt, { externallyVerifiable: false }).stop).toBe(true);
    });

    it('never exempts pre-booking scenarios from the replied rule', () => {
      const state = baseState({ lastCandidateMessageAt: anchorAt + 1 });
      const r = shouldStop(scenario, state, anchorAt, { externallyVerifiable: true });
      expect(r.stop).toBe(true);
      expect(r.reason).toBe('candidate_replied_after_anchor');
    });

    it('does not stop when scenario still holds and no reply', () => {
      const r = shouldStop(scenario, baseState({ lastCandidateMessageAt: anchorAt - 1 }), anchorAt);
      expect(r.stop).toBe(false);
    });

    it('address_missing has no scenario-specific stop; generic replied rule covers it', () => {
      const s = getScenario('address_missing')!;
      // 候选人发定位=一条入站消息 → 通用 candidate_replied_after_anchor 停发
      const replied = baseState({ lastCandidateMessageAt: anchorAt + 1 });
      expect(shouldStop(s, replied, anchorAt)).toEqual({
        stop: true,
        reason: 'candidate_replied_after_anchor',
      });
      expect(shouldStop(s, baseState(), anchorAt).stop).toBe(false);
    });

    it('booking_incomplete does not infer completion from a hard-coded field subset', () => {
      const s = getScenario('booking_incomplete')!;
      const complete = baseState({
        collectedFields: {
          name: { value: '王建国', provenance: 'user_text', at: 1 },
          phone: { value: '13800000000', provenance: 'user_text', at: 1 },
          age: { value: '28', provenance: 'user_text', at: 1 },
          gender: { value: '男', provenance: 'user_text', at: 1 },
        },
      });
      expect(shouldStop(s, complete, anchorAt).stop).toBe(false);
      expect(shouldStop(s, baseState(), anchorAt).stop).toBe(false);
    });
  });

  describe('rollout gating', () => {
    it('only event-anchored scenarios are rollout-enabled by default', () => {
      const enabled = FOLLOW_UP_SCENARIOS.filter((s) => s.defaultRolloutEnabled).map((s) => s.code);
      expect(enabled).toEqual(
        expect.arrayContaining(['opening_no_reply', 'booking_incomplete', 'interview_reminder']),
      );
      expect(enabled).not.toContain('new_job_for_waiting');
    });

    it('resolveRolloutEnabled falls back to defaults when config is empty', () => {
      expect(resolveRolloutEnabled(getScenario('opening_no_reply')!, {})).toBe(true);
      expect(resolveRolloutEnabled(getScenario('new_job_for_waiting')!, {})).toBe(false);
    });

    it('scenario map overrides the code default in both directions', () => {
      expect(
        resolveRolloutEnabled(getScenario('opening_no_reply')!, {
          reengagementScenarioRollout: { opening_no_reply: false },
        }),
      ).toBe(false);
      expect(
        resolveRolloutEnabled(getScenario('new_job_for_waiting')!, {
          reengagementScenarioRollout: { new_job_for_waiting: true },
        }),
      ).toBe(true);
    });

    it('post-booking master switch gates post-booking scenarios only', () => {
      const config = {
        reengagementPostBookingEnabled: false,
        reengagementScenarioRollout: { interview_reminder: true, opening_no_reply: true },
      };
      expect(resolveRolloutEnabled(getScenario('interview_reminder')!, config)).toBe(false);
      expect(resolveRolloutEnabled(getScenario('post_interview_followup')!, config)).toBe(false);
      // 报名前场景不受大开关影响
      expect(resolveRolloutEnabled(getScenario('opening_no_reply')!, config)).toBe(true);
    });

    it('missing post-booking switch is treated as open', () => {
      expect(resolveRolloutEnabled(getScenario('interview_reminder')!, {})).toBe(true);
    });
  });
});
