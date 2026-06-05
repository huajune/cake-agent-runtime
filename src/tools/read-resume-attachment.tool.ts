import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('read_resume_attachment');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_MAX_PAGES = 6;

const DESCRIPTION = `读取候选人已发送的简历 PDF 内容。仅当你需要查看简历详情来补齐或核对报名信息时调用，例如姓名、手机号、学历、年龄、工作经历等。
如果只是报名接口需要上传简历附件 URL，不需要调用本工具；直接使用已识别到的简历附件即可。
本工具只允许读取当前会话中已识别为简历附件的文件链接，不用于读取任意 URL。`;

export interface ResumeAttachment {
  fileUrl: string;
  fileName?: string;
}

const inputSchema = z.object({
  fileUrl: z
    .string()
    .url()
    .optional()
    .describe('要读取的简历文件 URL。通常可省略；省略时读取当前会话唯一的简历附件。'),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(12_000)
    .optional()
    .describe('最多返回多少个字符的简历文本，默认 6000，最大 12000。'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('最多解析 PDF 前多少页，默认 6，最大 10。'),
});

type ResumeFields = {
  name?: string;
  phone?: string;
  email?: string;
  age?: string;
  education?: string;
};

export function buildReadResumeAttachmentTool(attachments: ResumeAttachment[]): ToolBuilder {
  return () => {
    const available = uniqueAttachments(attachments);
    return tool({
      description: buildDescription(available),
      inputSchema,
      execute: async ({ fileUrl, maxChars, maxPages }) => {
        const attachment = resolveAttachment(fileUrl, available);
        if (!attachment) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.READ_RESUME_NO_ATTACHMENT,
            outcome: '读取简历失败（当前会话没有可读的简历附件）',
            replyInstruction:
              '当前没有已识别的简历附件。若岗位确实需要简历或需要从简历补信息，请让候选人发送文件名包含“简历/履历/resume/cv”的 PDF 简历。',
            details: { availableResumeUrls: available.map((item) => item.fileUrl) },
          });
        }
        if (fileUrl && attachment.fileUrl !== fileUrl.trim()) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.READ_RESUME_FORBIDDEN_URL,
            outcome: '读取简历失败（URL 不属于当前会话简历附件）',
            replyInstruction:
              '只能读取当前会话已识别为简历附件的文件链接。请改用工具描述里的可用简历 URL，或让候选人重新发送简历文件。',
            details: {
              providedFileUrl: fileUrl,
              availableResumeUrls: available.map((item) => item.fileUrl),
            },
          });
        }

        try {
          const pdfData = await downloadPdf(attachment.fileUrl);
          const parsed = await parsePdfText(pdfData, maxPages ?? DEFAULT_MAX_PAGES);
          const normalizedText = normalizeResumeText(parsed.text);

          if (!normalizedText) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.READ_RESUME_EMPTY_TEXT,
              outcome: '读取简历失败（PDF 未提取到文本）',
              replyInstruction:
                '该简历可能是扫描件或图片型 PDF，当前工具没有提取到文字。不要猜测简历内容；需要报名字段时请直接向候选人简短补问。',
              details: {
                fileUrl: attachment.fileUrl,
                fileName: attachment.fileName,
                totalPages: parsed.totalPages,
              },
            });
          }

          const limit = maxChars ?? DEFAULT_MAX_CHARS;
          const returnedText = normalizedText.slice(0, limit);
          logger.log(
            `简历 PDF 已读取: pages=${parsed.pagesParsed}/${parsed.totalPages}, chars=${normalizedText.length}`,
          );

          return {
            success: true,
            fileUrl: attachment.fileUrl,
            fileName: attachment.fileName,
            totalPages: parsed.totalPages,
            pagesParsed: parsed.pagesParsed,
            truncatedPages: parsed.totalPages > parsed.pagesParsed,
            textCharCount: normalizedText.length,
            returnedTextCharCount: returnedText.length,
            truncatedText: normalizedText.length > returnedText.length,
            fields: extractResumeFields(normalizedText),
            text: returnedText,
            usageHint:
              '优先使用 fields 中有明确证据的字段；若与候选人聊天中明示信息冲突，以候选人当前聊天表述为准，必要时先确认。',
          };
        } catch (error) {
          return mapReadError(error, attachment);
        }
      },
    });
  };
}

function buildDescription(attachments: ResumeAttachment[]): string {
  const availableText =
    attachments.length > 0
      ? attachments
          .map(
            (item, index) =>
              `${index + 1}. ${item.fileName ? `${item.fileName}：` : ''}${item.fileUrl}`,
          )
          .join('\n')
      : '无';
  return `${DESCRIPTION}\n\n当前可读取的简历附件：\n${availableText}`;
}

