/**
 * AI 回复文本清洗工具
 * 将 Markdown 格式的列表、分点说明转换为更自然的口语化表达
 *
 * 目标：即使 AI 偶尔生成 Markdown 格式，业务层也能保证发出去的是人话
 */
export class ReplyNormalizer {
  /**
   * 时间标记正则表达式
   * 匹配历史消息中注入的时间标记，防止模型模仿输出
   * 格式：[消息发送时间：...] 或 [t:...] 或 [当前时间: ...]
   * 注意：只删除标记本身，保留前后的换行符（避免文字粘连）
   */
  private static readonly TIME_MARKER_PATTERN =
    /\[消息发送时间：[^\]]+\]|\[t:[^\]]+\]|\[当前时间:[^\]]+\]/g;

  static normalize(text: string): string {
    if (!text || typeof text !== 'string') return text;

    // 首先移除时间标记（防御性处理：模型可能模仿历史消息格式）
    const cleaned = this.removeTimeMarkers(text);

    if (this.containsListMarkers(cleaned)) return this.normalizeComplexStructure(cleaned);
    return this.cleanWhitespace(cleaned);
  }

  /**
   * 移除时间标记
   * 防止模型模仿历史消息中的时间格式
   */
  private static removeTimeMarkers(text: string): string {
    return text.replace(this.TIME_MARKER_PATTERN, '').trim();
  }

  private static containsListMarkers(text: string): boolean {
    return /^\s*[-*•]\s+/m.test(text) || /^\s*\d+[\.\)]\s+/m.test(text);
  }

  private static normalizeComplexStructure(text: string): string {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    const result: string[] = [];
    for (const paragraph of paragraphs) {
      if (this.containsListMarkers(paragraph)) {
        result.push(this.processListParagraph(paragraph));
      } else {
        const cleaned = paragraph.replace(/\n+/g, '').trim();
        if (cleaned) result.push(cleaned);
      }
    }
    return result.join('\n\n');
  }

  private static processListParagraph(paragraph: string): string {
    const lines = paragraph
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const leadingLines: string[] = [];
    const listItems: string[] = [];
    const trailingLines: string[] = [];
    let inList = false;
    let afterList = false;

    for (const line of lines) {
      const isListItem = /^[-*•]\s+/.test(line) || /^\d+[\.\)]\s+/.test(line);
      if (isListItem) {
        inList = true;
        listItems.push(line.replace(/^[-*•]\s+/, '').replace(/^\d+[\.\)]\s+/, ''));
      } else if (inList && !isListItem) {
        afterList = true;
        trailingLines.push(line);
      } else if (!inList) {
        leadingLines.push(line);
      } else if (afterList) {
        trailingLines.push(line);
      }
    }

    const parts: string[] = [];
    if (leadingLines.length > 0) {
      let leadingText = leadingLines.join('');
      leadingText = leadingText.replace(/[，,]?\s*(比如|例如|如|包括)[:：]?\s*$/, '');
      leadingText = this.simplifyQuestionInText(leadingText);
      parts.push(leadingText);
    }
    if (listItems.length > 0) {
      const options = listItems.map((item) => this.extractOptionCore(item));
      parts.push('有' + options.join('、') + '可以选，');
    }
    if (trailingLines.length > 0) {
      let trailingText = trailingLines.join('');
      trailingText = trailingText.replace(/[，,]?\s*$/, '');
      if (trailingText && !trailingText.endsWith('～') && !trailingText.endsWith('哈')) {
        trailingText += '～';
      }
      parts.push(trailingText);
    }
    return parts.join('');
  }

  private static simplifyQuestionInText(text: string): string {
    let simplified = text;
    simplified = simplified.replace(/[，,]?\s*另外[^？?]*[？?]?/g, '');
    simplified = simplified.replace(/的工作([呀吗呢？?])/g, '$1');
    return simplified.trim();
  }

  private static extractOptionCore(option: string): string {
    let core = option.trim();
    core = core.replace(/[（(][^）)]*[）)]/g, '');
    core = core.replace(/(类型|类)$/g, '');
    if (core.includes('/')) core = core.split('/')[0];
    if (core.includes('、')) core = core.split('、')[0];
    if (core.includes('+')) core = core.split('+')[0];
    return core.trim();
  }

  private static cleanWhitespace(text: string): string {
    // 拆分规则：双换行 → 拆成不同消息（交给下游 MessageSplitter）；单换行 → 保留在同一条消息内。
    // 1. 将 3 个及以上的连续换行规约为双换行
    const cleaned = text.replace(/\n{3,}/g, '\n\n');

    // 2. 按双换行分段
    const paragraphs = cleaned.split(/\n\n/);

    // 3. 段内每行 trim 后用单换行拼回，保留候选人可见的换行展示
    const processedParagraphs = paragraphs
      .map((paragraph) => {
        return paragraph
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join('\n');
      })
      .filter((p) => p.length > 0);

    // 4. 段间用双换行连接，供 MessageSplitter 拆分多条消息
    return processedParagraphs.join('\n\n');
  }

  static needsNormalization(text: string): boolean {
    if (!text) return false;
    // 时间标记需要清理
    if (this.TIME_MARKER_PATTERN.test(text)) return true;
    // 列表符号需要转自然语言
    if (/^\s*[-*•]\s+/m.test(text)) return true;
    if (/^\s*\d+[\.\)]\s+/m.test(text)) return true;
    // 3+ 连续换行需要规约为双换行
    if (/\n{3,}/.test(text)) return true;
    return false;
  }
}
