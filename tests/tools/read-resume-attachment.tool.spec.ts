import type { LlmExecutorService } from '@/llm/llm-executor.service';
import {
  buildReadResumeAttachmentTool,
  type ResumeAttachment,
} from '@tools/read-resume-attachment.tool';
import { ResumeReadError } from '@tools/resume/resume-format.util';
import { extractPdfText } from '@tools/resume/pdf-text.util';
import { extractResumeFieldsViaModel } from '@tools/resume/resume-extract.util';
import { transcribeResumeImage, transcribeScannedPdf } from '@tools/resume/resume-transcribe.util';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { strToU8, zipSync } from 'fflate';
import { createToolContext } from '../helpers/tool-context.fixture';

jest.mock('@tools/resume/pdf-text.util', () => ({
  extractPdfText: jest.fn(),
}));
jest.mock('@tools/resume/resume-extract.util', () => ({
  extractResumeFieldsViaModel: jest.fn(),
}));
jest.mock('@tools/resume/resume-transcribe.util', () => ({
  transcribeResumeImage: jest.fn(),
  transcribeScannedPdf: jest.fn(),
}));

const mockExtractPdfText = extractPdfText as jest.MockedFunction<typeof extractPdfText>;
const mockExtractViaModel = extractResumeFieldsViaModel as jest.MockedFunction<
  typeof extractResumeFieldsViaModel
>;
const mockTranscribeImage = transcribeResumeImage as jest.MockedFunction<
  typeof transcribeResumeImage
>;
const mockTranscribePdf = transcribeScannedPdf as jest.MockedFunction<typeof transcribeScannedPdf>;

type ExecutableTool = {
  execute: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>;
  description?: string;
};

