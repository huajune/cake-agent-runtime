import {
  appendResumeAttachmentLine,
  appendTimeContext,
  extractQuotedSpeakers,
  hasResumeAttachmentLine,
  isVisualDescriptionText,
  isVisualSourcePart,
  parseTimeContextAt,
  stripQuotedBlocks,
  stripResumeAttachmentLines,
  stripTimeContext,
  stripVisualPrefix,
} from '@/resolution/signal/markers';

/**
 * 标记协议的统一回归边界：全角/半角标点、非句尾与未闭合时间标记、
 * 两种引用块形态都必须经同一契约处理。
 */
describe('infra/message-markup · 时间标记', () => {
  it('写入侧形态可被剥回原文（往返）', () => {
    const raw = '我明天有空';
    const decorated = appendTimeContext(raw, '2026-06-03 12:11 星期三');
    expect(decorated).toBe('我明天有空\n[消息发送时间：2026-06-03 12:11 星期三]');
    expect(stripTimeContext(decorated)).toBe(raw);
  });

  it('认全角括号与全角冒号（窄口径版本剥不掉，锚定即失配）', () => {
    expect(stripTimeContext('好的【消息发送时间:2026-06-03 12:11】')).toBe('好的');
    expect(stripTimeContext('好的【消息发送时间：2026-06-03 12:11】')).toBe('好的');
  });

  it('剥所有位置的标记，不只句尾；未闭合（上游截断）吃到串尾', () => {
    expect(stripTimeContext('前\n[消息发送时间：A]\n中\n[消息发送时间：B]')).toBe('前\n中');
    expect(stripTimeContext('好的 [消息发送时间：2026-06-03 12:11')).toBe('好的');
  });

  it("replaceWith='\\n' 保留子句边界（debounce 合并消息用）", () => {
    // 标记前的空白被 `\s*` 一并吃掉，替换值补回唯一一个换行——两句不会粘连成一句
    expect(stripTimeContext('第一句\n[消息发送时间：A]第二句', '\n')).toBe('第一句\n第二句');
    expect(stripTimeContext('第一句[消息发送时间：A]第二句', '\n')).toBe('第一句\n第二句');
  });

  it('parseTimeContextAt 按北京时间解析；无标记返回 null', () => {
    expect(parseTimeContextAt('嗯\n[消息发送时间：2026-06-03 12:11 星期三]')).toBe(
      Date.parse('2026-06-03T12:11:00+08:00'),
    );
    expect(parseTimeContextAt('嗯')).toBeNull();
  });
});

describe('infra/message-markup · 引用块', () => {
  it('剥方括号形态与行首形态（后者原先只有 memory 一侧认）', () => {
    expect(stripQuotedBlocks('[引用 李经理：岗位要求18岁以上] 我想问下')).toBe('我想问下');
    expect(stripQuotedBlocks('引用 李经理：岗位要求18岁以上\n我想问下')).toBe('我想问下');
  });

  it('replaceWith 决定留不留词边界占位', () => {
    expect(stripQuotedBlocks('前[引用 A：x]后', ' ')).toBe('前 后');
    expect(stripQuotedBlocks('前[引用 A：x]后')).toBe('前后');
  });

  it('extractQuotedSpeakers 取被引用方显示名', () => {
    expect(extractQuotedSpeakers('[引用 高雅琪：岗位卡] 这个还招人吗')).toEqual(['高雅琪']);
    expect(extractQuotedSpeakers('没有引用')).toEqual([]);
  });
});

describe('infra/message-markup · 视觉前缀与占位标签', () => {
  it('描述回写前缀判定与剥离', () => {
    expect(isVisualDescriptionText('[图片消息] 岗位卡片')).toBe(true);
    expect(isVisualDescriptionText('[表情消息] 笑脸')).toBe(true);
    expect(isVisualDescriptionText('我发了张图')).toBe(false);
    expect(stripVisualPrefix('[图片消息] 岗位卡片')).toBe('岗位卡片');
  });

  it('逐 part 判定认选图占位标签（整条 startsWith 会落空）', () => {
    expect(isVisualSourcePart('[图片 messageId=abc123]')).toBe(true);
    expect(isVisualSourcePart('[表情 messageId=abc123]')).toBe(true);
    expect(isVisualSourcePart('[图片消息] 描述')).toBe(true);
    expect(isVisualSourcePart('我叫张三')).toBe(false);
    expect(isVisualSourcePart('')).toBe(false);
  });
});

describe('infra/message-markup · 简历附件行', () => {
  it('追加唯一一行：已有的先剥再加（badcase 6a2fac72 双行）', () => {
    const once = appendResumeAttachmentLine('[图片消息] 简历图片：张三', 'https://a/1.jpg');
    expect(once).toBe('[图片消息] 简历图片：张三\n简历附件：https://a/1.jpg');
    expect(appendResumeAttachmentLine(once, 'https://a/2.jpg')).toBe(
      '[图片消息] 简历图片：张三\n简历附件：https://a/2.jpg',
    );
  });

  it('半角冒号与前置空白同样识别/剥离', () => {
    expect(hasResumeAttachmentLine('描述\n  简历附件: https://a/1.jpg')).toBe(true);
    expect(stripResumeAttachmentLines('描述\n简历附件：https://a/1.jpg')).toBe('描述');
    expect(hasResumeAttachmentLine('描述')).toBe(false);
  });
});
