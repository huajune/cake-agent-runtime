import { ProactiveComposerService } from '@agent/reengagement/proactive-composer.service';
import { getScenario } from '@agent/reengagement/scenario-registry';
import type { FollowUpJob } from '@agent/reengagement/reengagement.types';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';

const sessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'sess-1' };

const baseState = (over: Partial<AuthoritativeSessionState> = {}): AuthoritativeSessionState => ({
  collectedFields: {},
  recalledJobIds: new Set<number>(),
  hardConstraints: [],
  presentedStores: [],
  stage: null,
  ...over,
});

const job = (scenarioCode: FollowUpJob['scenarioCode'], over: Partial<FollowUpJob> = {}) =>
  ({
    sessionRef,
    scenarioCode,
    anchorEventId: 'evt-1',
    anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
    ...over,
  }) as FollowUpJob;

describe('ProactiveComposerService', () => {
  let llm: { generate: jest.Mock };
  let memory: { recallForProactiveFollowUp: jest.Mock };
  let longTerm: { getActiveBookings: jest.Mock };
  let composer: ProactiveComposerService;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 2, 0, 0));
    llm = {
      generate: jest.fn().mockResolvedValue({
        text: '你方便发下位置吗？我帮你就近看看。',
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
        response: { messages: [{ role: 'assistant', content: 'ok' }] },
      }),
    };
    memory = {
      recallForProactiveFollowUp: jest.fn().mockResolvedValue({
        factLines: ['姓名：张三'],
        recentMessages: [
          {
            role: 'assistant',
            content: '你在哪个地铁站附近呀？',
          },
        ],
      }),
    };
    longTerm = { getActiveBookings: jest.fn().mockResolvedValue([]) };
    composer = new ProactiveComposerService(llm as never, memory as never, longTerm as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds interview reminders from deterministic template facts', async () => {
    longTerm.getActiveBookings.mockResolvedValue([
      {
        work_order_id: 555,
        linked_at: '2026-06-24T10:00:00+08:00',
        interview_time: '2026-06-25 14:00',
        store_name: '绿地缤纷城店',
      },
    ]);

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', {
        workOrderId: 555,
        expectedInterviewAt: Date.UTC(2026, 5, 25, 6, 0, 0),
      }),
      state: baseState({ terminal: 'booked' }),
    });

    expect(llm.generate).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toContain('6月25日 14:00');
    expect(result.outcome.reply?.text).toContain('绿地缤纷城店');
    expect(result.outcome.reply?.text).toContain('身份证');
  });

  it('uses LLM for booking_incomplete instead of hard-coding missing fields', async () => {
    llm.generate.mockResolvedValue({
      text: '还差一些报名资料，你方便继续补充一下吗？我这边好接着看。',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete'),
      state: baseState({
        collectedFields: {
          name: { value: '张三', provenance: 'user_text', at: Date.now() },
        },
      }),
    });

    expect(llm.generate).toHaveBeenCalled();
    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe(
      '还差一些报名资料，你方便继续补充一下吗？我这边好接着看。',
    );
    expect(llm.generate.mock.calls[0][0].messages[0].content).toContain('当前已识别资料字段: 姓名');
    expect(llm.generate.mock.calls[0][0].system).not.toContain('硬约束');
  });

  it('uses a single no-tool LLM call with sanitized recent history for light scenarios', async () => {
    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
      messageId: 'batch-1',
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe('你方便发下位置吗？我帮你就近看看。');
    expect(memory.recallForProactiveFollowUp).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1', {
      recentLimit: 10,
    });
    expect(llm.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.not.stringContaining('消息发送时间'),
          }),
        ],
      }),
    );
    expect(llm.generate.mock.calls[0][0]).not.toHaveProperty('tools');
  });

  it('normalizes old brand names through the shared sanitizer', async () => {
    llm.generate.mockResolvedValue({
      text: '我是独立日招聘顾问，想问下你还在找工作吗？',
      usage: {},
    });

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('opening_no_reply')!,
      jobData: job('opening_no_reply'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toContain('独立客');
    expect(result.outcome.reply?.text).not.toContain('独立日');
  });

  it('skips completion-tense side-effect promises without tool evidence', async () => {
    llm.generate.mockResolvedValue({ text: '已经帮你预约好了，明天直接去面试就行。', usage: {} });

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('opening_no_reply')!,
      jobData: job('opening_no_reply'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('composer_false_promise');
  });

  it('skips address_missing when the generated text lacks the expected ask', async () => {
    llm.generate.mockResolvedValue({ text: '你还在考虑吗？', usage: {} });

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('composer_missing_expected_ask');
  });

  it('skips leaked or overlong generated text', async () => {
    llm.generate.mockResolvedValue({ text: '✅ 对话已完成，符合信任建立阶段要求。', usage: {} });

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('opening_no_reply')!,
      jobData: job('opening_no_reply'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('composer_validation_failed');
  });

  it('skips job dump details such as salary or shift terms', async () => {
    llm.generate.mockResolvedValue({ text: '附近有店员岗位，25元/小时，晚班可选。', usage: {} });

    const result = await composer.compose({
      sessionRef,
      scenario: getScenario('opening_no_reply')!,
      jobData: job('opening_no_reply'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('composer_forbidden_job_detail');
  });
});
