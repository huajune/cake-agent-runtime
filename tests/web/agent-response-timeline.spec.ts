import { buildAgentResponseTimeline } from '../../web/src/view/message-processing/list/components/MessageProcessingDetailDrawer/agent-response-timeline';

describe('buildAgentResponseTimeline', () => {
  it('renders every step as reasoning then tool, followed by the authoritative final reply', () => {
    const parts = buildAgentResponseTimeline({
      steps: [
        {
          stepIndex: 0,
          reasoning: '先做预约预检',
          toolCalls: [
            {
              toolName: 'duliday_interview_precheck',
              args: { jobId: 528411 },
              result: { nextAction: 'ready_to_book' },
              status: 'ok',
            },
          ],
        },
        {
          stepIndex: 1,
          reasoning: '预检通过，提交预约',
          toolCalls: [
            {
              toolName: 'duliday_interview_booking',
              args: { jobId: 528411 },
              result: { success: true },
              status: 'ok',
            },
          ],
        },
        {
          stepIndex: 2,
          reasoning: '预约成功，组织最终回复',
          toolCalls: [],
        },
      ],
      finalReasoning: '预约成功，组织最终回复',
      finalText: '资料收到，已经帮你约好了',
    });

    expect(parts.map((part) => part.type)).toEqual([
      'reasoning',
      'tool-duliday_interview_precheck',
      'reasoning',
      'tool-duliday_interview_booking',
      'reasoning',
      'text',
    ]);
    expect(parts.at(-1)).toEqual({
      type: 'text',
      text: '资料收到，已经帮你约好了',
    });
  });

  it('normalizes AI SDK text-before-reasoning responses for historical records', () => {
    const parts = buildAgentResponseTimeline({
      responseParts: [
        { type: 'text', text: '模型原始文本' },
        { type: 'reasoning', text: '最后一步思考' },
      ],
      directToolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { jobId: 528411 },
          result: { success: true },
          status: 'ok',
        },
      ],
      finalReasoning: '最后一步思考',
      finalText: '实际下发文本',
    });

    expect(parts.map((part) => part.type)).toEqual([
      'tool-duliday_interview_booking',
      'reasoning',
      'text',
    ]);
    expect(parts.at(-1)).toEqual({ type: 'text', text: '实际下发文本' });
    expect(parts).not.toContainEqual({ type: 'text', text: '模型原始文本' });
  });

  it('keeps response text as the final fallback when no authoritative reply exists', () => {
    const parts = buildAgentResponseTimeline({
      responseParts: [
        { type: 'text', text: '历史回复' },
        { type: 'reasoning', text: '历史思考' },
      ],
    });

    expect(parts).toEqual([
      { type: 'reasoning', text: '历史思考' },
      { type: 'text', text: '历史回复' },
    ]);
  });
});
