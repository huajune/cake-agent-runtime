import { toErrorMessage } from '@infra/utils/error.util';
import { unzipSync } from 'fflate';
import { ResumeReadError } from './resume-format.util';

const WORD_TEXT_TOKEN_RE =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/\s*>|<w:br(?:\s[^>]*)?\/\s*>|<\/w:p\s*>/giu;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

export function extractWordXmlText(xml: string): string {
  const tokens: string[] = [];
  for (const match of xml.matchAll(WORD_TEXT_TOKEN_RE)) {
    const token = match[0];
    if (/^<w:t(?:\s|>)/iu.test(token)) tokens.push(decodeXmlEntities(match[1] ?? ''));
    else if (/^<w:tab/iu.test(token)) tokens.push(' ');
    else tokens.push('\n');
  }
  return tokens
    .join('')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** 解压 docx，按页眉→正文→页脚顺序抽取可见文本。 */
export function extractDocxText(buffer: Buffer): string {
  try {
    const entries = unzipSync(new Uint8Array(buffer));
    const names = Object.keys(entries);
    if (!entries['word/document.xml']) {
      throw new ResumeReadError('parse_failed', 'docx missing word/document.xml');
    }
    const headers = names.filter((name) => /^word\/header\d+\.xml$/iu.test(name)).sort();
    const footers = names.filter((name) => /^word\/footer\d+\.xml$/iu.test(name)).sort();
    const ordered = [...headers, 'word/document.xml', ...footers];
    const sections = ordered
      .map((name) => extractWordXmlText(Buffer.from(entries[name]).toString('utf8')))
      .filter(Boolean);
    const text = sections
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
    if (!text) throw new ResumeReadError('parse_failed', 'docx contains no readable text');
    return text;
  } catch (error) {
    if (error instanceof ResumeReadError) throw error;
    throw new ResumeReadError('parse_failed', toErrorMessage(error));
  }
}
