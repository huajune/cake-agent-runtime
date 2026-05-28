/**
 * 消息拆分工具类。
 *
 * 发送层支持两类边界：
 * - 显式段落边界：两个及以上连续换行符；
 * - 轻量句子边界：普通话术内后面仍有正文的 "～" 或 "。"。
 *
 * 岗位/表单等结构化块会保留完整；最终发送片段会去掉末尾标点。
 */
export class MessageSplitter {
  /**
   * 将消息文本拆分成多个发送片段。
   *
   * 单个换行保留在同一条消息内，用于列表/多行展示；发送片段末尾标点会被移除。
   *
   * @param text 原始消息文本
   * @param maxSegments 可选段数上限。超过时合并最短相邻段（防御性兜底，
   *   避免 Agent 写得过碎导致一次发 N 条消息刷屏）。
   */
  static split(text: string, maxSegments?: number): string[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const paragraphSegments = text
      .split(/(?:\r?\n){2,}/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const segments = this.mergeAdjacentFormBlocks(paragraphSegments)
      .flatMap((segment) => this.splitParagraph(segment))
      .map((segment) => this.stripTrailingPunctuation(segment))
      .filter((segment) => segment.length > 0);

    if (maxSegments && segments.length > maxSegments) {
      return this.coalesceToCap(segments, maxSegments);
    }

    return segments;
  }

  /**
   * 贪心合并最短相邻段，把段数压到 ≤ cap。
   * 用于防御性兜底，避免 Agent 写得过碎时一次发出太多消息。
   */
  private static coalesceToCap(segments: string[], cap: number): string[] {
    const result = segments.slice();
    while (result.length > cap) {
      let mergeIdx = 0;
      let minTotalLen = Infinity;
      for (let i = 0; i < result.length - 1; i += 1) {
        const totalLen = result[i].length + result[i + 1].length;
        if (totalLen < minTotalLen) {
          minTotalLen = totalLen;
          mergeIdx = i;
        }
      }
      result.splice(mergeIdx, 2, `${result[mergeIdx]}\n${result[mergeIdx + 1]}`);
    }
    return result;
  }

  private static mergeAdjacentFormBlocks(segments: string[]): string[] {
    const result: string[] = [];

    for (let i = 0; i < segments.length; i += 1) {
      const current = segments[i];
      const next = segments[i + 1];

      if (next && this.isFormIntroParagraph(current) && this.isFormParagraph(next)) {
        result.push(`${current}\n${next}`);
        i += 1;
        continue;
      }

      result.push(current);
    }

    return result;
  }

  /**
   * 普通单行话术按所有可用 "～" / "。" 拆；多行文本里，岗位详情/表单块保持完整。
   */
  private static splitParagraph(segment: string): string[] {
    const lines = segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) {
      if (this.isStructuredLine(segment)) {
        return [segment];
      }
      return this.splitBySentenceBoundaries(segment);
    }

    const result: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      const formBlockEnd = this.findFormBlockEnd(lines, i);
      if (formBlockEnd > i) {
        result.push(lines.slice(i, formBlockEnd).join('\n'));
        i = formBlockEnd - 1;
        continue;
      }

      if (this.isIntroLine(line) && i < lines.length - 1) {
        const introFormBlockEnd = this.findFormBlockEnd(lines, i + 1);
        if (introFormBlockEnd > i + 1) {
          result.push(lines.slice(i, introFormBlockEnd).join('\n'));
          i = introFormBlockEnd - 1;
          continue;
        }

        let end = i + 1;
        while (end < lines.length && this.isStructuredLine(lines[end])) {
          end += 1;
        }
        if (end > i + 1) {
          result.push(lines.slice(i, end).join('\n'));
          i = end - 1;
          continue;
        }
      }

      if (
        this.isStructuredHeaderLine(line) &&
        i < lines.length - 1 &&
        this.isStructuredLine(lines[i + 1])
      ) {
        let end = i + 1;
        while (end < lines.length && this.isStructuredLine(lines[end])) {
          end += 1;
        }
        result.push(lines.slice(i, end).join('\n'));
        i = end - 1;
        continue;
      }

      if (this.isStructuredLine(line)) {
        let end = i + 1;
        while (end < lines.length && this.isStructuredLine(lines[end])) {
          end += 1;
        }
        result.push(lines.slice(i, end).join('\n'));
        i = end - 1;
        continue;
      }

      result.push(...this.splitBySentenceBoundaries(line));
    }

