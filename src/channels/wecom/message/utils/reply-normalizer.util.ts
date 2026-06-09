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

  /**
   * 推理/思考标签正则。
   *
   * 业务背景：badcase `recvlEM9V4vBhP`——模型把推理标签 `</think>` 直接作为一条消息
   * 发给候选人（候选人视角是「乱码」）。模型偶发会把 `<think>...</think>` 思考块或落单的
   * 开/闭标签漏进回复，必须在投递层剥离。
   *
   * 处理：成对的 `<think>...</think>` 块整体删除；落单的开/闭标签删除标签本身。
   */
  private static readonly THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/gi;
  private static readonly THINK_TAG_PATTERN = /<\/?think\s*>/gi;

  static normalize(text: string): string {
    if (!text || typeof text !== 'string') return text;

    // 首先移除推理标签、时间标记与 Markdown 装饰符（防御性处理：模型可能漏出思考块/模仿历史格式/Markdown）
    const cleaned = this.removeMarkdownDecoration(
      this.removeTimeMarkers(this.removeThinkTags(text)),
    );

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

  /**
   * 移除推理/思考标签：先删成对的 `<think>...</think>` 块，再清落单的开/闭标签。
   */
  private static removeThinkTags(text: string): string {
    return text.replace(this.THINK_BLOCK_PATTERN, '').replace(this.THINK_TAG_PATTERN, '').trim();
  }

  private static removeMarkdownDecoration(text: string): string {
    return text.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
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

    if (!this.canCompactListItems(listItems)) {
      return lines.join('\n');
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

  private static canCompactListItems(listItems: string[]): boolean {
    return listItems.length > 0 && listItems.every((item) => this.isSimpleOptionItem(item));
  }

  private static isSimpleOptionItem(item: string): boolean {
    const normalized = item.trim();
    if (!normalized) return false;
    if (normalized.length > 24) return false;
    if (/[。；;：:]/.test(normalized)) return false;
    if (/[，,]/.test(normalized) && this.containsJobDetailSignal(normalized)) return false;
    if (/[（）()]/.test(normalized) && this.containsJobDetailSignal(normalized)) return false;
    if (/\d+\s*(?:元|岁|km|公里|小时|点|:|：)/i.test(normalized)) return false;
    return true;
  }

  private static containsJobDetailSignal(text: string): boolean {
    return /(?:离你|距离|薪资|时薪|班次|要求|健康证|小时|工作内容|门店|到店|月结|周结|日结|公里|km)/i.test(
      text,
    );
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
    // 推理/思考标签需要剥离（用非全局字面量，避免 /g 的 lastIndex 副作用）
    if (/<\/?think\s*>/i.test(text)) return true;
    // 时间标记需要清理
    if (this.TIME_MARKER_PATTERN.test(text)) return true;
    // Markdown 装饰符需要清理
    if (/\*\*|__|`/.test(text)) return true;
    // 列表符号需要转自然语言
    if (/^\s*[-*•]\s+/m.test(text)) return true;
    if (/^\s*\d+[\.\)]\s+/m.test(text)) return true;
    // 3+ 连续换行需要规约为双换行
    if (/\n{3,}/.test(text)) return true;
    return false;
  }
}
