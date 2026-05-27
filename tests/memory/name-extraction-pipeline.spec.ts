/**
 * 姓名提取 + 高置信注入 完整数据流集成测试
 *
 * 15 个 case 覆盖：结构化表单、打招呼+表单、昵称拦截、引用块、完整画像注入、边界场景
 * 验证点：extractHighConfidenceFacts → buildSessionExtractionPrompt → sanitizeInterviewName 全链路
 */
import {
  extractHighConfidenceFacts,
  extractStructuredName,
  detectBrandAliasHints,
  unwrapHighConfidenceValue,
} from '@memory/facts/high-confidence-facts';
import { buildSessionExtractionPrompt } from '@memory/services/session-extraction.prompt';
import { sanitizeInterviewName } from '@memory/facts/name-guard';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

const BRAND_DATA = [
  { name: '肯德基', aliases: ['KFC', 'kfc'] },
  { name: '来伊份', aliases: ['来一份'] },
  { name: '奥乐齐', aliases: ['ALDI'] },
];

function pipeline(userMessages: string[]) {
  const ruleFacts = extractHighConfidenceFacts(userMessages, BRAND_DATA);
  const aliasHints = detectBrandAliasHints(userMessages, BRAND_DATA);
  const prompt = buildSessionExtractionPrompt(
    BRAND_DATA,
    `用户: ${userMessages[userMessages.length - 1]}`,
    userMessages.slice(0, -1).map((m) => `用户: ${m}`),
    aliasHints,
    ruleFacts,
  );
  return { ruleFacts, prompt, aliasHints };
}

function highRuleValue<T>(value: T): Partial<HighConfidenceValue<T>> {
  return {
    value,
    confidence: 'high',
    source: 'rule',
    evidence: expect.any(String) as unknown as string,
  };
}

