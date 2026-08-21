import { toErrorMessage } from '@infra/utils/error.util';
import type { LlmExecutorService } from '@/llm/llm-executor.service';
import { Logger } from '@nestjs/common';
import {
  extractResumeFieldsFallback,
  notarizeResumeFields,
  RESUME_FIELD_NAMES,
  type ResumeFieldExtraction,
  type ResumeRawField,
  type ResumeSourceKind,
} from '@resolution/candidate/resume-fields';
import { appendResumeAttachmentLine } from '@resolution/signal/markers';
import {
  sanitizeVisualDescription,
  type FinalizedVisualFactSheet,
} from '@resolution/signal/visual';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { extractDocxText } from './resume/docx-text.util';
import { extractPdfText } from './resume/pdf-text.util';
import { extractResumeFieldsViaModel } from './resume/resume-extract.util';
import {
  detectResumeFormat,
  ResumeReadError,
  type ResumeFormat,
} from './resume/resume-format.util';
import { buildResumeFactSheet } from './resume/resume-sheet.util';
import {
  DEFAULT_RESUME_MAX_CHARS,
  hoistProfileBlock,
  normalizeResumeText,
  trimLowValueSections,
} from './resume/resume-text.util';
import { transcribeResumeImage, transcribeScannedPdf } from './resume/resume-transcribe.util';

const logger = new Logger('read_resume_attachment');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_PAGES = 6;
const MODEL_NOTARY_PASS_RATIO_FLOOR = 0.5;
const WRITEBACK_SUMMARY_MAX_CHARS = 500;

const DESCRIPTION = `读取候选人当前会话中已识别的简历附件，支持 PDF、docx、JPEG/PNG 简历图片。
当你需要从简历补齐或核对姓名、手机号、学历、年龄、求职意向、期望城市/薪资、工作经历时调用。
如果只是报名接口需要上传简历附件 URL，不需要调用本工具，直接使用已识别到的附件 URL。
本工具只允许读取工具描述列出的当前会话简历链接，不用于读取任意 URL。字段带出处与代码授予的
confidence：high 可直接用于对话推进，medium 必须向候选人求证；报名身份字段仍需本人终审。`;

export interface ResumeAttachment {
  fileUrl: string;
  fileName?: string;
  messageId?: string;
}

export interface ResumeReadTarget {
  /** 实际下载地址；图片只能是消息 payload.artworkUrl，缺失时为 null。 */
  fileUrl: string | null;
  /** 只允许透传消息表里查到的真实 ID，禁止合成。 */
  messageId?: string;
  /** 图片地址是否已由消息 payload.artworkUrl 公证为高清原图。 */
  imageOriginal: boolean;
}

export interface ResumeAttachmentToolDeps {
  llm: LlmExecutorService;
  resolveReadTarget: (attachment: ResumeAttachment) => Promise<ResumeReadTarget>;
  messageWriteback: (
    messageId: string,
    content: string,
    sheet: FinalizedVisualFactSheet,
  ) => Promise<boolean>;
}

