import { MessageParser } from '@wecom/message/utils/message-parser.util';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';
import {
  extractHighConfidenceFacts,
  unwrapHighConfidenceValue,
} from '@memory/facts/high-confidence-facts';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';
import { buildInterviewPrecheckTool } from '@tools/duliday-interview-precheck.tool';
import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import type { ToolBuildContext } from '@shared-types/tool.types';

describe('resume booking flow', () => {
  const resumeFileUrl = 'https://wecom.example.com/files/renbowen-resume.pdf';
  const cloudStorageKey = 'resume/cloud/renbowen-resume.pdf';

  const mockSpongeService = {
    fetchJobs: jest.fn(),
    bookInterview: jest.fn(),
    uploadAttachmentFromUrl: jest.fn(),
  };

  const mockPrivateChatNotifier = {
    notifyInterviewBookingResult: jest.fn().mockResolvedValue(true),
  };

  const mockUserHostingService = {
    pauseUser: jest.fn().mockResolvedValue(undefined),
  };

  const mockLongTermService = {
    writeFromBooking: jest.fn().mockResolvedValue(undefined),
    setActiveBooking: jest.fn().mockResolvedValue(undefined),
    getActiveBooking: jest.fn().mockResolvedValue(null),
    getActiveBookings: jest.fn().mockResolvedValue([]),
  };

  const mockOpsEventsRecorder = {
    recordEvent: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T02:00:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeResumeRequiredJob()] });
    mockSpongeService.uploadAttachmentFromUrl.mockResolvedValue({
      fileName: '任博文简历.pdf',
      cloudStorageKey,
    });
    mockSpongeService.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      notice: null,
      errorList: null,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('parses a WeCom resume PDF, prechecks with the attachment, uploads it, and books with cloudStorageKey', async () => {
    const parsed = MessageParser.parse(
      buildFileCallback({
        name: '任博文简历.pdf',
        fileUrl: resumeFileUrl,
      }),
    );
    expect(parsed.content).toContain(`简历附件：${resumeFileUrl}`);

    const highConfidenceFacts = extractHighConfidenceFacts([parsed.content], []);
    expect(unwrapHighConfidenceValue(highConfidenceFacts?.interview_info.upload_resume)).toBe(
      resumeFileUrl,
    );

    const context = buildToolContext(parsed.content, highConfidenceFacts);
    const precheckResult = await executePrecheck(
      {
        jobId: 528121,
        requestedDate: '2026-06-09',
        candidateAge: '22',
        candidateLaborForm: '不是暑假工，长期',
        candidateInterviewTime: '2026-06-09 13:00:00',
        candidateGender: '男',
        candidateEducation: '大专',
        candidateHasHealthCertificate: '无',
        candidateIsStudent: false,
      },
      context,
    );

    expect(precheckResult.success).toBe(true);
    expect(precheckResult.nextAction).toBe('ready_to_book');
    const precheckMissingFields = precheckResult.bookingChecklist.missingFields ?? [];
    expect(precheckMissingFields).not.toContain('简历附件');
    expect(precheckMissingFields).not.toContain('上传简历');

    const bookingResult = await executeBooking(
      {
        jobId: 528121,
        interviewTime: '2026-06-09 13:00:00',
        name: '任博文',
        phone: '15305186866',
        age: 22,
        genderId: 1,
        operateType: 6,
        educationId: 3,
        hasHealthCertificate: 2,
        healthCertificateTypes: [1],
        prechecked: {
          nextAction: precheckResult.nextAction,
          missingFieldsCount: precheckMissingFields.length,
        },
      },
      context,
    );

    expect(bookingResult.success).toBe(true);
    expect(mockSpongeService.uploadAttachmentFromUrl).toHaveBeenCalledWith(
      {
        fileUrl: resumeFileUrl,
        fileName: '任博文简历.pdf',
      },
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadResume: cloudStorageKey,
        customerLabelList: [
          {
            labelId: 49,
            labelName: '上传简历',
            name: '上传简历',
            value: cloudStorageKey,
          },
        ],
      }),
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
    expect(bookingResult.requestInfo.uploadResume).toBe(cloudStorageKey);
    expect(bookingResult.requestInfo.customerLabelList[0].value).toBe(cloudStorageKey);
  });

  it('keeps unrelated PDFs out of resume facts and blocks text-only resume booking', async () => {
    const parsed = MessageParser.parse(
      buildFileCallback({
        name: '入职材料.pdf',
        fileUrl: 'https://wecom.example.com/files/onboarding.pdf',
      }),
    );
    expect(parsed.content).not.toContain('简历附件：');

    const highConfidenceFacts = extractHighConfidenceFacts([parsed.content], []);
    expect(unwrapHighConfidenceValue(highConfidenceFacts?.interview_info.upload_resume)).toBeNull();

    const context = buildToolContext(parsed.content, highConfidenceFacts);
    const precheckResult = await executePrecheck(
      {
        jobId: 528121,
        requestedDate: '2026-06-09',
        candidateAge: '22',
        candidateInterviewTime: '2026-06-09 13:00:00',
        candidateGender: '男',
        candidateEducation: '大专',
        candidateHasHealthCertificate: '无',
        candidateIsStudent: false,
      },
      context,
    );

    expect(precheckResult.success).toBe(true);
    expect(precheckResult.nextAction).toBe('collect_fields');
    expect(precheckResult.bookingChecklist.missingFields).toContain('简历附件');

    const bookingResult = await executeBooking(
      {
        jobId: 528121,
        interviewTime: '2026-06-09 13:00:00',
        name: '任博文',
        phone: '15305186866',
        age: 22,
        genderId: 1,
        operateType: 6,
        educationId: 3,
        hasHealthCertificate: 2,
        healthCertificateTypes: [1],
        supplementAnswers: {
          上传简历: '南京城市职业学院毕业。高铁检票员1年，蜜雪冰城饮品师8个月',
        },
        prechecked: {
          nextAction: 'ready_to_book',
          missingFieldsCount: 0,
        },
      },
      context,
    );

    expect(bookingResult.success).toBe(false);
    expect(bookingResult.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
    expect(bookingResult.missingFields).toEqual(['简历附件']);
    expect(bookingResult.missingSupplementLabels).toEqual(['上传简历']);
    expect(mockSpongeService.uploadAttachmentFromUrl).not.toHaveBeenCalled();
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  function buildToolContext(
    messageContent: string,
    highConfidenceFacts: ToolBuildContext['highConfidenceFacts'],
  ): ToolBuildContext {
    return {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: '6a1ced34536c9654027defbd',
      chatId: '6a1ced34536c9654027defbd',
      contactName: '候选人微信名',
      botUserId: 'manager-1',
      // B4 手机号溯源闸门要求提交的 phone 在候选人原文有出处，预置报号消息
      messages: [{ role: 'user', content: '电话15305186866' }, { role: 'user', content: messageContent }],
      highConfidenceFacts,
      sessionFacts: {
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          name: '任博文',
          phone: '15305186866',
          gender: '男',
          age: '22',
          education: '大专',
          has_health_certificate: '无但接受办理健康证',
          is_student: false,
          interview_time: null,
          upload_resume: null,
        },
        preferences: FALLBACK_EXTRACTION.preferences,
        reasoning: 'integration test',
      },
    } as ToolBuildContext;
  }

  async function executePrecheck(input: Record<string, unknown>, context: ToolBuildContext) {
    const builtTool = buildInterviewPrecheckTool(
      mockSpongeService as never,
      { recordEvent: jest.fn() } as never,
    )(context);
    return builtTool.execute(input as never, {
      toolCallId: 'precheck-test',
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<any>;
  }

  async function executeBooking(input: Record<string, unknown>, context: ToolBuildContext) {
    const builtTool = buildInterviewBookingTool(
      mockSpongeService as never,
      mockPrivateChatNotifier as never,
      mockUserHostingService as never,
      mockLongTermService as never,
      mockOpsEventsRecorder as never,
    )(context);

    return builtTool.execute(input as never, {
      toolCallId: 'booking-test',
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<any>;
  }
});

function buildFileCallback(payload: {
  name: string;
  fileUrl: string;
}): EnterpriseMessageCallbackDto {
  return {
    orgId: 'org_001',
    token: 'tok_abc123',
    botId: 'bot_001',
    imBotId: 'wxid_bot',
    chatId: '6a1ced34536c9654027defbd',
    messageType: MessageType.FILE,
    messageId: 'msg_file_001',
    timestamp: '1780281077065',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: {
      name: payload.name,
      fileUrl: payload.fileUrl,
      size: 65 * 1024,
    },
  };
}

function makeResumeRequiredJob() {
  return {
    basicInfo: {
      jobId: 528121,
      brandName: '奥乐齐',
      jobName: '奥乐齐-南京（六合）悦斯荟-通岗店员-全职',
      jobNickName: '奥乐齐通岗店员',
      storeInfo: {
        storeName: '南京（六合）悦斯荟',
      },
    },
    hiringRequirement: {
      basicPersonalRequirements: {
        minAge: 20,
        maxAge: 40,
        genderRequirement: '不限',
      },
      certificate: {
        education: '高中',
        healthCertificate: '食品健康证',
      },
      remark: '用户需接受缴纳当地社保',
    },
    interviewProcess: {
      firstInterview: {
        firstInterviewWay: '线下面试',
        interviewAddress: '南京（六合）悦斯荟',
        fixedInterviewTimes: [
          {
            interviewDate: '2026-06-09',
            interviewStartTime: '13:00',
            interviewEndTime: '18:00',
          },
        ],
        periodicInterviewTimes: [],
      },
      interviewSupplement: [{ interviewSupplementId: 49, interviewSupplement: '上传简历' }],
      remark: '按标准简历模板，填写完整，上传简历，简历通过客户审核后，通知具体面试时间&地点',
    },
  };
}
