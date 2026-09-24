import { TurnOutcomeInterventionService } from '@agent/runner/turn-outcome-intervention.service';
import type { TurnOutcome } from '@agent/runner/agent-runner.types';

/**
 * Outcome 统一提交出口：PRD R5.2「入站风险类、报名失败类介入落 handoff_events 底账」。
 */
describe('TurnOutcomeInterventionService', () => {
  const interventionService = { dispatch: jest.fn() };
  const handoffRecorder = { record: jest.fn() };
  const context = {
    traceId: 'batch-1',
    chatId: 'chat-1',
    userId: 'user-1',
    corpId: 'corp-1',
    contactName: '张三',
    botImId: 'bot-im-1',
    botUserId: 'manager-1',
    userMessage: '你们就是骗子',
  };

  let service: TurnOutcomeInterventionService;

  beforeEach(() => {
    jest.clearAllMocks();
    handoffRecorder.record.mockResolvedValue('inserted');
    interventionService.dispatch.mockResolvedValue({
      dispatched: true,
      paused: true,
      alerted: true,
    });
    service = new TurnOutcomeInterventionService(
      interventionService as never,
      handoffRecorder as never,
    );
  });

  describe('入站风险类（conversation_risk）落底账', () => {
    const inboundOutcome: TurnOutcome = {
      kind: 'handoff',
      toolCalls: [],
      guardrail: { phase: 'inbound', source: 'input_guardrail', riskType: 'abuse' },
      sideEffects: [
        {
          kind: 'conversation_risk',
          source: 'regex_intercept',
          riskType: 'abuse',
          riskLabel: '辱骂/攻击',
          summary: '候选人消息命中高置信度风险关键词',
          reason: '命中辱骂关键词',
        },
      ],
    };

    it('records handoff_events with the risk type as reason code and input_guardrail origin, then dispatches', async () => {
      await service.commit(inboundOutcome, context);

      expect(handoffRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          corpId: 'corp-1',
          chatId: 'chat-1',
          userId: 'user-1',
          reasonCode: 'abuse',
          reason: '命中辱骂关键词',
          actionAdvice: '候选人消息命中高置信度风险关键词',
          origin: 'input_guardrail',
          botImId: 'bot-im-1',
          idempotencyKey: 'chat-1:handoff:batch-1:input_risk',
        }),
      );
      expect(interventionService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'conversation_risk', riskType: 'abuse' }),
      );
      expect(handoffRecorder.record.mock.invocationCallOrder[0]).toBeLessThan(
        interventionService.dispatch.mock.invocationCallOrder[0],
      );
    });

    it('marks raise_risk_alert (agent_tool) risks with risk_alert_tool origin', async () => {
      await service.commit(
        {
          ...inboundOutcome,
          kind: 'reply',
          reply: { text: '我理解你的着急' },
          sideEffects: [
            {
              kind: 'conversation_risk',
              source: 'agent_tool',
              riskType: 'escalation',
              riskLabel: '情绪升级',
              summary: '候选人情绪升级',
              reason: '连续催促并威胁投诉',
            },
          ],
        },
        context,
      );
      expect(handoffRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ reasonCode: 'escalation', origin: 'risk_alert_tool' }),
      );
    });

    it('duplicate 底账写入 → 不再重复暂停/告警', async () => {
      handoffRecorder.record.mockResolvedValueOnce('duplicate');
      await service.commit(inboundOutcome, context);
      expect(interventionService.dispatch).not.toHaveBeenCalled();
    });

    it('底账写入失败 → fail-safe 仍执行暂停/告警', async () => {
      handoffRecorder.record.mockResolvedValueOnce('failed');
      await service.commit(inboundOutcome, context);
      expect(interventionService.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('报名失败类（recordOnly）只落底账', () => {
    it('records with booking_failure origin and never dispatches', async () => {
      await service.commit(
        {
          kind: 'reply',
          reply: { text: '这边暂时提交不了，稍后同事联系你' },
          toolCalls: [],
          sideEffects: [
            {
              kind: 'general_handoff',
              source: 'agent_tool',
              origin: 'booking_failure',
              alertLabel: '重复报名核实',
              reasonCode: 'duplicate_signup',
              reason: '报名提交失败（booking.rejected：用户已报名该岗位或品牌）',
              jobId: 528546,
              stage: 'interview_booking',
              idempotencyKey: 'chat-1:booking_failed:528546:wait_notice',
              recordHandoff: true,
              recordOnly: true,
            },
          ],
        },
        context,
      );

      expect(handoffRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'duplicate_signup',
          origin: 'booking_failure',
          jobId: 528546,
          stage: 'interview_booking',
          idempotencyKey: 'chat-1:booking_failed:528546:wait_notice',
        }),
      );
      expect(interventionService.dispatch).not.toHaveBeenCalled();
    });
  });

  it('general_handoff without explicit origin defaults by source (agent_tool / output_guardrail)', async () => {
    await service.commit(
      {
        kind: 'handoff',
        toolCalls: [],
        sideEffects: [
          {
            kind: 'general_handoff',
            source: 'output_guardrail',
            alertLabel: '出站守卫拦截',
            reasonCode: 'system_blocked',
            reason: '出站守卫拦截',
            idempotencyKey: 'chat-1:handoff:batch-1:output_guard',
            recordHandoff: true,
          },
        ],
      },
      context,
    );
    expect(handoffRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'output_guardrail' }),
    );
    expect(interventionService.dispatch).toHaveBeenCalledTimes(1);
  });
});
