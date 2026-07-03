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

    it('Markdown 装饰符需要规范化', () => {
      expect(ReplyNormalizer.needsNormalization('**重点**：附近有岗位')).toBe(true);
      expect(ReplyNormalizer.needsNormalization('`重点`：附近有岗位')).toBe(true);
    });

    it('含推理/思考标签需要规范化', () => {
      expect(ReplyNormalizer.needsNormalization('</think>')).toBe(true);
      expect(ReplyNormalizer.needsNormalization('<think>先想想</think>好的')).toBe(true);
      // 多次调用结果稳定（防 /g lastIndex 副作用）
      expect(ReplyNormalizer.needsNormalization('</think>')).toBe(true);
    });

    it('含视觉消息占位符需要规范化', () => {
      expect(ReplyNormalizer.needsNormalization('[表情消息] 好的')).toBe(true);
      expect(ReplyNormalizer.needsNormalization('[图片消息]收到啦')).toBe(true);
      // 多次调用结果稳定（防 /g lastIndex 副作用）
      expect(ReplyNormalizer.needsNormalization('[表情消息] 好的')).toBe(true);
    });
  });

  describe('normalize - 视觉消息占位符剥离（badcase batch_6a32692a..._1781689143249）', () => {
    it('应剥离模型复述的 [表情消息] 占位符及其后空格', () => {
      expect(ReplyNormalizer.normalize('[表情消息] 好的')).toBe('好的');
    });

    it('应剥离 [图片消息] 占位符', () => {
      expect(ReplyNormalizer.normalize('[图片消息]收到啦，帮你看看')).toBe('收到啦，帮你看看');
    });

    it('占位符单独成段时整体清空', () => {
      expect(ReplyNormalizer.normalize('[表情消息]')).toBe('');
    });

    it('不影响正常文本', () => {
      expect(ReplyNormalizer.normalize('好的，附近有岗位')).toBe('好的，附近有岗位');
    });
  });

  describe('normalize - 推理/思考标签剥离（badcase recvlEM9V4vBhP）', () => {
    it('应删除落单的闭合标签 </think>', () => {
      expect(ReplyNormalizer.normalize('</think>')).toBe('');
      expect(ReplyNormalizer.normalize('好的，你先看看哈\n\n</think>')).toBe('好的，你先看看哈');
    });

    it('应整体删除成对的 <think>...</think> 思考块', () => {
      const input = '<think>候选人在宝山，先查附近岗位</think>你好呀，帮你看下附近的岗位';
      expect(ReplyNormalizer.normalize(input)).toBe('你好呀，帮你看下附近的岗位');
    });

    it('应删除跨行的思考块', () => {
      const input = `<think>
这里是模型的推理
分了好几行
</think>
你好呀`;
      expect(ReplyNormalizer.normalize(input)).toBe('你好呀');
    });

    it('大小写不敏感', () => {
      expect(ReplyNormalizer.normalize('<THINK>x</THINK>正文')).toBe('正文');
    });
  });

  describe('normalize - Markdown 装饰符清理', () => {
    it('应该去除加粗和行内代码符号', () => {
      const input = '**重点**：`成都你六姐` 这家还在招，薪资 __24 元/小时__。';

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe('重点：成都你六姐 这家还在招，薪资 24 元/小时。');
    });

    it('不应影响星号列表识别', () => {
      const input = `有以下岗位：
* **服务员**
* **后厨**`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('有服务员、后厨可以选');
      expect(result).not.toContain('*');
      expect(result).not.toContain('**');
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

    it('不应改写包含岗位明细的数字编号列表', () => {
      const input = `帮你看了下，附近有两家成都你六姐在招前厅。

1. 鑫都满天星店，离你 3.6km。 24 元/小时（每月超 40 小时后是 26 元，超 80 小时后 28 元），班次是晚上 9 点到 12 点半。要求 20 岁以上，得办食品健康证。
2. 莘庄龙之梦店，离你 9.2km。薪资一样，班次是中午 11 点半到 2 点半，要求 20 到 35 岁。

你看哪个时间更方便？`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe(input);
      expect(result).toContain('24 元/小时');
      expect(result).toContain('班次是晚上 9 点到 12 点半');
      expect(result).toContain('得办食品健康证');
      expect(result).not.toContain('可以选');
    });

    it('不应改写卡片式岗位列表（编号行只有店名，明细换行另起）（badcase 6a470fddce406a6aeee03d0d）', () => {
      const input = `帮你查到了，陈村附近有几家必胜客在招，都在顺德大良那边，离你不远。

1. 必胜客（顺德大润发店）- 餐厅服务员
班次：10:00-23:00（排班窗口，实际按门店排班）
薪资：12.8 元/时起，做满 100 小时 14.9 元/时，满 190 小时 17.2 元/时
要求：18-50 岁

2. 必胜客（顺德欢乐海岸店）- 餐厅服务员
班次：10:00-23:00（排班窗口，实际按门店排班）
薪资：12.8 元/时起，做满 100 小时 14.9 元/时，满 190 小时 17.2 元/时
要求：18-50 岁

3. 必胜客（顺德山姆店）- 餐厅服务员
班次：10:00-23:00（排班窗口，实际按门店排班）
薪资：12.8 元/时起，做满 100 小时 14.9 元/时，满 190 小时 17.2 元/时
要求：18-50 岁

这几家都是做排班的，10 点到 23 点是可排时段，不是要上满一整天。你看哪家离你更方便，或者想先面哪家？`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toBe(input);
      expect(result).toContain('必胜客（顺德大润发店）');
      expect(result).toContain('必胜客（顺德欢乐海岸店）');
      expect(result).toContain('必胜客（顺德山姆店）');
      expect(result).not.toContain('可以选');
    });

    it('不应剥离短选项列表中括号里的店名', () => {
      const input = `有这几家可以看看：
1. 必胜客（大润发店）
2. 必胜客（山姆店）`;

      const result = ReplyNormalizer.normalize(input);

      expect(result).toContain('必胜客（大润发店）');
      expect(result).toContain('必胜客（山姆店）');
      expect(result).not.toContain('必胜客、必胜客');
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
