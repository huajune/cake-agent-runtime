export const SUMMARY_SECTION_TITLES = ['求职目标', '关键约束', '进展与结果', '未决事项'] as const;

export type SummaryScope = 'job_seeking' | 'other';

export interface ParsedSummaryOutput {
  /** 首行「范围」标记；缺失或不可识别时为 null，调用方按求职处理（fail-open 到现状）。 */
  scope: SummaryScope | null;
  /** 去掉范围行、标题归一为「标题：正文」纯文本后的摘要正文。 */
  body: string;
}

const SCOPE_LINE_PATTERN = /^范围\s*[:：]\s*(求职|非求职)\s*$/u;
const TITLE_ONLY_PATTERN = new RegExp(`^(?:${SUMMARY_SECTION_TITLES.join('|')})：$`, 'u');
const SECTION_LINE_PATTERN = new RegExp(
  `^(${SUMMARY_SECTION_TITLES.join('|')})\\s*[:：]?\\s*(.*)$`,
  'u',
);

/**
 * 沉淀摘要输出的确定性格式归一：
 * - 首行「范围：求职 / 非求职」被解析并移除；
 * - Markdown 标题（`## 求职目标`）与加粗（`**求职目标**`）统一为「求职目标：」；
 * - 连续空行折叠。
 *
 * 只做格式，不改写内容：摘要一经写入永不再交给 LLM，格式漂移（09-11 核对到 markdown 与
 * 冒号两种形态并存）必须在写入前收口。
 */
export function parseSummaryOutput(text: string): ParsedSummaryOutput {
  let scope: SummaryScope | null = null;
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (scope === null && lines.length === 0 && SCOPE_LINE_PATTERN.test(line)) {
      scope = SCOPE_LINE_PATTERN.exec(line)?.[1] === '非求职' ? 'other' : 'job_seeking';
      continue;
    }
    const unmarked = line
      .replace(/^#{1,6}\s*/u, '')
      .replace(/^\*\*(.+?)\*\*\s*/u, '$1')
      .trim();
    const section = SECTION_LINE_PATTERN.exec(unmarked);
    if (section) {
      lines.push(`${section[1]}：${section[2].trim()}`);
      continue;
    }
    // Markdown 标题独占一行时正文在下一行：并回标题行，保持「标题：正文」单行形态。
    const previous = lines.at(-1);
    if (previous !== undefined && TITLE_ONLY_PATTERN.test(previous)) {
      lines[lines.length - 1] = `${previous}${unmarked}`;
      continue;
    }
    lines.push(unmarked);
  }

  return { scope, body: lines.join('\n') };
}
