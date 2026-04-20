import { ReplyNormalizer } from '@wecom/message/utils/reply-normalizer.util';

describe('ReplyNormalizer', () => {
  describe('normalize - 换行规则（双换行拆消息，单换行保留）', () => {
    it('段落内单换行应保留，作为同一条消息内的换行', () => {
      const input = `线下面试，时间是周一到周五的中午13点。
帮我发下资料好帮你约：
姓名、电话、年龄
性别
有没有健康证`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe(input);
    });

    it('双换行作为段落分隔，段内单换行原样保留', () => {
      const input = `第一段第一行
第一段第二行

第二段第一行
第二段第二行`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe('第一段第一行\n第一段第二行\n\n第二段第一行\n第二段第二行');
      // 段落间单一双换行供 MessageSplitter 拆分
      expect(result.split('\n\n')).toHaveLength(2);
    });

    it('应去除每行首尾空格，保留换行结构', () => {
      const input = `  我看了下哈

  黄兴大道发这家店暂时
  没在招  `;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe('我看了下哈\n\n黄兴大道发这家店暂时\n没在招');
    });

    it('3+ 连续换行应规约为双换行', () => {
      const input = `第一段


第二段`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe('第一段\n\n第二段');
    });
  });

  describe('needsNormalization', () => {
    it('仅含单换行无需规范化', () => {
      const input = `第一行
第二行`;

      expect(ReplyNormalizer.needsNormalization(input)).toBe(false);
    });

    it('含 3+ 连续换行需要规范化', () => {
      const input = `第一段


第二段`;

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

    it('应该处理混合段落(列表+普通段落)，保留段落分隔', () => {
      const input = `第一段是普通文本

有以下岗位：
- 服务员
- 后厨

第三段也是普通文本`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('第一段是普通文本');
      expect(result).toContain('有服务员、后厨可以选');
      expect(result).toContain('第三段也是普通文本');
      // 段落间保留双换行
      const paragraphs = result.split('\n\n');
      expect(paragraphs).toHaveLength(3);
    });

    it('应该处理列表后的空段落', () => {
      const input = `有以下岗位：
- 服务员
- 后厨


`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨可以选');
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
