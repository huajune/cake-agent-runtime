import {
  SESSION_EXTRACTION_SYSTEM_PROMPT,
  buildSessionExtractionPrompt,
} from '@memory/services/session-extraction.prompt';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

function highConfidence<T>(
  value: T,
  evidence: string,
  confidence: HighConfidenceValue<T>['confidence'] = 'high',
  source: HighConfidenceValue<T>['source'] = 'rule',
): HighConfidenceValue<T> {
  return { value, confidence, source, evidence };
}

function emptyHighConfidenceFacts(): HighConfidenceFacts {
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    },
    preferences: {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: '',
  };
}

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

  it('should keep confirmed student identity sticky across social-job discussion', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('身份粘性');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('社会人士岗位会影响读书吗');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('不得**提取为 is_student=false');
  });

  it('should instruct LLM to extract Boss title bracket brand ids', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('brand_ids');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('[10239]');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('duliday_job_list.brandIdList');
  });

  describe('labor_form 提取口径（2026-07 反转：找兼职/要全职 必须提取）', () => {
    it('should list the 5 legal labor_form values', () => {
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '仅允许以下合法值之一："全职"、"兼职"、"小时工"、"寒假工"、"暑假工"',
      );
    });

    it('should REQUIRE extracting 找兼职 → "兼职" and 要全职 → "全职"', () => {
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '候选人说"找兼职"/"有没有兼职" → labor_form: "兼职"',
      );
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '候选人说"要全职"/"找全职" → labor_form: "全职"',
      );
      // few-shot 示例也要同口径
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '用户说"我想找兼职" / "有兼职吗" → labor_form: "兼职"',
      );
    });

    it('should state platform has both full-time and part-time jobs as filter dimension', () => {
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('平台同时有全职、兼职及细分岗位');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '候选人明确表达任一合法用工形式时都应提取',
      );
    });

    it('should NOT contain the reversed old wording (平台全是兼职 / 不提取口径)', () => {
      // 旧口径：平台属性论（所有岗位都是兼职、全职不存在）
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('本平台所有岗位');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('都是兼职岗位');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('在本平台不存在');
      // 旧口径：找兼职/要全职 → 不提取
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('**不提取** labor_form');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('平台全是兼职');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('这个词没有筛选价值');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('"兼职"/"全职"无区分度');
      // 旧口径：合法值只有四个细分
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('四个细分值');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('"有空做兼职"是平台默认属性');
    });

    it('should still forbid inferring labor_form from availability alone', () => {
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('不要仅凭可用时间推理 labor_form');
    });

    it('should normalize summer aliases without treating negation, uncertainty, or alternatives as summer-only', () => {
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '"暑期工"/"暑期工作"/"暑期兼职"/"暑假兼职"统一归一为 labor_form: "暑假工"',
      );
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('"不知道是不是暑假工"');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('"暑假工或者小时工都可以"');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('不等于只要暑假工');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('"这个是小时工吗"');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('不得据此更新 labor_form');
    });
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
    expect(prompt).toContain('姓名: 赵堤');
    expect(prompt).toContain('联系方式: 18800001111');
    expect(prompt).toContain('年龄: 24');
    expect(prompt).toContain('性别: 男');
    expect(prompt).toContain('意向城市: 上海');
    expect(prompt).toContain('意向区域: 浦东');
  });

  it('should pass all highConfidenceFacts to LLM with confidence/source/evidence', () => {
    const ruleFacts: HighConfidenceFacts = {
      ...emptyHighConfidenceFacts(),
      interview_info: {
        ...emptyHighConfidenceFacts().interview_info,
        age: highConfidence('24', '年龄识别：24'),
        gender: highConfidence('女', '客户详情接口补充性别：女', 'low', 'system'),
        gender_source: highConfidence(
          'system',
          '客户详情接口补充性别来源：系统标签',
          'low',
          'system',
        ),
      },
      preferences: {
        ...emptyHighConfidenceFacts().preferences,
        city: highConfidence('上海', 'explicit_city'),
      },
      reasoning: 'test',
    };

    const prompt = buildSessionExtractionPrompt(brandData, 'msg', [], [], ruleFacts);

    expect(prompt).toContain('年龄: 24（置信度: high，来源: rule，证据: 年龄识别：24）');
    expect(prompt).toContain(
      '性别: 女（系统标签，未经候选人自陈，不得用于直接排除候选人）（置信度: low，来源: system，证据: 客户详情接口补充性别：女）',
    );
    expect(prompt).toContain('意向城市: 上海（置信度: high，来源: rule，证据: explicit_city）');
  });

  it('should show "无" when ruleFacts is null', () => {
    const prompt = buildSessionExtractionPrompt(brandData, '用户: 你好', [], [], null);

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

    expect(prompt).toContain('联系方式: 13900139000');
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
    expect(prompt).toContain('是否学生: 否');
  });

  it('should be backwards-compatible when ruleFacts is omitted', () => {
    const prompt = buildSessionExtractionPrompt(brandData, '用户: 你好', ['用户: 之前的消息']);

    expect(prompt).toContain('[规则模式匹配线索');
    expect(prompt).toContain('无');
    expect(prompt).toContain('[历史对话]');
    expect(prompt).toContain('之前的消息');
  });
});
