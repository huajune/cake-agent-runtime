import { toErrorMessage } from '@infra/utils/error.util';
import { PDFParse } from 'pdf-parse';
import { ResumeReadError } from './resume-format.util';

export const DEFAULT_RESUME_MAX_PAGES = 6;
export const THIN_TEXT_CHARS_PER_PAGE = 60;

export interface PdfTextExtraction {
  text: string;
  totalPages: number;
  pagesParsed: number;
  thin: boolean;
  charsPerPage: number;
}

/** 提取 PDF 文字层，并用“每已解析页字符数”识别空/混合扫描件。 */
export async function extractPdfText(
  buffer: Buffer,
  maxPages = DEFAULT_RESUME_MAX_PAGES,
): Promise<PdfTextExtraction> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({
      first: maxPages,
      pageJoiner: '\n\n--- 第 page_number 页 / 共 total_number 页 ---\n\n',
    });
    const pagesParsed = result.pages.length;
    const textChars = result.pages.reduce((total, page) => total + page.text.trim().length, 0);
    const denominator = Math.max(1, pagesParsed || Math.min(result.total || 1, maxPages));
    const charsPerPage = textChars / denominator;
    return {
      text: result.text ?? '',
      totalPages: result.total ?? 0,
      pagesParsed,
      thin: charsPerPage < THIN_TEXT_CHARS_PER_PAGE,
      charsPerPage,
    };
  } catch (error) {
    throw new ResumeReadError('parse_failed', toErrorMessage(error));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
