/**
 * 消息拆分工具类
 * 用于将长消息按双换行符和特殊符号拆分成多个片段
 */
export class MessageSplitter {
  // 常用 emoji 的 Unicode 范围（用于拆分规则）
  // 包含：表情符号、手势、人物、动物、食物、活动、旅行、物品、符号等
  private static readonly EMOJI_PATTERN =
    '(?:' +
    '[\u{1F600}-\u{1F64F}]|' + // 表情符号
    '[\u{1F300}-\u{1F5FF}]|' + // 杂项符号和象形文字
    '[\u{1F680}-\u{1F6FF}]|' + // 交通和地图符号
    '[\u{1F1E0}-\u{1F1FF}]|' + // 旗帜
    '[\u{2600}-\u{26FF}]|' + // 杂项符号
    '[\u{2700}-\u{27BF}]|' + // 装饰符号
    '[\u{1F900}-\u{1F9FF}]|' + // 补充符号和象形文字
    '[\u{1FA00}-\u{1FA6F}]|' + // 国际象棋符号
    '[\u{1FA70}-\u{1FAFF}]' + // 符号和象形文字扩展-A
    ')';

  /**
   * 将消息文本按双换行符、"～"符号、emoji 和句子结束符拆分成多个片段
   * 拆分规则优先级：
   *   1. 双换行符（\n\n）
   *   2. "～"符号（后面跟着中文、标点等）
   *   3. emoji 表情（后面跟着中文）
   *   4. 句子结束符（"。"和"？"）后面跟着中文时拆分
   * 注意：
   *   - 单个换行符不拆分
   *   - 逗号不作为拆分点，即使后面是问句
   * @param text 原始消息文本
   * @returns 拆分后的消息片段数组（已过滤空行）
   */
  static split(text: string): string[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    // 首先按双换行符拆分（支持 \n\n 和 \r\n\r\n）
    const lineSegments = text.split(/(?:\r?\n){2,}/);

    // 对每一段再按"～"符号拆分
    // 只拆分后面跟着中文、标点、空白或 * 的～(作为分隔符),不拆分夹在数字/字母之间的～
    let allSegments: string[] = [];
    for (const segment of lineSegments) {
      const trimmedSegment = segment.trim();
      if (!trimmedSegment) continue;

      // 按"～"拆分，但只拆分作为分隔符的～(后面跟着中文、标点、空白或*)
      // 保留"～"在前一个片段的末尾
      const tildeSegments = trimmedSegment.split(
        /(?<=～(?=[\u4e00-\u9fa5\s*？！，。：；""''、（）【】《》…—·\u3000]))/,
      );
      allSegments.push(...tildeSegments);
    }

    // 对每一段再按 emoji 拆分（emoji 后面跟着中文时拆分）
    // 例如："黄浦这边兼职岗位也比较少哈😅我再帮你看看" → ["黄浦这边兼职岗位也比较少哈😅", "我再帮你看看"]
    const emojiSegments: string[] = [];
    const emojiSplitRegex = new RegExp(`(?<=${this.EMOJI_PATTERN})(?=[\\u4e00-\\u9fa5])`, 'gu');
    for (const segment of allSegments) {
      const trimmedSegment = segment.trim();
      if (!trimmedSegment) continue;
      const parts = trimmedSegment.split(emojiSplitRegex);
      emojiSegments.push(...parts);
    }
    allSegments = emojiSegments;

    // 对每一段再按句子结束符拆分（"。"和"？"都是句子结束符）
    // 规则：句子结束符后面跟着中文时，在结束符后拆分（结束符保留在前一句）
    // 例如："好的。请问您现在是学生吗？" → ["好的。", "请问您现在是学生吗？"]
    // 例如："要不要一起看看？或者你喜欢哪个？" → ["要不要一起看看？", "或者你喜欢哪个？"]
    // 注意：逗号不拆分，保持句子完整性
    // 例如："或者你对其他品牌感兴趣吗，比如奥乐齐？" → 不拆分，保持完整
    const sentenceSegments: string[] = [];
    for (const segment of allSegments) {
      const trimmedSegment = segment.trim();
      if (!trimmedSegment) continue;

      // 按句号拆分（句号后面跟着中文）
      const parts = trimmedSegment.split(/(?<=。)(?=[\u4e00-\u9fa5])/);

      // 按问号拆分（问号后面跟着中文）
      const finalParts: string[] = [];
      for (const part of parts) {
        const subParts = part.split(/(?<=？)(?=[\u4e00-\u9fa5])/);
        finalParts.push(...subParts);
      }
      sentenceSegments.push(...finalParts);
    }
    allSegments = sentenceSegments;

    // 过滤掉空片段和只包含空白字符的片段，清理分隔符
    const nonEmptySegments = allSegments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        // 删除末尾的～分隔符
        segment = segment.replace(/～+$/g, '');
        // 删除末尾的逗号（拆分后残留）
        segment = segment.replace(/，+$/g, '');
        // 删除所有的*符号
        segment = segment.replace(/\*/g, '');
        return segment.trim();
      })
      .filter((segment) => segment.length > 0); // 再次过滤，去掉只剩下特殊符号的片段

    return nonEmptySegments;
  }

  /**
   * 将消息文本按换行符拆分成多个片段（保持向后兼容）
   * @param text 原始消息文本
   * @returns 拆分后的消息片段数组（已过滤空行）
   */
  static splitByNewlines(text: string): string[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    // 按换行符拆分（支持 \n 和 \r\n）
    const segments = text.split(/\r?\n/);

    // 过滤掉空行和只包含空白字符的行
    const nonEmptySegments = segments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    return nonEmptySegments;
  }

  /**
   * 检查消息是否需要拆分
   * @param text 消息文本
   * @returns 是否包含需要拆分的模式
   */
  static needsSplit(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }
    // 检查是否包含：
    // 1. 双换行符
    // 2. "～"符号
    // 3. emoji 后面跟着中文
    // 4. 句子结束符（"。"或"？"）后面跟着中文

    // 基本规则检查
    if (/(?:\r?\n){2,}|～|[。？][\u4e00-\u9fa5]/.test(text)) {
      return true;
    }

    // emoji 后面跟着中文的检查
    const emojiFollowedByChinese = new RegExp(`${this.EMOJI_PATTERN}[\\u4e00-\\u9fa5]`, 'u');
    return emojiFollowedByChinese.test(text);
  }

  /**
   * 获取拆分后的片段数量
   * @param text 消息文本
   * @returns 拆分后的片段数量
   */
  static getSegmentCount(text: string): number {
    return this.splitByNewlines(text).length;
  }
}