const inputSchema = z.object({
  fileUrl: z
    .string()
    .url()
    .optional()
    .describe('要读取的简历 URL；省略时读取当前会话唯一/第一份简历附件'),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(12_000)
    .optional()
    .describe('最多返回多少个字符的裁剪简历文本，默认 3000，最大 12000'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('最多解析 PDF 前多少页，默认 6，最大 10'),
});

interface ContainerExtraction {
  text: string;
  sourceKind: ResumeSourceKind;
  totalPages: number | null;
  pagesParsed: number | null;
}

export function buildReadResumeAttachmentTool(
  attachments: ResumeAttachment[],
  deps: ResumeAttachmentToolDeps,
): ToolBuilder {
  return (context) => {
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
              '当前没有已识别的简历附件。请让候选人发送 PDF/docx 简历文件，或拍照发送 JPEG/PNG 简历图片。',
            details: { availableResumeUrls: available.map((item) => item.fileUrl) },
          });
        }
        if (fileUrl && attachment.fileUrl !== fileUrl.trim()) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.READ_RESUME_FORBIDDEN_URL,
            outcome: '读取简历失败（URL 不属于当前会话简历附件）',
            replyInstruction:
              '只能读取工具描述列出的当前会话简历链接。请使用可用 URL，或让候选人重新发送简历。',
            details: {
              providedFileUrl: fileUrl,
              availableResumeUrls: available.map((item) => item.fileUrl),
            },
          });
        }

        try {
          const target = await deps.resolveReadTarget(attachment);
          if (!target.fileUrl) {
            throw new ResumeReadError('download_failed', 'resume image artworkUrl is unavailable');
          }
          const resolvedAttachment: ResumeAttachment = {
            ...attachment,
            fileUrl: target.fileUrl,
            messageId: target.messageId ?? attachment.messageId,
          };
          const buffer = await downloadResumeFile(resolvedAttachment.fileUrl);
          const format = detectResumeFormat(buffer);
          if (format === 'image' && !target.imageOriginal) {
            throw new ResumeReadError(
              'download_failed',
              'resume image URL is not a verified artworkUrl',
            );
          }
          const container = await extractContainer(
            buffer,
            format,
            maxPages ?? DEFAULT_MAX_PAGES,
            deps.llm,
          );

          // 唯一规整点：Extract、fallback、公证、output、sheet、回写都消费这一份文本。
          const normalizedText = normalizeResumeText(container.text);
          if (!normalizedText) {
            throw new ResumeReadError('vision_failed', 'resume transcription is empty');
          }

          const modelResult = await extractAndNotarize(
            normalizedText,
            resolvedAttachment.fileName,
            container.sourceKind,
            deps.llm,
          );
          const extraction = modelResult.extraction;
          const { phoneCandidates, notaryDrops, ...fields } = extraction;
          const limit = maxChars ?? DEFAULT_RESUME_MAX_CHARS;
          const returnedText = trimLowValueSections(normalizedText, limit);

          let sheetRecorded = false;
          let messageWrittenBack = false;
          if (resolvedAttachment.messageId) {
            const sheet = buildResumeFactSheet(extraction, returnedText);
            if (!sheet.degraded) {
              context.ledger.recordVisualFacts(sheet, { messageId: resolvedAttachment.messageId });
              sheetRecorded = true;
              const content = buildResumeMessageContent(resolvedAttachment, returnedText);
              messageWrittenBack = await deps.messageWriteback(
                resolvedAttachment.messageId,
                content,
                sheet,
              );
              if (!messageWrittenBack) {
                logger.warn(`简历摘要消息回写失败 [${resolvedAttachment.messageId}]`);
              }
            }
          } else {
            logger.warn(`简历 messageId 无法定位，降级为仅 output: ${resolvedAttachment.fileUrl}`);
          }

          logger.log(
            `简历已读取: format=${format}, source=${container.sourceKind}, ` +
              `chars=${normalizedText.length}, fallback=${modelResult.fallbackUsed}, ` +
              `messageId=${resolvedAttachment.messageId ?? 'missing'}`,
          );
          return {
            success: true,
            fileUrl: resolvedAttachment.fileUrl,
            fileName: resolvedAttachment.fileName,
            sourceKind: container.sourceKind,
            totalPages: container.totalPages,
            pagesParsed: container.pagesParsed,
            truncatedPages:
              container.totalPages !== null &&
              container.pagesParsed !== null &&
              container.totalPages > container.pagesParsed,
            textCharCount: normalizedText.length,
            returnedTextCharCount: returnedText.length,
            truncatedText: normalizedText.length > returnedText.length,
            fields,
            phoneCandidates,
            notaryDrops,
            fallbackUsed: modelResult.fallbackUsed,
            sheetRecorded,
            messageWrittenBack,
            text: returnedText,
            usageHint:
              'confidence=high 可直接用于对话推进；medium 须向候选人求证后再入报名；与聊天明示冲突时以聊天为准。',
          };
        } catch (error) {
          return mapReadError(error, attachment);
        }
      },
    });
  };
}

async function extractContainer(
  buffer: Buffer,
  format: ResumeFormat,
  maxPages: number,
  llm: LlmExecutorService,
): Promise<ContainerExtraction> {
  if (format === 'pdf') {
    const parsed = await extractPdfText(buffer, maxPages);
    if (parsed.thin) {
      return {
        text: await transcribeScannedPdf(buffer, llm),
        sourceKind: 'vision_transcription',
        totalPages: parsed.totalPages,
        pagesParsed: Math.min(parsed.totalPages, 2),
      };
    }
    return {
      text: parsed.text,
      sourceKind: 'pdf_text',
      totalPages: parsed.totalPages,
      pagesParsed: parsed.pagesParsed,
    };
  }
  if (format === 'docx') {
    return {
      text: extractDocxText(buffer),
      sourceKind: 'docx_text',
      totalPages: null,
      pagesParsed: null,
    };
  }
  if (format === 'image') {
    return {
      text: await transcribeResumeImage(buffer, llm),
      sourceKind: 'vision_transcription',
      totalPages: 1,
      pagesParsed: 1,
    };
  }
  if (format === 'legacy_doc') {
    throw new ResumeReadError('unsupported_format', 'legacy OLE .doc is unsupported');
  }
  throw new ResumeReadError('not_pdf', 'unknown resume magic bytes');
}

