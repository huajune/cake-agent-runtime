/**
 * 昵称 vs 真名识别 — 20 case 全覆盖
 *
 * 验证 isLikelyRealChineseName + sanitizeInterviewName + extractStructuredName 联动
 */
import { isLikelyRealChineseName, sanitizeInterviewName } from '@/memory/facts/name-guard';
import { extractStructuredName } from '@memory/facts/high-confidence-facts';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
} from '@memory/types/session-facts.types';

function buildFacts(name: string | null): EntityExtractionResult {
  return {
    ...FALLBACK_EXTRACTION,
    interview_info: { ...FALLBACK_EXTRACTION.interview_info, name },
    reasoning: 'test',
  };
}

describe('昵称 vs 真名识别 (20 cases)', () => {
  // ==================== 第一组：真名应通过 (5) ====================

  describe('真名应通过', () => {
    it.each([
      { name: '张三', reason: '2字汉族常见名' },
      { name: '欧阳娜娜', reason: '4字复姓' },
      { name: '布买日也木', reason: '5字少数民族名（边界值）' },
      { name: '李四', reason: '2字最短合法名' },
      { name: '司马光宇', reason: '4字复姓+双字名' },
    ])('Case $#: $name — $reason', ({ name }) => {
      expect(isLikelyRealChineseName(name)).toBe(true);
    });
  });

  // ==================== 第二组：昵称应拒绝 (10) ====================

  describe('昵称应拒绝', () => {
    it.each([
      { name: '小晴早点睡觉', reason: '6字纯CJK昵称 → 超上限' },
      { name: '加油宝贝吖呀', reason: '6字纯CJK昵称 → 超上限' },
      { name: '执子之魂永远爱你', reason: '8字纯CJK → 超上限' },
      { name: '💰余苼囿財', reason: '含emoji' },
      { name: 'Alice张', reason: '含拉丁字母' },
      { name: '张3三', reason: '含数字' },
      { name: '赵', reason: '1字太短' },
      { name: '测试用户', reason: '占位前缀"测试"' },
      { name: '游客小李', reason: '占位前缀"游客"' },
      { name: '余᭄苼囿財࿐', reason: '含装饰Unicode符号' },
    ])('Case $#: "$name" — $reason', ({ name }) => {
      expect(isLikelyRealChineseName(name)).toBe(false);
    });
  });

  // ==================== 第三组：5字边界 (3) ====================

  describe('5字边界', () => {
    it.each([
      { name: '阿不力克木', pass: true, reason: '5字少数民族名 → 通过' },
      { name: '小晴早点睡', pass: true, reason: '5字纯CJK → 通过（已知漏网，prompt兜底）' },
      { name: '小晴早点睡觉', pass: false, reason: '6字 → 超上限拒绝' },
    ])('Case $#: "$name" — $reason', ({ name, pass }) => {
      expect(isLikelyRealChineseName(name)).toBe(pass);
    });
  });

  // ==================== 第四组：sanitizer 联动 (2) ====================

  describe('sanitizer 联动：打招呼语 vs 结构化表单', () => {
    it('Case 16: "我是执子之魂" → LLM提取执子之魂 → sanitizer应drop', () => {
      const messages = ['我是执子之魂', '有什么工作'];
      const facts = buildFacts('执子之魂');
      const { droppedName } = sanitizeInterviewName(facts, messages);
      expect(droppedName).toBe('执子之魂');
    });

    it('Case 17: "我是赵堤" + "姓名：赵堤" → sanitizer应保留（表单确认）', () => {
      const messages = ['我是赵堤', '姓名：赵堤\n年龄：24'];
      const facts = buildFacts('赵堤');
      const { droppedName, sanitized } = sanitizeInterviewName(facts, messages);
      expect(droppedName).toBeNull();
      expect(sanitized.interview_info.name).toBe('赵堤');
    });

    it('Case 18: "我叫张三" → 非打招呼语 → sanitizer不干预', () => {
      const messages = ['我叫张三，想找工作'];
      const facts = buildFacts('张三');
      const { droppedName } = sanitizeInterviewName(facts, messages);
      expect(droppedName).toBeNull();
    });

    it('Case 19: 结构化表单提取 "姓名：陈晓华" → 规则层直接提取', () => {
      const name = extractStructuredName('姓名：陈晓华\n年龄：30');
      expect(name).toBe('陈晓华');
    });

    it('Case 20: 结构化表单 "姓名：小晴早点睡觉" → 6字拒绝，规则层不提取', () => {
      const name = extractStructuredName('姓名：小晴早点睡觉\n年龄：20');
      expect(name).toBeNull();
    });
  });
});