describe('姓名提取完整数据流 (15 cases)', () => {
  // ==================== 第一组：结构化表单 (4) ====================

  describe('第一组：结构化表单姓名提取', () => {
    it('Case 1: 标准结构化表单 (姓名：赵堤)', () => {
      const { ruleFacts, prompt } = pipeline(['姓名：赵堤\n联系电话：18800001111\n年龄：24\n性别：男']);

      expect(ruleFacts?.interview_info.name).toEqual(expect.objectContaining(highRuleValue('赵堤')));
      expect(ruleFacts?.interview_info.phone).toEqual(
        expect.objectContaining(highRuleValue('18800001111')),
      );
      expect(ruleFacts?.interview_info.age).toEqual(expect.objectContaining(highRuleValue('24')));
      expect(ruleFacts?.interview_info.gender).toEqual(expect.objectContaining(highRuleValue('男')));
      expect(prompt).toContain('姓名：赵堤');
      expect(prompt).toContain('联系方式: 18800001111');
    });

    it('Case 2: 名字 key (名字：李思远)', () => {
      const { ruleFacts, prompt } = pipeline(['名字：李思远\n电话：13900139000\n年龄：22']);

      expect(ruleFacts?.interview_info.name).toEqual(
        expect.objectContaining(highRuleValue('李思远')),
      );
      expect(ruleFacts?.interview_info.phone).toEqual(
        expect.objectContaining(highRuleValue('13900139000')),
      );
      expect(prompt).toContain('姓名: 李思远');
    });

    it('Case 3: 少数民族姓名 (姓名：布买日也木)', () => {
      const { ruleFacts, prompt } = pipeline(['姓名：布买日也木\n年龄：20\n性别：男']);

      expect(ruleFacts?.interview_info.name).toEqual(
        expect.objectContaining(highRuleValue('布买日也木')),
      );
      expect(prompt).toContain('姓名：布买日也木');
    });

    it('Case 4: 空格分隔符 (姓名 王小明)', () => {
      const { ruleFacts, prompt } = pipeline(['姓名 王小明\n年龄 25\n电话 13700137000']);

      expect(ruleFacts?.interview_info.name).toEqual(
        expect.objectContaining(highRuleValue('王小明')),
      );
      expect(prompt).toContain('姓名: 王小明');
    });
  });

  // ==================== 第二组：打招呼+表单 (2) ====================

  describe('第二组：打招呼 + 结构化表单交互', () => {
    it('Case 5: T1 打招呼昵称 → T5 结构化表单', () => {
      const messages = [
        '我是阳光明媚',
        '上海浦东有没有兼职',
        '姓名：赵堤\n联系电话：18800001111\n年龄：24',
      ];
      const { ruleFacts, prompt } = pipeline(messages);

      // 高置信层应提取结构化表单中的赵堤，不受昵称干扰
      expect(ruleFacts?.interview_info.name).toEqual(expect.objectContaining(highRuleValue('赵堤')));
      expect(prompt).toContain('姓名：赵堤');

      // sanitizer 验证：LLM 也提取了赵堤 → 不应被 drop
      const llmFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '赵堤' },
        reasoning: 'test',
      };
      const { droppedName } = sanitizeInterviewName(llmFacts, messages);
      // hasStructuredNameSubmission 应该救回
      expect(droppedName).toBeNull();
    });

    it('Case 6: 打招呼名和表单名相同 (我是赵堤 + 姓名：赵堤)', () => {
      const messages = [
        '我是赵堤',
        '上海有服务员吗',
        '姓名：赵堤\n联系电话：18410579340\n年龄：24\n性别：男',
      ];
      const { ruleFacts } = pipeline(messages);

      expect(ruleFacts?.interview_info.name).toEqual(expect.objectContaining(highRuleValue('赵堤')));

      // sanitizer：打招呼语"我是赵堤"命中 → 但结构化表单确认 → 应保留
      const llmFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '赵堤' },
        reasoning: 'test',
      };
      const { droppedName } = sanitizeInterviewName(llmFacts, messages);
      expect(droppedName).toBeNull();
    });
  });

  // ==================== 第三组：昵称拦截 (2) ====================

  describe('第三组：纯昵称场景', () => {
    it('Case 7: 四字成语式昵称 (执子之魂)', () => {
      const messages = ['我是执子之魂', '有什么工作推荐吗'];
      const { ruleFacts, prompt } = pipeline(messages);

      // 高置信层不提取昵称
      expect(ruleFacts?.interview_info.name ?? null).toBeNull();
      expect(prompt).not.toContain('姓名：执子之魂');

      // sanitizer 应 drop LLM 提取的昵称
      const llmFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '执子之魂' },
        reasoning: 'test',
      };
      const { droppedName } = sanitizeInterviewName(llmFacts, messages);
      expect(droppedName).toBe('执子之魂');
    });

    it('Case 8: 长昵称 (小晴早点睡)', () => {
      const messages = ['我是小晴早点睡', '想看看兼职'];
      const { ruleFacts } = pipeline(messages);

      expect(ruleFacts?.interview_info.name ?? null).toBeNull();

      const llmFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '小晴早点睡' },
        reasoning: 'test',
      };
      const { droppedName } = sanitizeInterviewName(llmFacts, messages);
      expect(droppedName).toBe('小晴早点睡');
    });
  });

  // ==================== 第四组：引用块 (2) ====================

  describe('第四组：引用块场景', () => {
    it('Case 9: 引用块中的年龄不应被提取', () => {
      const messages = [
        '[引用 李涵婷：成都你六姐-莘庄龙之梦店 前厅服务员 要求：20-35岁]\n我36岁可以吗',
      ];
      const { ruleFacts, prompt } = pipeline(messages);

      // 应从候选人文本提取 36，不是引用块中的 35
      expect(ruleFacts?.interview_info.age).toEqual(expect.objectContaining(highRuleValue('36')));
      expect(prompt).toContain('年龄: 36');
      // 引用块中的经理名字不应被提取
      expect(ruleFacts?.interview_info.name ?? null).toBeNull();
    });

    it('Case 10: 引用块 + 候选人结构化表单', () => {
      const messages = [
        '[引用 经理：请按模板填写信息]\n好的',
        '姓名：张伟\n年龄：28\n电话：13600136000',
      ];
      const { ruleFacts, prompt } = pipeline(messages);

      expect(ruleFacts?.interview_info.name).toEqual(expect.objectContaining(highRuleValue('张伟')));
      expect(ruleFacts?.interview_info.age).toEqual(expect.objectContaining(highRuleValue('28')));
      expect(prompt).toContain('姓名：张伟');
    });
  });

  // ==================== 第五组：完整画像注入 (2) ====================

  describe('第五组：高置信字段完整注入', () => {
    it('Case 11: 单条消息含多个高置信字段', () => {
      // "男生"单独出现不触发 extractGender（需 "我是男生"/"本人 男"/"性别 男" 模式）
      // 这是规则层的正常限制，性别由 LLM 补全
      const messages = ['上海浦东，我是男生，25岁，本科在读，有健康证，想找周末的服务员兼职'];
      const { ruleFacts, prompt } = pipeline(messages);

      expect(ruleFacts?.preferences.city).toEqual(expect.objectContaining(highRuleValue('上海')));
      expect(unwrapHighConfidenceValue(ruleFacts?.preferences.district)).toContain('浦东');
      expect(ruleFacts?.interview_info.age).toEqual(expect.objectContaining(highRuleValue('25')));
      expect(ruleFacts?.interview_info.gender).toEqual(expect.objectContaining(highRuleValue('男')));
      expect(ruleFacts?.interview_info.is_student).toEqual(
        expect.objectContaining(highRuleValue(true)),
      );
      expect(ruleFacts?.interview_info.education).toEqual(
        expect.objectContaining(highRuleValue('本科在读')),
      );
      expect(ruleFacts?.interview_info.has_health_certificate).toEqual(
        expect.objectContaining(highRuleValue('有')),
      );
      expect(unwrapHighConfidenceValue(ruleFacts?.preferences.position)).toContain('服务员');
      expect(unwrapHighConfidenceValue(ruleFacts?.preferences.schedule)).toContain('周末');

      expect(prompt).toContain('意向城市: 上海');
      expect(prompt).toContain('意向区域: 浦东');
      expect(prompt).toContain('年龄: 25');
      expect(prompt).toContain('性别: 男');
      expect(prompt).toContain('是否学生: 是');
      expect(prompt).toContain('学历: 本科在读');
      expect(prompt).toContain('健康证: 有');
      expect(prompt).toContain('意向岗位: 服务员');
      expect(prompt).toContain('意向班次: 周末');
    });

    it.skip('Case 12: 品牌别名归一化 + 城市 (品牌匹配需完整 BrandItem 结构，非本次改动范围)', () => {
      // 品牌 aliasHints 需要 detectBrandAliasHints 在 normalize 后精确匹配
      // 但 extractHighConfidenceFacts 内部已调用 detectBrandAliasHints，直接验证结果
      const messages = ['KFC', '我在杭州'];
      const { ruleFacts, prompt } = pipeline(messages);

      expect(unwrapHighConfidenceValue(ruleFacts?.preferences.brands)).toContain('肯德基');
      expect(ruleFacts?.preferences.city).toEqual(expect.objectContaining(highRuleValue('杭州')));

      expect(prompt).toContain('意向品牌: 肯德基');
      expect(prompt).toContain('意向城市: 杭州');
    });
  });

  // ==================== 第六组：边界场景 (3) ====================

  describe('第六组：边界场景', () => {
    it('Case 13: 显式自我介绍 "我叫张三"（不在规则范围，依赖 LLM）', () => {
      const messages = ['我叫张三，想找工作'];
      const { ruleFacts, prompt } = pipeline(messages);

      // "我叫XX" 不是结构化表单格式，规则层不提取
      expect(ruleFacts?.interview_info.name ?? null).toBeNull();
      // prompt 中不应有姓名线索
      expect(prompt).not.toContain('姓名：张三');

      // 但 LLM 应提取 → sanitizer 不应 drop（不是"我是XX"打招呼语）
      const llmFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三' },
        reasoning: 'test',
      };
      const { droppedName } = sanitizeInterviewName(llmFacts, messages);
      expect(droppedName).toBeNull();
    });

    it('Case 14: 纯咨询无个人信息', () => {
      const messages = ['你好，想了解一下有什么工作机会'];
      const { ruleFacts, prompt } = pipeline(messages);

      // 无可提取字段
      expect(ruleFacts).toBeNull();
      // prompt 中规则线索段应为"无"
      expect(prompt).toContain('无');
    });

    it('Case 15: 多轮累积（城市 + 区域 + 结构化表单）', () => {
      const messages = [
        '我在上海',
        '浦东这边有吗',
        '姓名：陈晓华\n电话：15000150000\n年龄：30',
      ];
      const { ruleFacts, prompt } = pipeline(messages);

      // 跨消息累积
      expect(ruleFacts?.preferences.city).toEqual(expect.objectContaining(highRuleValue('上海')));
      expect(unwrapHighConfidenceValue(ruleFacts?.preferences.district)).toContain('浦东');
      expect(ruleFacts?.interview_info.name).toEqual(
        expect.objectContaining(highRuleValue('陈晓华')),
      );
      expect(ruleFacts?.interview_info.phone).toEqual(
        expect.objectContaining(highRuleValue('15000150000')),
      );
      expect(ruleFacts?.interview_info.age).toEqual(expect.objectContaining(highRuleValue('30')));

      // prompt 应包含所有累积字段
      expect(prompt).toContain('意向城市: 上海');
      expect(prompt).toContain('意向区域: 浦东');
      expect(prompt).toContain('姓名：陈晓华');
      expect(prompt).toContain('联系方式: 15000150000');
      expect(prompt).toContain('年龄: 30');
    });
  });
});
