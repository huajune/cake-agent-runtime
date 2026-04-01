import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildInterviewBookingTool', () => {
  const mockSpongeService = {
    bookInterview: jest.fn(),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
  };

  const validInput = {
    name: '张三',
    phone: '13800138000',
    age: '25',
    genderId: 1,
    jobId: 100,
    interviewTime: '2026-03-20 14:00:00',
    education: '大专',
    hasHealthCertificate: 1,
  };

  beforeEach(() => jest.clearAllMocks());

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (input: Record<string, any>) => {
    const builder = buildInterviewBookingTool(mockSpongeService as never);
    const builtTool = builder(mockContext);
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should return error for missing required fields', async () => {
    const result = await executeTool({ ...validInput, name: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('姓名');
  });

  it('should return error when education or health certificate status is missing', async () => {
    const result = await executeTool({
      ...validInput,
      education: undefined,
      hasHealthCertificate: undefined,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('学历');
    expect(result.error).toContain('健康证情况');
  });

  it('should return error for invalid time format', async () => {
    const result = await executeTool({ ...validInput, interviewTime: '2026/03/20 14:00' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('格式错误');
  });

  it('should return error for invalid education', async () => {
    const result = await executeTool({ ...validInput, education: '博士后' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效的学历');
  });

  it('should call SpongeService and return success', async () => {
    mockSpongeService.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      notice: '请准时到达',
      errorList: null,
    });

    const result = await executeTool(validInput);

    expect(result.success).toBe(true);
    expect(result.notice).toBe('请准时到达');
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '张三',
        jobId: 100,
        educationId: 5,
      }),
    );
  });

  it('should handle SpongeService error', async () => {
    mockSpongeService.bookInterview.mockRejectedValue(new Error('Network error'));

    const result = await executeTool(validInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});
