import {
  extractAutoGreetingName,
  isFromAutoGreeting,
  isLikelyRealChineseName,
  sanitizeInterviewName,
} from '@/memory/facts/name-guard';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
} from '@/memory/types/session-facts.types';

describe('name-guard', () => {
  describe('extractAutoGreetingName', () => {
    it.each([
      ['我是执子之魂', '执子之魂'],
      ['我是张三', '张三'],
      ['你好，我是李四', '李四'],
      ['你好我是王五', '王五'],
      ['您好，我是赵六。', '赵六'],
      ['Hello，我是Alice', 'Alice'],
      ['  我是 孙七  ', null], // 中间含空格，不视为纯打招呼句式
      // 带短期记忆注入的时间后缀，badcase batch_69e9bba2536c9654026522da_*
      ['我是阳光明媚\n[消息发送时间：2026-04-23 14:26 周四]', '阳光明媚'],
      ['你好，我是李四\n[消息发送时间：2026-04-23 10:00 周四]', '李四'],
      ['我是张三\n[消息发送时间：2026-04-23 09:00 周四]\n', '张三'],
    ])('parses "我是xx" greeting from %s', (input, expected) => {
      expect(extractAutoGreetingName(input)).toBe(expected);
    });

    it.each([
      '我叫张三', // 显式自我介绍
      '我是张三，想了解下岗位', // 带后续内容
      '张三', // 单名字
      '', // 空
      '健康证有的', // 不相关
    ])('does not match non-greeting message %s', (input) => {
      expect(extractAutoGreetingName(input)).toBeNull();
    });
  });

  describe('isFromAutoGreeting', () => {
    it('matches when name appears as xx in any "我是xx" message', () => {
      expect(isFromAutoGreeting('执子之魂', ['我是执子之魂', '健康证有的'])).toBe(true);
    });

    it('does not match when name never appears as greeting xx', () => {
      expect(isFromAutoGreeting('张三', ['我叫张三', '我是小明'])).toBe(false);
    });

    it('does not match when name string differs from greeting xx', () => {
      expect(isFromAutoGreeting('张三', ['我是李四'])).toBe(false);
    });
  });

  describe('sanitizeInterviewName', () => {
    const buildFacts = (name: string | null): EntityExtractionResult => ({
      ...FALLBACK_EXTRACTION,
      interview_info: { ...FALLBACK_EXTRACTION.interview_info, name },
    });

    it('keeps name when no auto-greeting in messages', () => {
      const facts = buildFacts('张三');
      const result = sanitizeInterviewName(facts, ['我叫张三', '来面试的']);
      expect(result.droppedName).toBeNull();
      expect(result.sanitized.interview_info.name).toBe('张三');
      expect(result.sanitized).toBe(facts);
    });

    it('drops name sourced from 我是xx auto-greeting', () => {
      const facts = buildFacts('执子之魂');
      const result = sanitizeInterviewName(facts, ['我是执子之魂', '健康证有的']);
      expect(result.droppedName).toBe('执子之魂');
      expect(result.sanitized.interview_info.name).toBeNull();
      expect(result.sanitized).not.toBe(facts);
    });

    it('no-op when name is null', () => {
      const facts = buildFacts(null);
      const result = sanitizeInterviewName(facts, ['我是小明']);
      expect(result.droppedName).toBeNull();
      expect(result.sanitized.interview_info.name).toBeNull();
    });

    it('keeps name even if it looks like nickname but was not sourced from greeting', () => {
      const facts = buildFacts('执子之魂');
      const result = sanitizeInterviewName(facts, ['健康证有的', '要面试吗']);
      expect(result.droppedName).toBeNull();
      expect(result.sanitized.interview_info.name).toBe('执子之魂');
    });

    it('preserves other interview_info fields when sanitizing', () => {
      const facts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          name: '执子之魂',
          phone: '13800138000',
          age: '28',
        },
      };
      const result = sanitizeInterviewName(facts, ['我是执子之魂']);
      expect(result.sanitized.interview_info.name).toBeNull();
      expect(result.sanitized.interview_info.phone).toBe('13800138000');
      expect(result.sanitized.interview_info.age).toBe('28');
    });
  });

  describe('isLikelyRealChineseName', () => {
    it.each(['张三', '李四', '胡晓雷', '欧阳娜娜'])(
      'accepts real Chinese name %s',
      (value) => {
        expect(isLikelyRealChineseName(value)).toBe(true);
      },
    );

    it.each([
      '小晴早点睡', // 5 字昵称
      '余᭄苼囿財', // 含装饰字符
      '💰余', // emoji
      'Rafeal·Gal', // 拉丁
      '张三A', // 含字母
      '张3', // 含数字
      '胡', // 1 字
      '', // 空
      '   ', // 空白
      'X 张三', // 含空格
    ])('rejects nickname-like input %p', (value) => {
      expect(isLikelyRealChineseName(value)).toBe(false);
    });

    it('rejects null / undefined', () => {
      expect(isLikelyRealChineseName(null)).toBe(false);
      expect(isLikelyRealChineseName(undefined)).toBe(false);
    });

    it('still accepts 4-char idiom-style names (known false-positive, prompt fallback)', () => {
      // 漏网契约：4 字成语式昵称无法靠正则区分，依赖 prompt 让 Agent 重问
      expect(isLikelyRealChineseName('执子之魂')).toBe(true);
    });

    it.each([
      '测试姓名', // P2 批次 SCN-P2-20260429-004 实测 fixture
      '测试用户',
      '测试候选人',
      '用户张三',
      '昵称小明',
      '游客小李',
      '匿名用户',
      '无名氏',
      '客户A真', // 含字母也会先被正则拒，这里测前缀分支不影响
    ])('rejects placeholder prefix %p', (value) => {
      expect(isLikelyRealChineseName(value)).toBe(false);
    });

    it('keeps real names even if they contain blacklist words in the middle', () => {
      // "张测试"开头不是黑名单词，仍然通过
      expect(isLikelyRealChineseName('张测试')).toBe(true);
    });
  });
});
