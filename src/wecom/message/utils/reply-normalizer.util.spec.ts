import { ReplyNormalizer } from './reply-normalizer.util';

describe('ReplyNormalizer', () => {
  describe('normalize - 段落内换行合并', () => {
    it('应该合并段落内部的单换行符', () => {
      const input = `我看了下哈，黄兴大道发这家店暂时没在招，不过附近你六姐其他店在
招服务员和后厨，时薪都是24元，也是中午班和晚班，要不要我帮你
看看附近的？`;

      const expected = `我看了下哈，黄兴大道发这家店暂时没在招，不过附近你六姐其他店在招服务员和后厨，时薪都是24元，也是中午班和晚班，要不要我帮你看看附近的？`;

      const result = ReplyNormalizer.normalize(input);

      // 验证结果中没有换行符
      expect(result).not.toContain('\n');
      // 验证结果是完整合并的文本
      expect(result).toBe(expected);
    });

    it('应该保留双换行作为段落分隔并合并为单行', () => {
      const input = `我看了下哈，黄兴大道发
这家店暂时没在招。

不过附近你六姐其他店在
招服务员和后厨。`;

      const result = ReplyNormalizer.normalize(input);

      // 验证结果中没有换行符（所有段落合并为一行）
      expect(result).not.toContain('\n');
      // 验证两个段落都被合并
      expect(result).toContain('我看了下哈，黄兴大道发这家店暂时没在招。');
      expect(result).toContain('不过附近你六姐其他店在招服务员和后厨。');
    });

    it('应该去除多余空格和换行', () => {
      const input = `  我看了下哈

  黄兴大道发这家店暂时
  没在招  `;

      const result = ReplyNormalizer.normalize(input);

      // 验证没有换行符
      expect(result).not.toContain('\n');
      // 验证没有多余的空格（trim后）
      expect(result).toBe(result.trim());
    });
  });

  describe('needsNormalization - 检测单换行', () => {
    it('应该检测到段落内的单换行符', () => {
      const input = `我看了下哈，黄兴大道发这家店暂时没在招，不过附近你六姐其他店在
招服务员和后厨，时薪都是24元`;

      expect(ReplyNormalizer.needsNormalization(input)).toBe(true);
    });

    it('应该检测到多行短文本', () => {
      const input = `我看了下哈
黄兴大道
暂时没在招`;

      expect(ReplyNormalizer.needsNormalization(input)).toBe(true);
    });

    it('纯文本无需规范化', () => {
      const input = `我看了下哈，黄兴大道发这家店暂时没在招`;

      expect(ReplyNormalizer.needsNormalization(input)).toBe(false);
    });
  });

  describe('normalize - 列表格式转换', () => {
    it('应该将列表符号转换为自然语言', () => {
      const input = `有以下岗位：
- 服务员
- 后厨
- 收银员`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨、收银员可以选');
      expect(result).not.toContain('-');
      expect(result).not.toContain('\n');
    });

    it('应该处理带前导文本的列表', () => {
      const input = `我们这边有几个岗位，比如：
- 服务员
- 后厨`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨可以选');
      expect(result).not.toContain('比如');
    });

    it('应该处理列表后的尾随文本', () => {
      const input = `有以下岗位：
- 服务员
- 后厨
你看看哪个合适`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨可以选');
      expect(result).toContain('你看看哪个合适～');
    });

    it('应该处理尾随文本已有～的情况', () => {
      const input = `有以下岗位：
- 服务员
- 后厨
你看看哪个合适～`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('你看看哪个合适～');
      // 确保不会重复添加～
      expect(result).not.toContain('～～');
    });

    it('应该处理数字编号列表', () => {
      const input = `有以下选择：
1. 服务员
2. 后厨
3. 收银员`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨、收银员可以选');
      expect(result).not.toContain('1.');
      expect(result).not.toContain('2.');
    });

    it('应该简化列表前的问句', () => {
      const input = `你想找什么类型的工作，另外有什么要求吗？
- 服务员
- 后厨`;

      const result = ReplyNormalizer.normalize(input);

      // 应该移除"另外..."问句
      expect(result).not.toContain('另外');
      expect(result).toContain('有服务员、后厨可以选');
    });

    it('应该处理"的工作"冗余表述', () => {
      const input = `你想找什么类型的工作呀
- 服务员的工作
- 后厨的工作`;

      const result = ReplyNormalizer.normalize(input);

      // "的工作呀" → "呀"
      expect(result).toMatch(/呀/);
      expect(result).not.toMatch(/的工作呀/);
    });
  });

  describe('normalize - 时间标记移除', () => {
    it('应该移除时间标记', () => {
      const input = `[消息发送时间：2024-01-01 12:00:00] 我看了下哈`;
      const result = ReplyNormalizer.normalize(input);

      expect(result).not.toContain('[消息发送时间：');
      expect(result).toContain('我看了下哈');
    });

    it('应该移除多种格式的时间标记', () => {
      const input = `[t:2024-01-01] 第一段
[当前时间: 12:00] 第二段`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).not.toContain('[t:');
      expect(result).not.toContain('[当前时间:');
      expect(result).toContain('第一段');
      expect(result).toContain('第二段');
    });
  });

  describe('normalize - 边界情况', () => {
    it('应该处理空文本', () => {
      expect(ReplyNormalizer.normalize('')).toBe('');
      expect(ReplyNormalizer.normalize(null as any)).toBe(null as any);
      expect(ReplyNormalizer.normalize(undefined as any)).toBe(undefined as any);
    });

    it('应该处理只包含换行的文本', () => {
      const input = '\n\n\n';
      const result = ReplyNormalizer.normalize(input);
      expect(result).toBe('');
    });

    it('应该处理混合段落(列表+普通段落)', () => {
      const input = `第一段是普通文本

有以下岗位：
- 服务员
- 后厨

第三段也是普通文本`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('第一段是普通文本');
      expect(result).toContain('有服务员、后厨可以选');
      expect(result).toContain('第三段也是普通文本');
      expect(result).not.toContain('\n');
    });

    it('应该处理列表后的空段落', () => {
      const input = `有以下岗位：
- 服务员
- 后厨


`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨可以选');
      expect(result).not.toContain('\n');
    });

    it('应该处理尾随文本以"哈"结尾的情况', () => {
      const input = `有以下岗位：
- 服务员
- 后厨
你看看哪个合适哈`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('你看看哪个合适哈');
      // 确保不会添加～(因为已经有"哈"结尾)
      expect(result).not.toMatch(/哈～$/);
    });
  });
});
