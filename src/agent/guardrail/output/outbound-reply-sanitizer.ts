/**
 * 确定性出站回复清洗。
 *
 * 只做删除/规整类处理，禁止补词、改写列表、改语义。调用点在 runner outcome 分类前，
 * 保证所有渠道拿到的 TurnOutcome.reply.text / generatedText 已经是清洗后的文本。
 */
export class OutboundReplySanitizer {
  /**
   * 时间标记正则表达式。
   * 匹配历史消息中注入的时间标记，防止模型模仿输出。
   */
  private static readonly TIME_MARKER_PATTERN =
    /[\[【](?:消息发送时间[:：]|t:|当前时间[:：])[^\]\】\n]*(?:[\]\】]|$)/gm;
  private static readonly TIME_MARKER_TEST_PATTERN =
    /[\[【](?:消息发送时间[:：]|t:|当前时间[:：])[^\]\】\n]*(?:[\]\】]|$)/m;

  /**
   * 推理/思考标签：成对的 `<think>...</think>` 块整体删除；落单标签删除标签本身。
   */
  private static readonly THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/gi;
  private static readonly THINK_TAG_PATTERN = /<\/?think\s*>/gi;

  /**
   * 视觉消息占位符（`[图片消息]` / `[表情消息]`）只服务于模型读历史，不应发给候选人。
   */
  private static readonly VISUAL_PLACEHOLDER_PATTERN = /\[(?:图片|表情)消息\]\s?/g;

  /**
   * 兼容历史工具结果及模型自造的岗位模板元标题。若标题前后带空行，MessageSplitter
   * 会把它单独发成一条消息。匹配刻意限制为独立整行，并覆盖“推荐岗位话术模板”一类
   * 受限变体；普通候选人话术里的“推荐这个岗位”不会命中。
   */
  private static readonly INTERNAL_JOB_CARD_BANNER_LINE_PATTERN =
    /^(?:>\s*)?(?:📣\s*)?(?:\*\*)?(?:(?:候选人)?(?:岗位推荐|推荐(?:岗位)?))(?:对话用|对话|话术|用)?模板(?:\*\*)?(?:\s*[：:（(].*)?$/;

  /**
   * 只剥时间标记，不做其它清洗。供出站守卫在审查前调用：模型模仿短期记忆注入格式
   * 输出的 `[消息发送时间：…]` 占全部回合 ~11%（2026-07-24 审计），会污染 LLM 审查
   * 上下文并噪声化守卫档案。刻意不复用 sanitize()——它会剥反引号，破坏
   * internal_output_leak 的围栏检测与 fence_stripped 修复路径。
   */
  static stripTimeMarkers(text: string): string {
    if (!text || typeof text !== 'string') return text;
    return this.cleanWhitespace(this.removeTimeMarkers(text));
  }

  static sanitize(text: string): string {
    if (!text || typeof text !== 'string') return text;

    const cleaned = this.removeMarkdownDecoration(
      this.removeInternalJobCardBanner(
        this.removeTimeMarkers(this.removeVisualPlaceholders(this.removeThinkTags(text))),
      ),
    );

    return this.removeEmptyResidue(this.cleanWhitespace(cleaned));
  }

  private static removeTimeMarkers(text: string): string {
    return text.replace(this.TIME_MARKER_PATTERN, '').trim();
  }

  private static removeThinkTags(text: string): string {
    return text.replace(this.THINK_BLOCK_PATTERN, '').replace(this.THINK_TAG_PATTERN, '').trim();
  }

  private static removeVisualPlaceholders(text: string): string {
    return text.replace(this.VISUAL_PLACEHOLDER_PATTERN, '').trim();
  }

  private static removeInternalJobCardBanner(text: string): string {
    return text
      .split(/\r?\n/)
      .filter((line) => !this.isInternalJobCardBannerLine(line))
      .join('\n')
      .trim();
  }

  private static isInternalJobCardBannerLine(line: string): boolean {
    return this.INTERNAL_JOB_CARD_BANNER_LINE_PATTERN.test(line.trim());
  }

  private static removeMarkdownDecoration(text: string): string {
    return text.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
  }

  private static cleanWhitespace(text: string): string {
    const cleaned = text.replace(/\n{3,}/g, '\n\n');
    const paragraphs = cleaned.split(/\n\n/);
    const processedParagraphs = paragraphs
      .map((paragraph) =>
        paragraph
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join('\n'),
      )
      .filter((paragraph) => paragraph.length > 0);

    return processedParagraphs.join('\n\n');
  }

  private static removeEmptyResidue(text: string): string {
    return /^[\s✅【】\[\]（）()，,。.!！?？:：;；\-_*]+$/.test(text) ? '' : text;
  }

  static needsSanitization(text: string): boolean {
    if (!text) return false;
    if (/<\/?think\s*>/i.test(text)) return true;
    if (/\[(?:图片|表情)消息\]/.test(text)) return true;
    if (this.TIME_MARKER_TEST_PATTERN.test(text)) return true;
    if (text.split(/\r?\n/).some((line) => this.isInternalJobCardBannerLine(line))) return true;
    if (/\*\*|__|`/.test(text)) return true;
    if (/\n{3,}/.test(text)) return true;
    return false;
  }
}
