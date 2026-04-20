import { MessageSplitter } from '@wecom/message/utils/message-splitter.util';

describe('MessageSplitter', () => {
  describe('splitByNewlines', () => {
    it('应该按换行符拆分消息', () => {
      const text = '第一行\n第二行\n第三行';
      const result = MessageSplitter.splitByNewlines(text);
      expect(result).toEqual(['第一行', '第二行', '第三行']);
    });

    it('应该处理 Windows 风格的换行符', () => {
      const text = '第一行\r\n第二行\r\n第三行';
      const result = MessageSplitter.splitByNewlines(text);
      expect(result).toEqual(['第一行', '第二行', '第三行']);
    });

    it('应该过滤掉空行', () => {
      const text = '第一行\n\n第二行\n   \n第三行';
      const result = MessageSplitter.splitByNewlines(text);
      expect(result).toEqual(['第一行', '第二行', '第三行']);
    });

    it('应该处理只有空格的行', () => {
      const text = '第一行\n   \n第二行';
      const result = MessageSplitter.splitByNewlines(text);
      expect(result).toEqual(['第一行', '第二行']);
    });

    it('应该去除每行前后的空格', () => {
      const text = '  第一行  \n  第二行  \n  第三行  ';
      const result = MessageSplitter.splitByNewlines(text);
      expect(result).toEqual(['第一行', '第二行', '第三行']);
    });

    it('对于空字符串应该返回空数组', () => {
      const result = MessageSplitter.splitByNewlines('');
      expect(result).toEqual([]);
    });

    it('对于只包含换行符的字符串应该返回空数组', () => {
      const result = MessageSplitter.splitByNewlines('\n\n\n');
      expect(result).toEqual([]);
    });

    it('对于不包含换行符的字符串应该返回包含该字符串的数组', () => {
      const text = '这是一条单行消息';
      const result = MessageSplitter.splitByNewlines(text);
      expect(result).toEqual(['这是一条单行消息']);
    });

    it('应该处理 null 和 undefined', () => {
      expect(MessageSplitter.splitByNewlines(null as any)).toEqual([]);
      expect(MessageSplitter.splitByNewlines(undefined as any)).toEqual([]);
    });
  });

  describe('needsSplit', () => {
    it('包含双换行符时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('第一段\n\n第二段')).toBe(true);
      expect(MessageSplitter.needsSplit('第一段\r\n\r\n第二段')).toBe(true);
    });

    it('只包含单换行符时应该返回 false', () => {
      expect(MessageSplitter.needsSplit('第一行\n第二行')).toBe(false);
      expect(MessageSplitter.needsSplit('第一行\r\n第二行')).toBe(false);
    });

    it('不包含换行符时应该返回 false', () => {
      expect(MessageSplitter.needsSplit('这是一条单行消息')).toBe(false);
    });

    it('对于空字符串应该返回 false', () => {
      expect(MessageSplitter.needsSplit('')).toBe(false);
    });

    it('对于 null 和 undefined 应该返回 false', () => {
      expect(MessageSplitter.needsSplit(null as any)).toBe(false);
      expect(MessageSplitter.needsSplit(undefined as any)).toBe(false);
    });
  });

  describe('getSegmentCount', () => {
    it('应该返回正确的片段数量', () => {
      expect(MessageSplitter.getSegmentCount('第一行\n第二行\n第三行')).toBe(3);
    });

    it('应该过滤空行后返回正确的数量', () => {
      expect(MessageSplitter.getSegmentCount('第一行\n\n第二行\n第三行')).toBe(3);
    });

    it('对于单行消息应该返回 1', () => {
      expect(MessageSplitter.getSegmentCount('这是一条单行消息')).toBe(1);
    });

    it('对于空字符串应该返回 0', () => {
      expect(MessageSplitter.getSegmentCount('')).toBe(0);
    });
  });

  describe('实际应用场景测试', () => {
    it('应该正确拆分 Agent 的多段回复（使用双换行符）', () => {
      const agentReply = `您好！很高兴为您服务。

我们目前有以下几个岗位：
1. 前端工程师 - React
2. 后端工程师 - Node.js
3. 产品经理

请问您对哪个岗位感兴趣？`;

      const segments = MessageSplitter.split(agentReply);

      expect(segments.length).toBe(3);
      expect(segments[0]).toBe('您好！很高兴为您服务。');
      expect(segments[1]).toBe(
        '我们目前有以下几个岗位：\n1. 前端工程师 - React\n2. 后端工程师 - Node.js\n3. 产品经理',
      );
      expect(segments[2]).toBe('请问您对哪个岗位感兴趣？');
    });

    it('单换行符不应该触发拆分', () => {
      const agentReply = `我们有以下岗位：
1. 前端工程师
2. 后端工程师`;

      const segments = MessageSplitter.split(agentReply);
      // 只有一个段落，不拆分
      expect(segments.length).toBe(1);
      expect(segments[0]).toBe('我们有以下岗位：\n1. 前端工程师\n2. 后端工程师');
    });
  });

  describe('split - 支持"～"符号拆分', () => {
    it('应该按"～"符号拆分消息', () => {
      const text = '我看了下～浦东这边肯德基确实在招';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下', '浦东这边肯德基确实在招']);
    });

    it('应该按多个"～"符号拆分', () => {
      const text = '我看了下～浦东这边肯德基确实在招～要不要看看离您近的门店？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下', '浦东这边肯德基确实在招', '要不要看看离您近的门店？']);
    });

    it('应该同时按双换行符和"～"符号拆分', () => {
      const text =
        '我看了下～浦东这边肯德基确实在招\n\n时薪26元，做六休一哈～\n\n要不要我帮您看下离您近的门店？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual([
        '我看了下',
        '浦东这边肯德基确实在招',
        '时薪26元，做六休一哈',
        '要不要我帮您看下离您近的门店？',
      ]);
    });

    it('单换行符配合"～"符号时不按换行符拆分', () => {
      const text = '我看了下～浦东这边肯德基确实在招\n时薪26元，做六休一哈～';
      const result = MessageSplitter.split(text);
      // 单换行符不拆分，只按"～"拆分
      expect(result).toEqual(['我看了下', '浦东这边肯德基确实在招\n时薪26元，做六休一哈']);
    });

    it('应该处理末尾有"～"的情况', () => {
      const text = '不好意思哈～';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['不好意思哈']);
    });

    it('应该处理没有"～"符号的普通消息', () => {
      const text = '这是一条普通消息';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['这是一条普通消息']);
    });

    it('应该过滤空片段', () => {
      const text = '我看了下～～浦东这边在招';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下', '浦东这边在招']);
    });

    it('实际场景：招聘经理回复消息', () => {
      const agentReply =
        '我看了下～大米先生浦东这边暂时没在招哈～不过附近必胜客和奥乐齐都还在招，要不要我帮您看看那边的？😊';
      const result = MessageSplitter.split(agentReply);
      // 按新规则：逗号不拆分，保持问句完整
      expect(result).toEqual([
        '我看了下',
        '大米先生浦东这边暂时没在招哈',
        '不过附近必胜客和奥乐齐都还在招，要不要我帮您看看那边的？😊',
      ]);
    });

    it('实际场景：简单问候语拆分', () => {
      const agentReply = '好的～请问您现在是学生吗？';
      const result = MessageSplitter.split(agentReply);
      // 应该保持原始顺序："好的"在前，"请问您现在是学生吗？"在后
      expect(result).toEqual(['好的', '请问您现在是学生吗？']);
    });

    it('应该去掉消息末尾的"*"符号', () => {
      const text = '您好*';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['您好']);
    });

    it('应该去掉消息末尾的多个"*"符号', () => {
      const text = '您好***';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['您好']);
    });

    it('应该同时去掉"～"和"*"符号', () => {
      const text = '我看了下～浦东这边在招*';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下', '浦东这边在招']);
    });

    it('应该去掉混合的"～"和"*"符号', () => {
      const text = '好的～*请问您现在是学生吗？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['好的', '请问您现在是学生吗？']);
    });

    it('应该删除消息中所有的"*"符号', () => {
      const text = '您好*请问';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['您好请问']); // 删除所有的 * 符号
    });

    it('应该按"～"拆分并删除所有的"*"符号', () => {
      const text = '我*看了下～浦东*这边在招～要不要*看看？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下', '浦东这边在招', '要不要看看？']); // 按～拆分,删除所有的*
    });

    it('应该保留薪资范围中的"～"符号', () => {
      const text = '薪资 22～24k';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['薪资 22～24k']); // 保留正文中的～符号
    });

    it('应该删除所有的"*"符号', () => {
      const text = '**重点提醒**';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['重点提醒']); // 删除所有的*符号
    });

    it('复杂场景：包含薪资范围的消息', () => {
      const text = '**重点**：这个岗位薪资 22～24k\n\n要求3年经验～～';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['重点：这个岗位薪资 22～24k', '要求3年经验']); // 删除所有*,保留正文～
    });
  });

  describe('needsSplit - 更新支持"～"符号和双换行符', () => {
    it('包含"～"符号时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('我看了下～浦东这边在招')).toBe(true);
    });

    it('同时包含双换行符和"～"符号时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('第一段\n\n我看了下～第二段')).toBe(true);
    });

    it('只包含单换行符时应该返回 false', () => {
      expect(MessageSplitter.needsSplit('第一行\n第二行')).toBe(false);
    });

    it('只包含普通文本时应该返回 false', () => {
      expect(MessageSplitter.needsSplit('这是普通文本')).toBe(false);
    });

    it('包含双换行符时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('第一段\n\n第二段')).toBe(true);
    });

    it('包含"？"问号后面跟着中文时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('要不要看看？或者你喜欢哪个？')).toBe(true);
    });

    it('"。"后面跟换行再跟中文时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('好的。\n我帮您查一下')).toBe(true);
    });

    it('"？"后面跟换行再跟中文时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('是学生吗？\n顺便问下年龄')).toBe(true);
    });

    it('问号在末尾时应该返回 false（不需要拆分）', () => {
      expect(MessageSplitter.needsSplit('要不要看看？')).toBe(false);
    });
  });

  describe('split - 支持"？"问号拆分', () => {
    it('应该按"？"问号拆分（问号后面跟着中文）', () => {
      const text = '要不要一起看看？或者你对哪个品牌比较感兴趣呀？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['要不要一起看看？', '或者你对哪个品牌比较感兴趣呀？']);
    });

    it('用户示例：徐汇招聘消息拆分（2段）', () => {
      const text =
        '我看了下，徐汇这边暂时没在招哈，不过附近还有门店在招，要不要一起看看？或者你对哪个品牌比较感兴趣呀？';
      const result = MessageSplitter.split(text);
      // 按新规则：逗号不拆分，只在问号处拆分
      // "？"后面跟着"或者"是中文，所以在第一个问号后拆分
      expect(result).toEqual([
        '我看了下，徐汇这边暂时没在招哈，不过附近还有门店在招，要不要一起看看？',
        '或者你对哪个品牌比较感兴趣呀？',
      ]);
    });

    it('应该同时按"～"和"？"拆分', () => {
      const text = '我看了下～徐汇这边暂时没在招哈，要不要看看？或者你喜欢哪个品牌？';
      const result = MessageSplitter.split(text);
      // 按新规则：逗号不拆分，保持句子完整
      expect(result).toEqual([
        '我看了下',
        '徐汇这边暂时没在招哈，要不要看看？',
        '或者你喜欢哪个品牌？',
      ]);
    });

    it('问号后面不是中文时不拆分', () => {
      const text = '请问你是？（请选择身份）';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['请问你是？（请选择身份）']); // 问号后面是括号，不拆分
    });

    it('问号后面是空格再跟中文时应该拆分', () => {
      const text = '你好？ 我是小助手';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['你好？', '我是小助手']);
    });

    it('问号在末尾时不拆分', () => {
      const text = '请问您现在是学生吗？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['请问您现在是学生吗？']);
    });

    it('复杂场景：双换行符、～ 和 ？ 混合使用', () => {
      const text = '我看了下～浦东这边在招\n\n要不要看看？或者你喜欢其他品牌？我帮你查一下';
      const result = MessageSplitter.split(text);
      expect(result).toEqual([
        '我看了下',
        '浦东这边在招',
        '要不要看看？',
        '或者你喜欢其他品牌？',
        '我帮你查一下',
      ]);
    });

    it('多个连续问号应该各自拆分', () => {
      const text = '你是学生吗？想找什么工作？有什么要求？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['你是学生吗？', '想找什么工作？', '有什么要求？']);
    });

    it('逗号后跟问句不拆分（保持句子完整）', () => {
      const text = '这边暂时没在招，要不要看看其他的？';
      const result = MessageSplitter.split(text);
      // 按新规则：逗号不拆分，问句保持完整
      expect(result).toEqual(['这边暂时没在招，要不要看看其他的？']);
    });

    it('只有陈述句不拆分（即使有逗号）', () => {
      const text = '我看了下，徐汇这边暂时没在招哈，不过附近还有门店在招。';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下，徐汇这边暂时没在招哈，不过附近还有门店在招。']);
    });

    it('逗号后面的问句在末尾时才拆分', () => {
      const text = '我帮你查了，附近有在招的门店';
      const result = MessageSplitter.split(text);
      // 逗号后面不是问句，不拆分
      expect(result).toEqual(['我帮你查了，附近有在招的门店']);
    });

    it('句号后跟问句应该拆分', () => {
      const text = '好的。请问您现在是学生吗？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['好的。', '请问您现在是学生吗？']);
    });

    it('句号后跟多个问句应该全部拆分', () => {
      const text = '我帮您查了一下。您是想找全职还是兼职？有什么特别的要求吗？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual([
        '我帮您查了一下。',
        '您是想找全职还是兼职？',
        '有什么特别的要求吗？',
      ]);
    });

    it('句号后面跟中文应该拆分', () => {
      const text = '好的。我帮您查一下。';
      const result = MessageSplitter.split(text);
      // 按新规则：句号是句子结束符，后面跟中文时拆分
      expect(result).toEqual(['好的。', '我帮您查一下。']);
    });

    it('复杂场景：句号、逗号和问号混合', () => {
      const text = '明白了。这边暂时没在招，要不要看看其他的？或者您对哪个品牌比较感兴趣？';
      const result = MessageSplitter.split(text);
      // 按新规则：逗号不拆分，只在句子结束符（。和？）后面跟中文时拆分
      expect(result).toEqual([
        '明白了。',
        '这边暂时没在招，要不要看看其他的？',
        '或者您对哪个品牌比较感兴趣？',
      ]);
    });

    it('句号后面跟单换行再跟中文应该拆分', () => {
      const text = '好的。\n我帮您查一下';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['好的。', '我帮您查一下']);
    });

    it('问号后面跟单换行再跟中文应该拆分', () => {
      const text = '是学生吗？\n顺便说一下年龄';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['是学生吗？', '顺便说一下年龄']);
    });

    it('实际场景：三段通知消息（单换行分隔）', () => {
      const text =
        '明天下午 2 点到 5 点是可以的，不过需要在今天下午 6 点前把资料交上去，我帮你录入系统。\n麻烦发一下这几项：姓名、电话、年龄、有没有健康证、是学生还是社会人？\n顺便提一下之前做咖啡的店名和大概做了多久。';
      const result = MessageSplitter.split(text);
      expect(result).toEqual([
        '明天下午 2 点到 5 点是可以的，不过需要在今天下午 6 点前把资料交上去，我帮你录入系统。',
        '麻烦发一下这几项：姓名、电话、年龄、有没有健康证、是学生还是社会人？',
        '顺便提一下之前做咖啡的店名和大概做了多久。',
      ]);
    });

    it('～、句号和问号混合使用', () => {
      const text = '我看了下～浦东这边在招。请问您现在方便吗？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['我看了下', '浦东这边在招。', '请问您现在方便吗？']);
    });
  });

  describe('split - 支持 emoji 拆分', () => {
    it('emoji 后面跟着中文应该拆分', () => {
      const text = '黄浦这边兼职岗位也比较少哈😅我再帮你看看其他区域的';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['黄浦这边兼职岗位也比较少哈😅', '我再帮你看看其他区域的']);
    });

    it('用户示例：完整的招聘消息拆分（4段）', () => {
      // 按新规则：逗号不拆分，只在句子结束符（。、？）和emoji后拆分
      const text =
        '黄浦这边兼职岗位也比较少哈😅我再帮你看看其他区域的，上海这边还有静安、长宁、浦东的门店在招。或者你对其他品牌感兴趣吗，比如奥乐齐、西贝这些？时薪都差不多在20-25左右💰';
      const result = MessageSplitter.split(text);
      expect(result).toEqual([
        '黄浦这边兼职岗位也比较少哈😅',
        '我再帮你看看其他区域的，上海这边还有静安、长宁、浦东的门店在招。',
        '或者你对其他品牌感兴趣吗，比如奥乐齐、西贝这些？',
        '时薪都差不多在20-25左右💰',
      ]);
    });

    it('emoji 在末尾时不拆分', () => {
      const text = '好的，我帮你查一下😊';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['好的，我帮你查一下😊']);
    });

    it('emoji 后面是标点时不拆分', () => {
      const text = '收到😊，我马上帮你查';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['收到😊，我马上帮你查']);
    });

    it('多个 emoji 混合使用', () => {
      const text = '好消息😄附近有在招的门店💼要不要看看？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual(['好消息😄', '附近有在招的门店💼', '要不要看看？']);
    });

    it('emoji、～和问号混合使用', () => {
      const text = '我看了下～黄浦这边比较少😅要不要看看其他的？或者你喜欢哪个品牌？';
      const result = MessageSplitter.split(text);
      expect(result).toEqual([
        '我看了下',
        '黄浦这边比较少😅',
        '要不要看看其他的？',
        '或者你喜欢哪个品牌？',
      ]);
    });
  });

  describe('needsSplit - emoji 检测', () => {
    it('emoji 后面跟着中文时应该返回 true', () => {
      expect(MessageSplitter.needsSplit('好消息😄附近有门店')).toBe(true);
    });

    it('emoji 在末尾时应该返回 false', () => {
      expect(MessageSplitter.needsSplit('好的😊')).toBe(false);
    });

    it('emoji 后面是标点时应该返回 false', () => {
      expect(MessageSplitter.needsSplit('收到😊，我查一下')).toBe(false);
    });
  });
});