    return result;
  }

  private static splitBySentenceBoundaries(segment: string): string[] {
    const result: string[] = [];
    let start = 0;

    for (let i = 0; i < segment.length; i += 1) {
      if (!this.isSentenceBoundary(segment[i])) continue;

      const headText = segment.slice(start, i).trim();
      const tailText = segment.slice(i + 1).replace(/^[\s*_`"'”’）】》〉，,。！？!?；;：:]+/, '');
      if (headText.length === 0 || tailText.trim().length === 0) continue;

      result.push(headText);
      start = i + 1;
    }

    const rest = segment.slice(start).trim();
    if (rest) result.push(rest);
    return result.length > 0 ? result : [segment];
  }

  static stripTrailingPunctuation(segment: string): string {
    if (!segment || typeof segment !== 'string') {
      return '';
    }
    const trimmed = segment.trim();
    const trailingLine = this.getTrailingLine(trimmed);
    if (this.isBlankFormFieldLine(trailingLine, trimmed)) {
      return trimmed.replace(/[。！？!?；;，,、.．～~…]+$/u, '').trim();
    }

    return trimmed.replace(/[。！？!?；;：:，,、.．～~…]+$/u, '').trim();
  }

  private static isSentenceBoundary(char: string): boolean {
    return char === '～' || char === '。';
  }

  private static findSentenceBoundaryIndex(segment: string): number {
    for (let i = 0; i < segment.length; i += 1) {
      if (!this.isSentenceBoundary(segment[i])) continue;
      const headText = segment.slice(0, i).trim();
      const tailText = segment.slice(i + 1).replace(/^[\s*_`"'”’）】》〉，,。！？!?；;：:]+/, '');
      if (headText.length > 0 && tailText.trim().length > 0) {
        return i;
      }
    }
    return -1;
  }

  private static isIntroLine(line: string): boolean {
    return /[：:]$/.test(line.trim());
  }

  private static isFormIntroParagraph(segment: string): boolean {
    const lines = segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.length === 1 && this.isIntroLine(lines[0]);
  }

  private static isFormParagraph(segment: string): boolean {
    const lines = segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.length > 0 && this.findFormBlockEnd(lines, 0) === lines.length;
  }

  private static isStructuredLine(line: string): boolean {
    return this.isJobLine(line) || this.isDetailLine(line) || this.isKnownFormLine(line);
  }

  private static isJobLine(line: string): boolean {
    const normalized = line.trim();
    if (this.isListItemLine(normalized)) return true;

    const hasDistance = /\d+(?:\.\d+)?\s*(?:km|公里)/i.test(normalized);
    const hasWorkTime = /\d{1,2}[:：]\d{2}\s*(?:-|~|—|到|至)\s*\d{1,2}[:：]\d{2}/.test(normalized);
    const hasSalary =
      /\d+(?:\.\d+)?(?:\s*(?:-|~|—|到|至)\s*\d+(?:\.\d+)?)?\s*元\s*\/?\s*(?:时|小时|月|天|日)/.test(
        normalized,
      );
    const hasAgeRange = /\d+\s*(?:-|~|—|到|至)\s*\d+\s*岁/.test(normalized);
    const structuredFieldCount = [hasDistance, hasWorkTime, hasSalary, hasAgeRange].filter(
      Boolean,
    ).length;
    const delimitedPartCount = normalized.split(/[，,、；;]/).filter((part) => part.trim()).length;

    return structuredFieldCount >= 2 && delimitedPartCount >= 2;
  }

  private static isStructuredHeaderLine(line: string): boolean {
    const normalized = line.trim();
    return /\d+(?:\.\d+)?\s*(?:km|公里)/i.test(normalized) || this.isLikelyJobTitleLine(normalized);
  }

  private static isLikelyJobTitleLine(line: string): boolean {
    if (/[。！？!?；;：:]$/.test(line) || line.length > 80) return false;
    return /[（(].+[）)]/.test(line) || /(?:店|门店|广场|中心|天街|天地|坊|汇)/.test(line);
  }

  private static isListItemLine(line: string): boolean {
    return (
      /^\d+[.、]\s*/.test(line) || /^(?:[（(]?\s*[一二三四五六七八九十\d]+\s*[）)])/.test(line)
    );
  }

  private static isDetailLine(line: string): boolean {
    const normalized = line.trim();
    if (
      /^(?:班次|上班时间|薪资|要求|地址|门店|工作内容|年龄|距离|时间|福利)[：:]/.test(normalized)
    ) {
      return true;
    }

    return (
      /^(?:距离|离你|离您)(?:约|大概|大约|是|为|在|\s)*\d+(?:\.\d+)?\s*(?:km|公里)/i.test(
        normalized,
      ) ||
      /^(?:早班|中班|晚班|夜班|白班|午班).*\d{1,2}[:：]\d{2}\s*(?:-|~|—|到|至)\s*\d{1,2}[:：]\d{2}/.test(
        normalized,
      ) ||
      /^\d{1,2}[:：]\d{2}\s*(?:-|~|—|到|至)\s*\d{1,2}[:：]\d{2}/.test(normalized) ||
      /^(?:班次|上班时间|时间)(?:是|为|\s).*\d{1,2}[:：]\d{2}\s*(?:-|~|—|到|至)\s*\d{1,2}[:：]\d{2}/.test(
        normalized,
      ) ||
      /^薪资(?:是|为|\s).*\d+(?:\.\d+)?(?:\s*(?:-|~|—|到|至)\s*\d+(?:\.\d+)?)?\s*元\s*\/?\s*(?:时|小时|月|天|日)/.test(
        normalized,
      ) ||
      /^要求(?:是|为|\s).*(?:\d+\s*(?:-|~|—|到|至)\s*\d+\s*岁|健康证|经验|学历|社保)/.test(
        normalized,
      ) ||
      /^地址(?:是|为|在|\s).+/.test(normalized) ||
      /^福利(?:是|为|\s).+/.test(normalized)
    );
  }

  private static isFormLine(line: string): boolean {
    return this.isKnownFormLine(line) || this.isGenericFormFieldLine(line);
  }

  private static isKnownFormLine(line: string): boolean {
    return /^(?:姓名|联系方式|联系电话|电话|手机号|性别|年龄|出生日期|生日|出生年月|面试时间|应聘门店|学历|健康证|食品健康证|有无食品健康证|身份|应聘岗位|有无分拣经验|分拣经验|工作经验|过往经历|过往工作经历)(?:[（(][^）)]*[）)])?[：:]/.test(
      line.trim(),
    );
  }

  private static isGenericFormFieldLine(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    const delimiterIndex = this.findFormDelimiterIndex(normalized);
    if (delimiterIndex <= 0) return false;

    const label = normalized.slice(0, delimiterIndex).replace(/[*_`]/g, '').trim();
    if (label.length === 0 || label.length > 48) return false;
    if (/^[\d\s:：./\\-]+$/.test(label)) return false;
    if (/[，,。！？!?；;]/.test(label)) return false;

    return true;
  }

  private static findFormDelimiterIndex(line: string): number {
    if (/[：:]$/.test(line)) {
      return Math.max(line.lastIndexOf('：'), line.lastIndexOf(':'));
    }

    const fullWidthIndex = line.indexOf('：');
    const halfWidthIndex = line.indexOf(':');
    if (fullWidthIndex < 0) return halfWidthIndex;
    if (halfWidthIndex < 0) return fullWidthIndex;
    return Math.min(fullWidthIndex, halfWidthIndex);
  }

  private static findFormBlockEnd(lines: string[], start: number): number {
    let end = start;
    while (end < lines.length && this.isFormLine(lines[end])) {
      end += 1;
    }

    const count = end - start;
    if (count >= 2) return end;
    if (count === 1 && this.isKnownFormLine(lines[start])) return end;
    return start;
  }

  private static getTrailingLine(segment: string): string {
    const lines = segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines[lines.length - 1] ?? '';
  }

  private static isBlankFormFieldLine(line: string, segment: string): boolean {
    const normalized = line.trim();
    if (!/[：:]$/.test(normalized)) return false;
    if (this.isKnownFormLine(normalized)) return true;
    return this.isGenericFormFieldLine(normalized) && this.isFormBlockSegment(segment);
  }

  private static isFormBlockSegment(segment: string): boolean {
    const lines = segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return false;
    if (this.findFormBlockEnd(lines, 0) === lines.length) return true;

    return (
      lines.length > 1 &&
      this.isIntroLine(lines[0]) &&
      this.findFormBlockEnd(lines, 1) === lines.length
    );
  }

  /**
   * 将消息文本按单个换行符拆分成多个片段（历史兼容 helper，不用于发送拆分决策）。
   */
  static splitByNewlines(text: string): string[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    return text
      .split(/\r?\n/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  /**
   * 双换行，或后面仍有正文的 "～" / "。" 表示需要拆成多条企微消息。
   */
  static needsSplit(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }
    return /(?:\r?\n){2,}/.test(text) || this.findSentenceBoundaryIndex(text) >= 0;
  }

  static getSegmentCount(text: string): number {
    return this.splitByNewlines(text).length;
  }
}
