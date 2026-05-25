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
    const segments = paragraphSegments
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

      if (this.isIntroLine(line) && i < lines.length - 1) {
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
    return segment
      .trim()
      .replace(/[。！？!?；;：:，,、.．～~…]+$/u, '')
      .trim();
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

  private static isStructuredLine(line: string): boolean {
    return this.isJobLine(line) || this.isDetailLine(line) || this.isFormLine(line);
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
    return /\d+(?:\.\d+)?\s*(?:km|公里)/i.test(normalized) && /[，,、]/.test(normalized);
  }

  private static isListItemLine(line: string): boolean {
    return (
      /^\d+[.、]\s*/.test(line) || /^(?:[（(]?\s*[一二三四五六七八九十\d]+\s*[）)])/.test(line)
    );
  }

  private static isDetailLine(line: string): boolean {
    const normalized = line.trim();
    if (/^(?:班次|上班时间|薪资|要求|地址|门店|工作内容|年龄|距离|时间)[：:]/.test(normalized)) {
      return true;
    }

    return (
      /^(?:班次|上班时间|时间)(?:是|为|\s).*\d{1,2}[:：]\d{2}\s*(?:-|~|—|到|至)\s*\d{1,2}[:：]\d{2}/.test(
        normalized,
      ) ||
      /^薪资(?:是|为|\s).*\d+(?:\.\d+)?(?:\s*(?:-|~|—|到|至)\s*\d+(?:\.\d+)?)?\s*元\s*\/?\s*(?:时|小时|月|天|日)/.test(
        normalized,
      ) ||
      /^要求(?:是|为|\s).*(?:\d+\s*(?:-|~|—|到|至)\s*\d+\s*岁|健康证|经验|学历|社保)/.test(
        normalized,
      ) ||
      /^地址(?:是|为|在|\s).+/.test(normalized)
    );
  }

  private static isFormLine(line: string): boolean {
    return /^(?:姓名|联系方式|电话|手机号|性别|年龄|面试时间|应聘门店|学历|健康证|身份|应聘岗位)[：:]/.test(
      line.trim(),
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
