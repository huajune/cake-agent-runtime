import { buildReadResumeAttachmentTool } from '@tools/read-resume-attachment.tool';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { PDFParse } from 'pdf-parse';

const mockGetText = jest.fn();
const mockDestroy = jest.fn();

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn(),
}));

describe('buildReadResumeAttachmentTool', () => {
  const originalFetch = global.fetch;
  const resumeUrl = 'https://example.com/resume.pdf';
  const mockPDFParse = PDFParse as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPDFParse.mockImplementation(() => ({
      getText: mockGetText,
      destroy: mockDestroy,
    }));
    mockDestroy.mockResolvedValue(undefined);
    mockGetText.mockResolvedValue({
      text: '姓名：张三\n电话：13800138000\n邮箱：zhangsan@example.com\n学历：大专\n年龄：25岁',
      total: 1,
    });
    global.fetch = jest.fn().mockResolvedValue(buildPdfResponse('%PDF-1.4\nfake pdf')) as never;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const executeTool = async (
    input: Record<string, unknown> = {},
    attachments = [{ fileUrl: resumeUrl, fileName: '张三简历.pdf' }],
  ) => {
    const builder = buildReadResumeAttachmentTool(attachments);
    const builtTool = builder({} as never);
    return (builtTool as any).execute(input, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    }) as any;
  };

  it('reads the current resume attachment and returns extracted text plus field hints', async () => {
    const result = await executeTool();

    expect(result).toMatchObject({
      success: true,
      fileUrl: resumeUrl,
      fileName: '张三简历.pdf',
      totalPages: 1,
      pagesParsed: 1,
      fields: {
        name: '张三',
        phone: '13800138000',
        email: 'zhangsan@example.com',
        education: '大专',
        age: '25',
      },
    });
    expect(result.text).toContain('姓名：张三');
    expect(global.fetch).toHaveBeenCalledWith(
      resumeUrl,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(mockPDFParse).toHaveBeenCalled();
    expect(mockGetText).toHaveBeenCalledWith(
      expect.objectContaining({
        first: 6,
      }),
    );
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('rejects URLs that are not known resume attachments in the current context', async () => {
    const result = await executeTool({ fileUrl: 'https://example.com/other.pdf' });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.READ_RESUME_FORBIDDEN_URL,
      providedFileUrl: 'https://example.com/other.pdf',
      availableResumeUrls: [resumeUrl],
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPDFParse).not.toHaveBeenCalled();
  });

  it('returns a not_pdf tool error when the downloaded file is not a PDF', async () => {
    global.fetch = jest.fn().mockResolvedValue(buildPdfResponse('not a pdf')) as never;

    const result = await executeTool();

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.READ_RESUME_NOT_PDF,
      fileUrl: resumeUrl,
    });
    expect(mockPDFParse).not.toHaveBeenCalled();
  });

  it('returns an empty_text tool error for scanned PDFs without extractable text', async () => {
    mockGetText.mockResolvedValue({ text: '   ', total: 2 });

    const result = await executeTool();

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.READ_RESUME_EMPTY_TEXT,
      totalPages: 2,
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('includes available resume URLs in the tool description', () => {
    const tool = buildReadResumeAttachmentTool([{ fileUrl: resumeUrl, fileName: '张三简历.pdf' }])(
      {} as never,
    );

    expect((tool as any).description).toContain('张三简历.pdf');
    expect((tool as any).description).toContain(resumeUrl);
    expect((tool as any).description).toContain(
      '如果只是报名接口需要上传简历附件 URL，不需要调用本工具',
    );
  });
});

function buildPdfResponse(content: string) {
  const buffer = Buffer.from(content);
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(buffer.byteLength) : null,
    },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}