describe('buildReadResumeAttachmentTool', () => {
  const originalFetch = global.fetch;
  const resumeUrl = 'https://example.com/fake-resume.pdf';
  const resumeText = [
    '教育经历：测试职业学院 大专',
    '工作经历：测试咖啡店负责门店服务',
    '18271421690',
    '兮兮',
    '女 | 24岁',
  ].join('\n');
  const messageWriteback = jest.fn().mockResolvedValue(true);
  const resolveReadTarget = jest.fn(async (attachment: ResumeAttachment) => ({
    fileUrl: attachment.fileUrl,
    messageId: attachment.messageId,
    imageOriginal: true,
  }));
  const llm = {} as LlmExecutorService;

  beforeEach(() => {
    jest.clearAllMocks();
    messageWriteback.mockResolvedValue(true);
    resolveReadTarget.mockImplementation(async (attachment: ResumeAttachment) => ({
      fileUrl: attachment.fileUrl,
      messageId: attachment.messageId,
      imageOriginal: true,
    }));
    global.fetch = jest.fn().mockResolvedValue(response(Buffer.from('%PDF-1.7 fake'))) as never;
    mockExtractPdfText.mockResolvedValue({
      text: resumeText,
      totalPages: 1,
      pagesParsed: 1,
      thin: false,
      charsPerPage: resumeText.length,
    });
    mockExtractViaModel.mockResolvedValue([
      { field: 'name', value: '兮兮', sourceText: '兮兮', extractedBy: 'extract_model' },
      {
        field: 'phone',
        value: '18271421690',
        sourceText: '18271421690',
        extractedBy: 'extract_model',
      },
      {
        field: 'education',
        value: '大专',
        sourceText: '教育经历:测试职业学院 大专',
        extractedBy: 'extract_model',
      },
    ]);
    mockTranscribeImage.mockResolvedValue(resumeText);
    mockTranscribePdf.mockResolvedValue(resumeText);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  async function executeTool(options?: {
    input?: Record<string, unknown>;
    attachments?: ResumeAttachment[];
    resumeRequired?: boolean;
  }) {
    const attachments = options?.attachments ?? [
      { fileUrl: resumeUrl, fileName: '兮兮简历.pdf', messageId: 'message-1' },
    ];
    const context = createToolContext({
      archive: {
        currentFocusJob: {
          jobId: 528751,
          brandName: '测试品牌',
          jobName: '服务员',
          storeName: '测试门店',
          cityName: '上海',
          regionName: '徐汇区',
          laborForm: '全职',
          salaryDesc: null,
          jobCategoryName: null,
          resumeRequired: options?.resumeRequired ?? true,
        },
      },
    });
    const built = buildReadResumeAttachmentTool(attachments, {
      llm,
      resolveReadTarget,
      messageWriteback,
    })(context) as ExecutableTool;
    const result = await built.execute(options?.input ?? {}, {
      toolCallId: 'test',
      context: {},
      messages: [],
    });
    return { result: result as Record<string, unknown>, context, built };
  }

  it('removes the resumeRequired read gate and replays a scrambled PDF name with source', async () => {
    const { result } = await executeTool({ resumeRequired: false });

    expect(result).toMatchObject({
      success: true,
      sourceKind: 'pdf_text',
      totalPages: 1,
      pagesParsed: 1,
      fields: {
        name: { value: '兮兮', sourceText: '兮兮', confidence: 'medium' },
        phone: { value: '18271421690', confidence: 'medium' },
        education: { value: '大专' },
      },
    });
    expect(result.text).toContain('兮兮');
  });

  it('records a resume sheet and writes the summary back to the bound file message', async () => {
    const { result, context } = await executeTool();

    expect(result).toMatchObject({ sheetRecorded: true, messageWrittenBack: true });
    expect(context.ledger.visual.factSheets).toHaveLength(1);
    expect(context.ledger.visual.factSheets[0]).toMatchObject({
      messageId: 'message-1',
      sheet: { kind: 'resume', degraded: false },
    });
    expect(messageWriteback).toHaveBeenCalledWith(
      'message-1',
      expect.stringContaining('简历附件：https://example.com/fake-resume.pdf'),
      expect.objectContaining({ kind: 'resume' }),
    );
    expect(messageWriteback.mock.calls[0][1]).toContain('简历解析摘要：');
  });

  it('degrades cleanly without messageId: output only, no sheet and no writeback', async () => {
    const { result, context } = await executeTool({
      attachments: [{ fileUrl: resumeUrl, fileName: '兮兮简历.pdf' }],
    });

    expect(result).toMatchObject({
      success: true,
      sheetRecorded: false,
      messageWrittenBack: false,
    });
    expect(context.ledger.visual.factSheets).toHaveLength(0);
    expect(messageWriteback).not.toHaveBeenCalled();
  });

  it('dispatches a real docx archive and returns extracted text', async () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body>' +
      '<w:p><w:r><w:t>姓名：兮兮</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>电话：18271421690</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const docx = Buffer.from(
      zipSync({
        'word/document.xml': strToU8(documentXml),
        '[Content_Types].xml': strToU8('<Types/>'),
      }),
    );
    global.fetch = jest.fn().mockResolvedValue(response(docx)) as never;
    mockExtractViaModel.mockResolvedValue([
      { field: 'name', value: '兮兮', sourceText: '姓名:兮兮', extractedBy: 'extract_model' },
      {
        field: 'phone',
        value: '18271421690',
        sourceText: '电话:18271421690',
        extractedBy: 'extract_model',
      },
    ]);

    const { result } = await executeTool({
      attachments: [
        {
          fileUrl: 'https://example.com/fake-resume.docx',
          fileName: '兮兮简历.docx',
          messageId: 'message-docx',
        },
      ],
    });
    expect(result).toMatchObject({
      success: true,
      sourceKind: 'docx_text',
      fields: { name: { value: '兮兮' }, phone: { value: '18271421690' } },
    });
    expect(result.text).toContain('姓名:兮兮');
  });

  it('routes thin PDFs and direct images through Vision transcription', async () => {
    mockExtractPdfText.mockResolvedValue({
      text: '封面',
      totalPages: 3,
      pagesParsed: 3,
      thin: true,
      charsPerPage: 2 / 3,
    });
    const thin = await executeTool();
    expect(thin.result).toMatchObject({
      success: true,
      sourceKind: 'vision_transcription',
      pagesParsed: 2,
    });
    expect(mockTranscribePdf).toHaveBeenCalled();

    global.fetch = jest
      .fn()
      .mockResolvedValue(response(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))) as never;
    const image = await executeTool({
      attachments: [
        {
          fileUrl: 'https://example.com/fake-resume.jpg',
          fileName: '兮兮简历.jpg',
          messageId: 'message-image',
        },
      ],
    });
    expect(image.result).toMatchObject({ success: true, sourceKind: 'vision_transcription' });
    expect(mockTranscribeImage).toHaveBeenCalled();
  });

  it('replaces a stale image marker URL with the verified artworkUrl', async () => {
    const staleUrl = 'https://example.com/thumbnail-expired.jpg';
    const artworkUrl = 'https://example.com/artwork-original.jpg';
    resolveReadTarget.mockResolvedValueOnce({
      fileUrl: artworkUrl,
      messageId: 'message-image',
      imageOriginal: true,
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue(response(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))) as never;

    const { result } = await executeTool({
      attachments: [{ fileUrl: staleUrl, fileName: '兮兮简历.jpg' }],
    });

    expect(result).toMatchObject({ success: true, fileUrl: artworkUrl });
    expect(global.fetch).toHaveBeenCalledWith(artworkUrl, expect.any(Object));
    expect(messageWriteback).toHaveBeenCalledWith(
      'message-image',
      expect.stringContaining(`简历附件：${artworkUrl}`),
      expect.any(Object),
    );
  });

  it('never falls back to a thumbnail when artworkUrl is unavailable', async () => {
    resolveReadTarget.mockResolvedValueOnce({
      fileUrl: null,
      messageId: 'message-image',
      imageOriginal: false,
    });

    const { result } = await executeTool({
      attachments: [
        {
          fileUrl: 'https://example.com/thumbnail.jpg',
          fileName: '兮兮简历.jpg',
          messageId: 'message-image',
        },
      ],
    });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.READ_RESUME_DOWNLOAD_FAILED,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTranscribeImage).not.toHaveBeenCalled();
  });

  it('switches to fallback rules when Extract fails', async () => {
    mockExtractViaModel.mockRejectedValue(new Error('extract unavailable'));
    const { result } = await executeTool();
    expect(result).toMatchObject({
      success: true,
      fallbackUsed: true,
      fields: { name: { value: '兮兮' }, phone: { value: '18271421690' } },
    });
  });

  it('keeps quote_not_found when the model injects an invented field', async () => {
    mockExtractViaModel.mockResolvedValue([
      {
        field: 'education',
        value: '本科',
        sourceText: '最高学历:本科',
        extractedBy: 'extract_model',
      },
    ]);
    const { result } = await executeTool();
    expect(result.notaryDrops).toContainEqual({
      field: 'education',
      reason: 'quote_not_found',
    });
    expect(result.fallbackUsed).toBe(true);
  });

  it('rejects unknown URLs before download', async () => {
    const { result } = await executeTool({
      input: { fileUrl: 'https://example.com/not-in-session.pdf' },
    });
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.READ_RESUME_FORBIDDEN_URL,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [Buffer.from('unknown'), TOOL_ERROR_TYPES.READ_RESUME_NOT_PDF],
    [
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      TOOL_ERROR_TYPES.READ_RESUME_UNSUPPORTED_FORMAT,
    ],
  ])('maps unsupported containers to stable error types', async (buffer, errorType) => {
    global.fetch = jest.fn().mockResolvedValue(response(buffer)) as never;
    const { result } = await executeTool();
    expect(result).toMatchObject({ success: false, errorType });
  });

  it('maps download, size, parse and Vision failures', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(Buffer.alloc(0), 503)) as never;
    expect((await executeTool()).result).toMatchObject({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_DOWNLOAD_FAILED,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ...response(Buffer.alloc(0)),
      headers: { get: () => String(9 * 1024 * 1024) },
    }) as never;
    expect((await executeTool()).result).toMatchObject({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_TOO_LARGE,
    });

    global.fetch = jest.fn().mockResolvedValue(response(Buffer.from('%PDF-fake'))) as never;
    mockExtractPdfText.mockRejectedValueOnce(new ResumeReadError('parse_failed', 'bad pdf'));
    expect((await executeTool()).result).toMatchObject({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_PARSE_FAILED,
    });

    mockExtractPdfText.mockResolvedValueOnce({
      text: '',
      totalPages: 1,
      pagesParsed: 1,
      thin: true,
      charsPerPage: 0,
    });
    mockTranscribePdf.mockRejectedValueOnce(new ResumeReadError('vision_failed', 'vision down'));
    expect((await executeTool()).result).toMatchObject({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_EMPTY_TEXT,
    });
  });

  it('includes supported formats and available URL in the description', async () => {
    const { built } = await executeTool();
    expect(built.description).toContain('PDF、docx、JPEG/PNG');
    expect(built.description).toContain(resumeUrl);
  });
});

function response(buffer: Buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(buffer.byteLength) : null,
    },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}