async function extractAndNotarize(
  normalizedText: string,
  fileName: string | undefined,
  sourceKind: ResumeSourceKind,
  llm: LlmExecutorService,
): Promise<{ extraction: ResumeFieldExtraction; fallbackUsed: boolean }> {
  let modelFields: ResumeRawField[] = [];
  try {
    modelFields = await extractResumeFieldsViaModel(normalizedText, llm);
  } catch (error) {
    logger.warn(`简历 Extract 主轨失败，切换规则兜底: ${toErrorMessage(error)}`);
    const fallback = extractResumeFieldsFallback(normalizedText, fileName);
    return {
      extraction: notarizeResumeFields(fallback, normalizedText, { fileName, sourceKind }),
      fallbackUsed: true,
    };
  }

  const initial = notarizeResumeFields(modelFields, normalizedText, { fileName, sourceKind });
  const acceptedCount = RESUME_FIELD_NAMES.filter(
    (field) => initial[field] !== undefined && initial[field]?.extractedBy !== 'filename',
  ).length;
  const modelPassRatio = modelFields.length === 0 ? 0 : acceptedCount / modelFields.length;
  if (modelPassRatio >= MODEL_NOTARY_PASS_RATIO_FLOOR) {
    return { extraction: initial, fallbackUsed: false };
  }

  logger.warn(
    `简历 Extract 公证通过率过低，追加规则兜底: ` +
      `accepted=${acceptedCount}/${modelFields.length}`,
  );
  const fallback = extractResumeFieldsFallback(normalizedText, fileName);
  return {
    extraction: notarizeResumeFields([...modelFields, ...fallback], normalizedText, {
      fileName,
      sourceKind,
    }),
    fallbackUsed: true,
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
  const byUrl = new Map<string, ResumeAttachment>();
  for (const attachment of attachments) {
    const fileUrl = attachment.fileUrl.trim();
    if (!fileUrl) continue;
    const existing = byUrl.get(fileUrl);
    byUrl.set(fileUrl, {
      fileUrl,
      fileName: attachment.fileName ?? existing?.fileName,
      messageId: attachment.messageId ?? existing?.messageId,
    });
  }
  return [...byUrl.values()];
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

async function downloadResumeFile(fileUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(fileUrl, {
      method: 'GET',
      headers: {
        Accept:
          'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
          'image/jpeg,image/png,application/octet-stream,*/*',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new ResumeReadError('download_failed', `HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > DEFAULT_MAX_BYTES) {
      throw new ResumeReadError('too_large', `content-length=${contentLength}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > DEFAULT_MAX_BYTES) {
      throw new ResumeReadError('too_large', `bytes=${buffer.byteLength}`);
    }
    return buffer;
  } catch (error) {
    if (error instanceof ResumeReadError) throw error;
    throw new ResumeReadError('download_failed', toErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

function buildResumeMessageContent(attachment: ResumeAttachment, returnedText: string): string {
  const fileLine =
    `[文件消息] 文件名：${attachment.fileName ?? '简历附件'}；` + `文件地址：${attachment.fileUrl}`;
  const summary = sanitizeVisualDescription(hoistProfileBlock(returnedText)).slice(
    0,
    WRITEBACK_SUMMARY_MAX_CHARS,
  );
  const withUrl = appendResumeAttachmentLine(fileLine, attachment.fileUrl);
  return `${withUrl}\n简历解析摘要：${summary}`;
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
      outcome: '读取简历失败（文件过大）',
      replyInstruction: '简历文件过大，无法读取；不要猜测内容，请让候选人压缩后重发或补问字段。',
      details,
    });
  }
  if (readError.kind === 'unsupported_format') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_UNSUPPORTED_FORMAT,
      outcome: '读取简历失败（不支持老式 .doc）',
      replyInstruction: '当前不支持老式 .doc，请让候选人转为 PDF/docx，或拍照发送 JPEG/PNG。',
      details,
    });
  }
  if (readError.kind === 'not_pdf') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_NOT_PDF,
      outcome: '读取简历失败（无法识别文件格式）',
      replyInstruction: '附件不是可识别的 PDF/docx/JPEG/PNG 简历，请让候选人重新发送。',
      details,
    });
  }
  if (readError.kind === 'download_failed') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_DOWNLOAD_FAILED,
      outcome: '读取简历失败（下载失败）',
      replyInstruction: '简历附件下载失败；不要猜测内容，请让候选人重新发送或补问必要字段。',
      details,
    });
  }
  if (readError.kind === 'vision_failed') {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.READ_RESUME_EMPTY_TEXT,
      outcome: '读取简历失败（图片文字转写失败）',
      replyInstruction: '简历图片/扫描件未能转写；不要猜测内容，请向候选人简短补问必要字段。',
      details,
    });
  }
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.READ_RESUME_PARSE_FAILED,
    outcome: '读取简历失败（解析失败）',
    replyInstruction: '简历解析失败；不要猜测内容，请让候选人重发或补问必要字段。',
    details,
  });
}
