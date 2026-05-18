/**
 * 消息拆分工具类。
 *
 * 发送层只认显式段落边界：两个及以上连续换行符。不要按句号、问号、
 * emoji、"～" 等内容符号推断拆分，否则会破坏岗位列表、薪资说明等结构化回复。
 */
export class MessageSplitter {
  /**
   * 将消息文本按两个及以上连续换行符拆分成多个发送片段。
   *
   * 单个换行保留在同一条消息内，用于列表/多行展示；内容标点和符号不做改写。
   *
   * @param text 原始消息文本
   * @param maxSegments 可选段数上限。超过时合并最短相邻段（防御性兜底，
   *   避免 Agent 写得过碎导致一次发 N 条消息刷屏）。
   */
  static split(text: string, maxSegments?: number): string[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const segments = text
      .split(/(?:\r?\n){2,}/)
      .map((segment) => segment.trim())
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
   * 只有两个及以上连续换行符才表示需要拆成多条企微消息。
   */
  static needsSplit(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }
    return /(?:\r?\n){2,}/.test(text);
  }

  static getSegmentCount(text: string): number {
    return this.splitByNewlines(text).length;
  }
}
