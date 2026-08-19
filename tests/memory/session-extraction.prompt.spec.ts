import {
  SESSION_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionIdentityProvenanceCorpus,
  buildSessionExtractionPrompt,
} from '@memory/services/session-extraction.prompt';
import {
  FALLBACK_EXTRACTION,
  LLMEntityExtractionResultSchema,
} from '@memory/types/session-facts.types';
import { testRuleFact, testRuleFacts } from '../helpers/rule-fact-claims.fixture';

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
      // 字段规则与封闭白名单都保留该口径
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '明确用工形式表述 → labor_form（按字段定义的映射规则）',
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
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '明确用工形式表述 → labor_form（按字段定义的映射规则）',
      );
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
        '口语时间/班次归一 → schedule/time_windows',
      );
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

    it('defines the labor_form_intent three-state shadow label with verbatim quotes', () => {
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('用工形式意向三态（labor_form_intent）');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('set：明确选择或接受');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('clear：明确排除或撤销旧偏好');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('ignore：未表达用工形式偏好');
      expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('quote 必须逐字取自本轮候选人原话');

      const parsed = LLMEntityExtractionResultSchema.safeParse({
        ...FALLBACK_EXTRACTION,
        labor_form_intent: {
          intent: 'set',
          labor_form: '小时工',
          quote: '想找小时工',
        },
        reasoning: 'candidate explicitly selected hourly work',
      });
      expect(parsed.success).toBe(true);
    });
  });

  it('uses a closed inference allowlist and explicitly permits an empty answer', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('推断白名单制');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('白名单外的任何推断');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('本轮无新信息就交空卷');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('reasoning 固定写「本轮无新信息」');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain(
      '结合上下文理解和常识知识推理出相关事实',
    );
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('姓名：赵堤');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).not.toContain('18xxx');

    const emptyTurn = LLMEntityExtractionResultSchema.parse({
      ...FALLBACK_EXTRACTION,
      reasoning: '本轮无新信息',
    });
    expect(Object.values(emptyTurn.interview_info).every((value) => value === null)).toBe(true);
    expect(Object.values(emptyTurn.preferences).every((value) => value === null)).toBe(true);
    expect(emptyTurn.reasoning).toBe('本轮无新信息');
  });

  it('forbids reasoning from inventing resume/file/material sources', () => {
    const reasoningDescription = LLMEntityExtractionResultSchema.shape.reasoning.description;
    expect(reasoningDescription).toContain('本轮无新信息');
    expect(reasoningDescription).toContain('禁止叙述对话中不存在的来源');
    expect(reasoningDescription).toContain('从简历/文件/材料中提取');
  });
});

describe('buildSessionExtractionPrompt', () => {
  const brandData = [{ name: '肯德基', aliases: ['KFC'] }];

  it('should include rule facts section when ruleFacts is provided', () => {
    const ruleFacts = testRuleFacts(
      testRuleFact('interview_info.name', '赵堤', '结构化姓名识别：赵堤'),
      testRuleFact('interview_info.phone', '18800001111', '手机号识别：18800001111'),
      testRuleFact('interview_info.age', '24', '年龄识别：24'),
      testRuleFact('interview_info.gender', '男', '性别识别：男'),
      testRuleFact('interview_info.gender_source', 'candidate', '性别来源：候选人自陈'),
      testRuleFact('preferences.city', '上海', 'explicit_city'),
      testRuleFact('preferences.district', ['浦东'], '区域识别：浦东'),
    );

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

  it('should pass all ruleFacts to LLM with confidence/source/evidence', () => {
    const ruleFacts = testRuleFacts(
      testRuleFact('interview_info.age', '24', '年龄识别：24'),
      testRuleFact('interview_info.gender', '女', '客户详情接口补充性别：女', {
        confidence: 'low',
        producer: 'system',
      }),
      testRuleFact('interview_info.gender_source', 'system', '客户详情接口补充性别来源：系统标签', {
        confidence: 'low',
        producer: 'system',
      }),
      testRuleFact('preferences.city', '上海', 'explicit_city'),
    );

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
    const prompt = buildSessionExtractionPrompt(brandData, '用户: 你好', [], [], testRuleFacts());

    expect(prompt).toContain('[规则模式匹配线索');
    // 空 claim 流应显示"无"
    const section = prompt.split('[规则模式匹配线索')[1].split('[历史对话]')[0];
    expect(section).toContain('无');
  });

  it('should only include fields with values, not null fields', () => {
    const ruleFacts = testRuleFacts(
      testRuleFact('interview_info.phone', '13900139000', '手机号识别：13900139000'),
    );

    const prompt = buildSessionExtractionPrompt(brandData, 'msg', [], [], ruleFacts);

    expect(prompt).toContain('联系方式: 13900139000');
    expect(prompt).not.toContain('姓名');
    expect(prompt).not.toContain('年龄');
    expect(prompt).not.toContain('性别');
  });

  it('should include is_student=false as explicit signal', () => {
    const ruleFacts = testRuleFacts(
      testRuleFact('interview_info.is_student', false, '学生身份识别：否'),
    );

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

  it('injects fetched jobs, current focus, and visual facts from the turn ledger', () => {
    const job = {
      jobId: 519709,
      brandName: '奥乐齐',
      jobName: '分拣打包',
      storeName: '长白店',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '全职',
      salaryDesc: '6200-9800 元/月',
      jobCategoryName: '分拣员',
    };
    const prompt = buildSessionExtractionPrompt(
      brandData,
      '用户: 那个店我可以',
      [],
      [],
      null,
      undefined,
      null,
      {
        jobs: {
          fetchedJobs: [job],
          currentFocusJob: { ...job, jobId: 519710, storeName: '五角场店' },
        },
        visual: {
          factSheets: [
            {
              messageId: 'img-1',
              sheet: {
                kind: 'resume',
                fields: [{ key: 'phone', value: '15887265838', ownership: 'candidate' }],
                rawDescription: '候选人简历截图',
                degraded: false,
              },
            },
          ],
        },
      },
    );

    expect(prompt).toContain('[本轮工具事实]');
    expect(prompt).toContain('本轮推荐岗位');
    expect(prompt).toContain('jobId=519709');
    expect(prompt).toContain('当前焦点岗位');
    expect(prompt).toContain('jobId=519710');
    expect(prompt).toContain('phone=15887265838（candidate）');
  });

  it('omits the tool facts section when the ledger summary is empty', () => {
    const prompt = buildSessionExtractionPrompt(
      brandData,
      '用户: 你好在吗',
      [],
      [],
      null,
      undefined,
      null,
      { jobs: { fetchedJobs: [], currentFocusJob: null }, visual: { factSheets: [] } },
    );

    expect(prompt).not.toContain('[本轮工具事实]');
  });

  it('builds identity provenance only from the dialogue window and confirmed facts', () => {
    const corpus = buildExtractionIdentityProvenanceCorpus(
      '用户: 我电话 158 8726 5838',
      ['助手: 请问怎么称呼', '用户: 我叫李梅', '[图片描述] 姓名李梅'],
      null,
    );

    expect(corpus).toContain('我叫李梅');
    expect(corpus).toContain('[图片描述] 姓名李梅');
    expect(corpus).toContain('158 8726 5838');
    expect(corpus).not.toContain(SESSION_EXTRACTION_SYSTEM_PROMPT);
    expect(corpus).not.toContain('[本轮工具事实]');
    expect(corpus).not.toContain('[规则模式匹配线索');
  });
});
