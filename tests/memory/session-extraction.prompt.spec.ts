import {
  SESSION_EXTRACTION_SYSTEM_PROMPT,
  buildSessionExtractionPrompt,
} from '@memory/services/session-extraction.prompt';
import { FALLBACK_EXTRACTION, type EntityExtractionResult } from '@memory/types/session-facts.types';

describe('SESSION_EXTRACTION_SYSTEM_PROMPT', () => {
  it('should prevent fallback recommendations from overwriting the current applied job', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
      '不得把这些备选内容覆盖为 applied_store / applied_position',
    );
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
      '只记录用户当前正在报名、约面或明确追问详情的那个',
    );
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('保持 null，不要从较晚出现的备选推荐里猜');
  });

  it('should instruct LLM to use rule facts as reference', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('规则线索供参考');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('以用户最新表述为准');
  });
});

describe('buildSessionExtractionPrompt', () => {
  const brandData = [{ name: '肯德基', aliases: ['KFC'] }];

  it('should include rule facts section when ruleFacts is provided', () => {
    const ruleFacts: EntityExtractionResult = {
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        name: '赵堤',
        phone: '18800001111',
        age: '24',
        gender: '男',
      },
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
        district: ['浦东'],
      },
      reasoning: 'test',
    };

    const prompt = buildSessionExtractionPrompt(
      brandData,
      '用户: 还有别的岗位吗',
      ['用户: 姓名：赵堤'],
      [],
      ruleFacts,
    );

    expect(prompt).toContain('规则模式匹配线索');
    expect(prompt).toContain('姓名：赵堤');
    expect(prompt).toContain('联系方式：18800001111');
    expect(prompt).toContain('年龄：24');
    expect(prompt).toContain('性别：男');
    expect(prompt).toContain('城市：上海');
    expect(prompt).toContain('区域：浦东');
  });

  it('should show "无" when ruleFacts is null', () => {
    const prompt = buildSessionExtractionPrompt(
      brandData,
      '用户: 你好',
      [],
      [],
      null,
    );

    expect(prompt).toContain('[规则模式匹配线索');
    expect(prompt).toContain('\n无\n');
  });

  it('should show "无" when ruleFacts has no extracted values', () => {
    const prompt = buildSessionExtractionPrompt(
      brandData,
      '用户: 你好',
      [],
      [],
      FALLBACK_EXTRACTION,
    );

    expect(prompt).toContain('[规则模式匹配线索');
    // FALLBACK_EXTRACTION 所有字段都是 null，应显示"无"
    const section = prompt.split('[规则模式匹配线索')[1].split('[历史对话]')[0];
    expect(section).toContain('无');
  });

  it('should only include fields with values, not null fields', () => {
    const ruleFacts: EntityExtractionResult = {
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        phone: '13900139000',
      },
      reasoning: 'test',
    };

    const prompt = buildSessionExtractionPrompt(brandData, 'msg', [], [], ruleFacts);

    expect(prompt).toContain('联系方式：13900139000');
    expect(prompt).not.toContain('姓名');
    expect(prompt).not.toContain('年龄');
    expect(prompt).not.toContain('性别');
  });

  it('should include is_student=false as explicit signal', () => {
    const ruleFacts: EntityExtractionResult = {
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        is_student: false,
      },
      reasoning: 'test',
    };

    const prompt = buildSessionExtractionPrompt(brandData, 'msg', [], [], ruleFacts);
    expect(prompt).toContain('是否学生：否');
  });

  it('should be backwards-compatible when ruleFacts is omitted', () => {
    const prompt = buildSessionExtractionPrompt(
      brandData,
      '用户: 你好',
      ['用户: 之前的消息'],
    );

    expect(prompt).toContain('[规则模式匹配线索');
    expect(prompt).toContain('无');
    expect(prompt).toContain('[历史对话]');
    expect(prompt).toContain('之前的消息');
  });
});
