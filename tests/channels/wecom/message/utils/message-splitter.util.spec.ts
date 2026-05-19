import { MessageSplitter } from '@wecom/message/utils/message-splitter.util';

describe('MessageSplitter', () => {
  describe('split', () => {
    it('按双换行拆分消息', () => {
      const text = '第一段\n\n第二段\r\n\r\n第三段';

      expect(MessageSplitter.split(text)).toEqual(['第一段', '第二段', '第三段']);
    });

    it('保留单换行内的列表结构', () => {
      const text = `我们有以下岗位：
1. 前端工程师
2. 后端工程师`;

      expect(MessageSplitter.split(text)).toEqual([text]);
    });

    it('不按句号、问号、～ 或 emoji 拆分', () => {
      const text = '好的。请问您现在方便吗？我看了下～附近有门店😊要不要看看？';

      expect(MessageSplitter.split(text)).toEqual([text]);
    });

    it('不清理正文符号，只负责拆分', () => {
      const text = '**第一段～**\n\n第二段，';

      expect(MessageSplitter.split(text)).toEqual(['**第一段～**', '第二段，']);
    });

    it('详细岗位编号列表按显式段落边界拆分', () => {
      const text = `帮你看了下，附近有两家成都你六姐在招前厅。

1. 鑫都满天星店，离你 3.6km。 24 元/小时（每月超 40 小时后是 26 元，超 80 小时后 28 元），班次是晚上 9 点到 12 点半。要求 20 岁以上，得办食品健康证。
2. 莘庄龙之梦店，离你 9.2km。薪资一样，班次是中午 11 点半到 2 点半，要求 20 到 35 岁。

你看哪个时间更方便？`;

      expect(MessageSplitter.split(text)).toEqual([
        '帮你看了下，附近有两家成都你六姐在招前厅。',
        '1. 鑫都满天星店，离你 3.6km。 24 元/小时（每月超 40 小时后是 26 元，超 80 小时后 28 元），班次是晚上 9 点到 12 点半。要求 20 岁以上，得办食品健康证。\n2. 莘庄龙之梦店，离你 9.2km。薪资一样，班次是中午 11 点半到 2 点半，要求 20 到 35 岁。',
        '你看哪个时间更方便？',
      ]);
    });

    it('超过段数上限时合并最短相邻段', () => {
      const text = ['一', '第二段比较长', '三', '第四段也比较长', '五'].join('\n\n');

      expect(MessageSplitter.split(text, 3)).toEqual([
        '一\n第二段比较长',
        '三\n第四段也比较长',
        '五',
      ]);
    });

    it('处理空字符串、空段落和非字符串输入', () => {
      expect(MessageSplitter.split('')).toEqual([]);
      expect(MessageSplitter.split('\n\n\n')).toEqual([]);
      expect(MessageSplitter.split(null as any)).toEqual([]);
      expect(MessageSplitter.split(undefined as any)).toEqual([]);
    });
  });

  describe('needsSplit', () => {
    it('只有双换行才需要拆分', () => {
      expect(MessageSplitter.needsSplit('第一段\n\n第二段')).toBe(true);
      expect(MessageSplitter.needsSplit('第一段\r\n\r\n第二段')).toBe(true);
      expect(MessageSplitter.needsSplit('第一行\n第二行')).toBe(false);
      expect(MessageSplitter.needsSplit('好的。请问您现在方便吗？')).toBe(false);
      expect(MessageSplitter.needsSplit('我看了下～附近有门店')).toBe(false);
      expect(MessageSplitter.needsSplit('好消息😊附近有门店')).toBe(false);
    });

    it('空内容不需要拆分', () => {
      expect(MessageSplitter.needsSplit('')).toBe(false);
      expect(MessageSplitter.needsSplit(null as any)).toBe(false);
      expect(MessageSplitter.needsSplit(undefined as any)).toBe(false);
    });
  });

  describe('splitByNewlines', () => {
    it('保留历史 helper 的单换行拆分行为', () => {
      expect(MessageSplitter.splitByNewlines('第一行\n第二行\n\n第三行')).toEqual([
        '第一行',
        '第二行',
        '第三行',
      ]);
    });
  });

  describe('getSegmentCount', () => {
    it('保留历史单换行计数行为', () => {
      expect(MessageSplitter.getSegmentCount('第一行\n第二行')).toBe(2);
      expect(MessageSplitter.getSegmentCount('第一段\n\n第二段')).toBe(2);
      expect(MessageSplitter.getSegmentCount('')).toBe(0);
    });
  });
});