function uniqueAttachments(attachments: ResumeAttachment[]): ResumeAttachment[] {
  const seen = new Set<string>();
  const result: ResumeAttachment[] = [];
  for (const attachment of attachments) {
    const fileUrl = attachment.fileUrl.trim();
    if (!fileUrl || seen.has(fileUrl)) continue;
    seen.add(fileUrl);
    result.push({ ...attachment, fileUrl });
  }
  return result;
}

function resolveAttachment(
  requestedUrl: string | undefined,
  attachments: ResumeAttachment[],
): ResumeAttachment | null {
  if (attachments.length === 0) return null;
  const normalizedRequested = requestedUrl?.trim();
  if (!normalizedRequested) return attachments[0];
  return attachments.find((item) => item.fileUrl === normalizedRequested) ?? { fileUrl: '' };
}

async function downloadPdf(fileUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(fileUrl, {
      method: 'GET',
      headers: { Accept: 'application/pdf,application/octet-stream,*/*' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ResumeReadError('download_failed', `HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > DEFAULT_MAX_BYTES) {
      throw new ResumeReadError('too_large', `content-length=${contentLength}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > DEFAULT_MAX_BYTES) {
      throw new ResumeReadError('too_large', `bytes=${buffer.byteLength}`);
    }
    if (!looksLikePdf(buffer)) {
      throw new ResumeReadError('not_pdf', 'missing %PDF magic bytes');
    }
    return buffer;
  } catch (error) {
    if (error instanceof ResumeReadError) throw error;
    throw new ResumeReadError(
      'download_failed',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function parsePdfText(
  data: Buffer,
  maxPages: number,
): Promise<{ text: string; totalPages: number; pagesParsed: number }> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({
      first: maxPages,
      pageJoiner: '\n\n--- 第 page_number 页 / 共 total_number 页 ---\n\n',
    });
    return {
      text: result.text ?? '',
      totalPages: result.total ?? 0,
      pagesParsed: Math.min(result.total ?? maxPages, maxPages),
    };
  } catch (error) {
    throw new ResumeReadError(
      'parse_failed',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('utf8') === '%PDF-';
}

function normalizeResumeText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractResumeFields(text: string): ResumeFields {
  const fields: ResumeFields = {};
  const name = text.match(
    /(?:^|\n)\s*姓名\s*[：:]?\s*([\u4e00-\u9fa5·]{2,6}|[A-Za-z][A-Za-z\s]{1,40})/u,
  )?.[1];
  if (name) fields.name = name.trim();

  const phone = text.match(/(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})(?!\d)/u)?.[1];
  if (phone) fields.phone = phone.replace(/\D/g, '');

  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  if (email) fields.email = email;

  const age = text.match(/(?:年龄\s*[：:]?\s*)?([1-6]\d)\s*岁/u)?.[1];
  if (age) fields.age = age;

  const education = text.match(/博士|硕士|研究生|本科|大专|专科|高中|中专|初中/u)?.[0];
  if (education) fields.education = education;

  return fields;
}

function mapReadError(error: unknown, attachment: ResumeAttachment) {
  const readError =
    error instanceof ResumeReadError ? error : new ResumeReadError('parse_failed', String(error));
  const details = {
    fileUrl: attachment.fileUrl,
    fileName: attachment.fileName,
    reason: readError.message,
  };
  if (readError.kind === 'too_large') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_TOO_LARGE,
      outcome: '读取简历失败（PDF 文件过大）',
      replyInstruction:
        '简历文件过大，当前工具无法读取。不要猜测简历内容；需要报名字段时请直接向候选人简短补问。',
      details,
    });
  }
  if (readError.kind === 'not_pdf') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_NOT_PDF,
      outcome: '读取简历失败（文件不是可解析 PDF）',
      replyInstruction:
        '当前附件不是可解析 PDF。若岗位需要简历详情，请让候选人重新发送 PDF 简历，或直接补问必要报名字段。',
      details,
    });
  }
  if (readError.kind === 'download_failed') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_DOWNLOAD_FAILED,
      outcome: '读取简历失败（下载失败）',
      replyInstruction:
        '简历附件下载失败。不要猜测简历内容；若必须依赖简历信息，请让候选人重新发送简历或直接补问必要字段。',
      details,
    });
  }
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.READ_RESUME_PARSE_FAILED,
    outcome: '读取简历失败（PDF 解析失败）',
    replyInstruction: 'PDF 解析失败。不要猜测简历内容；需要报名字段时请直接向候选人简短补问。',
    details,
  });
}

class ResumeReadError extends Error {
  constructor(
    readonly kind: 'too_large' | 'download_failed' | 'not_pdf' | 'parse_failed',
    message: string,
  ) {
    super(message);
  }
}
