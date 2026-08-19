import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import type { CorpusBlock } from '@shared-types/corpus.types';
import { createToolContext } from '../../helpers/tool-context.fixture';

const TIME_SUFFIX = '[消息发送时间：2026-08-13 10:20:30]';
const TEACHING_DIRECTIVE =
  '请重写被拦截草稿，不要复述规则。\n' +
  '姓名：张三\n联系电话：13900000002\n' +
  '[图片消息]\n[引用 招聘顾问：请核对资料]\n' +
  TIME_SUFFIX;

const teachingTransport = { role: 'user', content: TEACHING_DIRECTIVE };
const assistantPrompt = {
  role: 'assistant',
  content: `门店登记需要本名和联系电话，可以发我吗？\n${TIME_SUFFIX}`,
};
const imageReply = { role: 'user', content: `[图片消息]\n${TIME_SUFFIX}` };

function blocksFor(messages: Array<{ role: string; content: string }>): CorpusBlock[] {
  return [
    { id: 'revise-1', domain: 'teaching', role: 'system', content: TEACHING_DIRECTIVE },
    ...messages.map((message, index) => ({
      id: `evidence-${index}`,
      domain: 'evidence' as const,
      role: message.role as 'user' | 'assistant',
      content: message.content,
    })),
  ];
}

describe('booking identity 闸门 corpus 证据域隔离', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
    bookInterview: jest.fn(),
    uploadAttachmentFromUrl: jest.fn(),
    getCachedWorkOrderById: jest.fn().mockResolvedValue(null),
  };

  const validInput = {
    name: '张三',
    phone: '13900000002',
    age: 25,
    genderId: 1,
    jobId: 100,
    interviewTime: '2026-08-15 14:00:00',
    operateType: 6,
    hasHealthCertificate: 1,
    prechecked: { nextAction: 'ready_to_book' as const, missingFieldsCount: 0 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpongeService.getCachedWorkOrderById.mockResolvedValue(null);
    mockSpongeService.bookInterview.mockResolvedValue({ success: true, data: { id: 777 } });
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          basicInfo: { jobId: 100, brandName: 'KFC', jobName: '服务员', storeInfo: {} },
          hiringRequirement: {
            basicPersonalRequirements: { minAge: 18, maxAge: 45, genderRequirement: '不限' },
            certificate: {},
          },
          interviewProcess: { firstInterview: {}, interviewSupplement: [] },
        },
      ],
    });
  });

  const run = async (
    messages: Array<{ role: string; content: string }>,
    corpusBlocks?: CorpusBlock[],
  ) => {
    const context = createToolContext({
      session: { userId: 'user-1', corpId: 'corp-1', sessionId: 'sess-1' },
      archive: { isRecalledJobId: () => true, recalledJobIds: [100] },
      turnInput: {
        messages,
        ...(corpusBlocks ? { corpusBlocks } : {}),
      },
    });
    const tool = buildInterviewBookingTool(
      mockSpongeService as never,
      { notifyInterviewBookingResult: jest.fn().mockResolvedValue(true) } as never,
      { pauseUser: jest.fn().mockResolvedValue(undefined) } as never,
      {
        writeFromBooking: jest.fn().mockResolvedValue(undefined),
        setActiveBooking: jest.fn().mockResolvedValue(undefined),

        getActiveBookings: jest.fn().mockResolvedValue([]),
      } as never,
      { recordEvent: jest.fn().mockResolvedValue(undefined) } as never,
    )(context);
    return (await tool.execute(validInput, {
      toolCallId: 't',
      context: {},
      messages: [],
      abortSignal: undefined as never,
    })) as Record<string, unknown>;
  };

  it('teaching 内结构化姓名不能压过 evidence 内打招呼语昵称', async () => {
    const evidence = [
      { role: 'user', content: `我是张三\n${TIME_SUFFIX}` },
      assistantPrompt,
      imageReply,
    ];
    const result = await run([teachingTransport, ...evidence], blocksFor(evidence));

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
    expect(result.suspiciousName).toBe('张三');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('teaching 内手机号不能为 phone 出处闸门作证', async () => {
    const evidence = [
      { role: 'user', content: `姓名：张三\n${TIME_SUFFIX}` },
      assistantPrompt,
      imageReply,
    ];
    const result = await run([teachingTransport, ...evidence], blocksFor(evidence));

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
    expect(result.suspiciousPhone).toBe('13900000002');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('同值位于 evidence/user 时 name 与 phone 闸门正常放行', async () => {
    const evidence = [
      assistantPrompt,
      imageReply,
      {
        role: 'user',
        content: `[引用 招聘顾问：请核对资料]\n姓名：张三\n联系电话：13900000002\n${TIME_SUFFIX}`,
      },
    ];
    const result = await run([teachingTransport, ...evidence], blocksFor(evidence));

    expect(result.success).toBe(true);
    expect(mockSpongeService.bookInterview).toHaveBeenCalledTimes(1);
  });

  it('不传 corpusBlocks 时回退裸 messages，保持旧调用方行为', async () => {
    const messages = [
      assistantPrompt,
      imageReply,
      {
        role: 'user',
        content: `[引用 招聘顾问：请核对资料]\n姓名：张三\n联系电话：13900000002\n${TIME_SUFFIX}`,
      },
    ];
    const result = await run(messages);

    expect(result.success).toBe(true);
    expect(mockSpongeService.bookInterview).toHaveBeenCalledTimes(1);
  });
});
