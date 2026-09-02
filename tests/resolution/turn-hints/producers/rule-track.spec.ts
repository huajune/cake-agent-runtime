import {
  detectBrandAliasHints,
  extractStructuredName,
  produceTurnHints,
} from '@resolution/turn-hints/producers/rule-track';
import { projectTurnHints } from '@resolution/turn-hints/reducer';

function extractTurnHints(...args: Parameters<typeof produceTurnHints>) {
  return projectTurnHints(produceTurnHints(...args));
}

function readProjectedValue<T>(value: T | null | undefined): T | null {
  if (
    value &&
    typeof value === 'object' &&
    'value' in value &&
    'confidence' in value &&
    'evidence' in value
  ) {
    return value.value as T;
  }
  return value ?? null;
}

describe('turn-hints rule track', () => {
  const brandData = [
    { name: '来伊份', aliases: ['来一份', '来1份'] },
    { name: '肯德基', aliases: ['KFC'] },
    { name: '瑞幸咖啡', aliases: ['瑞幸', 'luckin'] },
    { name: '报亭咖啡', aliases: ['报', '报亭'] },
    { name: 'M Stand', aliases: ['mstand'] },
  ];

  // 品牌写入收口（§9.2）：品牌真相只在 brand_state（写入经 turn-finalizer reducer），
  // extractTurnHints 不再把品牌写进 preferences.brands；
  // 品牌线索（归一化提示）由 detectBrandAliasHints 适配层继续产出。

  // 引用块剥离（§19.2）：引用块里的品牌是招募经理/Agent 的话，不是候选人自陈。
  // 剥离收在 detectBrandAliasHints 入口内，调用方传原始消息也不会漏。
  describe('detectBrandAliasHints 引用块剥离', () => {
    it('引用块内的品牌不产出线索（Agent 自污染回路，生产实例 6a5f21ef）', () => {
      // 候选人引用 Agent 说过的话，其中的品牌不是候选人的意向表达。
      const hints = detectBrandAliasHints(
        ['[引用 辛瑜琦：肯德基和瑞幸咖啡都在招]\n姐，这个群可以拉我一下嘛'],
        brandData,
      );
      expect(hints).toEqual([]);
    });

    it('行首"引用 XXX："形态同样剥离', () => {
      expect(detectBrandAliasHints(['引用 辛瑜琦：肯德基在招人'], brandData)).toEqual([]);
    });

    it('只剥引用块、正文品牌照常命中（引用肯德基 + 正文瑞幸 → 只出瑞幸）', () => {
      const hints = detectBrandAliasHints(
        ['[引用 辛瑜琦：肯德基在招人]\n我要瑞幸咖啡兼职'],
        brandData,
      );
      expect(hints.map((h) => h.brandName)).toEqual(['瑞幸咖啡']);
    });

    it('整条消息只有引用块时短路，不产出线索', () => {
      expect(detectBrandAliasHints(['[引用 辛瑜琦：肯德基在招人]'], brandData)).toEqual([]);
    });
  });

  it('工种词"咖啡师"不当品类词展开（§7.3 工种后缀护栏）', () => {
    expect(detectBrandAliasHints(['咖啡师'], brandData)).toEqual([]);
  });

  it('should surface brand alias hints without writing preferences.brands', () => {
    const hints = detectBrandAliasHints(['来一份'], brandData);
    expect(hints.map((hint) => hint.brandName)).toEqual(['来伊份']);

    const result = extractTurnHints(['来一份'], brandData);
    expect(result?.preferences.brands ?? null).toBeNull();
  });

  it('should keep brand hint reasoning when other facts exist', () => {
    const result = extractTurnHints(['来一份，我25岁'], brandData);
    expect(result?.preferences.brands ?? null).toBeNull();
    expect(result?.reasoning).toContain('来伊份');
  });

  it('should not misclassify generic phrases as brands', () => {
    expect(detectBrandAliasHints(['给我来一份工作'], brandData)).toEqual([]);
    expect(extractTurnHints(['给我来一份工作'], brandData)).toBeNull();
  });

  it('should match a distinctive brand embedded in a sentence (containment)', () => {
    // 旧的全等匹配会因为 "我要"/"兼职" 未被恰好剥离而漏掉品牌；
    // 长别称改为子串包含后，品牌嵌在句子里也能命中。
    const hints = detectBrandAliasHints(['我要瑞幸咖啡兼职'], brandData);
    expect(hints.map((hint) => hint.brandName)).toContain('瑞幸咖啡');
  });

  it('should not let short generic aliases false-match common words (报名)', () => {
    // 报亭咖啡 的短别称 "报" 不可被 "报名" 命中。
    const hints = detectBrandAliasHints(['我要报名面试'], brandData);
    expect(hints.map((hint) => hint.brandName)).not.toContain('报亭咖啡');
  });

  it('should expand generic 咖啡兼职 to the whole category, not a position', () => {
    // 2026-07-20 产品裁定撤除 defaultBrand：品类词展开为全部成员品牌，不收敛到 M Stand。
    const hints = detectBrandAliasHints(['我要咖啡兼职'], brandData);
    expect(hints.map((hint) => hint.brandName).sort()).toEqual(['M Stand', '报亭咖啡', '瑞幸咖啡']);
    expect(hints[0].matchedAlias).toBe('咖啡(品类)');

    // 规则层绝不能把品类词识别成具体岗位
    const result = extractTurnHints(['我要咖啡兼职'], brandData);
    expect(readProjectedValue(result?.preferences.position) ?? []).not.toContain('咖啡师');
  });

  it('should prefer the specific brand over category expansion when one is named', () => {
    // 指名"瑞幸咖啡"时只取该品牌，不应再展开成整个咖啡品类。
    const hints = detectBrandAliasHints(['我要瑞幸咖啡兼职'], brandData);
    expect(hints.map((hint) => hint.brandName)).toEqual(['瑞幸咖啡']);
  });

  it('should not match conjunction chars as brand alias', () => {
    const brands = [{ name: '和府捞面', aliases: ['和'] }];
    expect(detectBrandAliasHints(['肯德基和星巴克'], brands)).toEqual([]);
  });

  it('should extract explicit high-confidence entities from one sentence', () => {
    const message = '上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空';
    const produced = produceTurnHints([message], brandData);
    const result = projectTurnHints(produced);

    expect(result?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      evidence: 'municipality_compact',
    });
    expect(readProjectedValue(result?.preferences.district)).toEqual(['杨浦']);
    // 全职放开后，"兼职"是合法用工形式筛选维度，应被提取。
    expect(readProjectedValue(result?.preferences.labor_form)).toBe('兼职');
    expect(readProjectedValue(result?.preferences.position)).toEqual(['服务员']);
    expect(readProjectedValue(result?.preferences.schedule)).toBe('周末');
    expect(readProjectedValue(result?.interview_info.gender)).toBe('男');
    expect(
      produced?.claims.find((claim) => claim.field === 'interview_info.gender'),
    ).toEqual(expect.objectContaining({ producer: 'candidate_quote', confidence: 'high' }));
    expect(readProjectedValue(result?.interview_info.age)).toBe('25');
    expect(readProjectedValue(result?.interview_info.has_health_certificate)).toBe('有');
  });

  it('should extract work experience for booking supplement backfill', () => {
    const result = extractTurnHints(['肯德基服务员4个多月', '河南烤肉自助服务员3个月'], brandData);

    expect(readProjectedValue(result?.interview_info.experience)).toBe('肯德基服务员4个多月');
  });

  describe('工作经历不得跨行吞掉手机号（badcase 2026-08-06 chat 6a1e42c5）', () => {
    // 候选人按收资模板换行回填时，durationPattern 里的 `\s*` 会吃掉 `\n`：
    // 正文从"电话1387289616"起头、`\d+` 吃掉"3"、跨行后由下一行"年龄"的"年"收尾，
    // 得到 experience="电话13872896163年"（source=rule/confidence=high），
    // 并已渲染进 precheck 的"过往公司+岗位+年限"，会随 booking 提交到工单。
    it('模板回填的电话行不再被当成工作经历', () => {
      const result = extractTurnHints(
        [
          '大米先生\n姓名颜端樟   \n电话13872896163  \n年龄22    \n性别男   \n有无健康证 无\n下午3点半',
        ],
        brandData,
      );

      expect(readProjectedValue(result?.interview_info.experience)).toBeNull();
      // 同一条消息里本该抽到的字段不能被误伤
      expect(readProjectedValue(result?.interview_info.phone)).toBe('13872896163');
      expect(readProjectedValue(result?.interview_info.age)).toBe('22');
    });

    it.each([
      ['手机号：17696566584\n年龄20', '6a6837b6'],
      ['联系方式：19663930499\n年龄：26', '6a6c5634'],
      ['庞子瑞18036615809女\n8月能到岗', '6a6ac29b'],
    ])('生产同形态脏值 %s 不入档（chat %s）', (message) => {
      const result = extractTurnHints([message], brandData);
      expect(readProjectedValue(result?.interview_info.experience)).toBeNull();
    });

    it('真实经历不因本次收紧而回退', () => {
      // 行内空格仍要容忍，且"手机店/电话客服"这类含联系方式字样的合法经历必须放过
      // ——判据只能是 11 位手机号形态，不能是"电话/手机"标签词。
      // 注：捕获含"在"前缀是既有行为，本次未改动，如实断言。
      for (const [message, expected] of [
        ['肯德基服务员 4 个多月', '肯德基服务员4个多月'],
        ['在华为手机店做了3年', '在华为手机店做了3年'],
      ] as const) {
        const result = extractTurnHints([message], brandData);
        expect(readProjectedValue(result?.interview_info.experience)).toBe(expected);
      }
    });
  });

  it('should extract resume upload URL when the file name looks like a resume', () => {
    const result = extractTurnHints(
      [
        '[文件消息] 文件名：张三简历.pdf；文件地址：https://example.com/resume.pdf；文件大小：2KB\n简历附件：https://example.com/resume.pdf',
      ],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.upload_resume)).toBe(
      'https://example.com/resume.pdf',
    );
  });

  it('should ignore non-URL text glued after 简历附件 label (工单 438358 badcase)', () => {
    // 候选人回填模板时把下一项内容连在"简历附件："后面，这段文字不得入档为简历，
    // 否则会被 booking 当作云存储 key 提交，海绵侧简历打不开。
    const result = extractTurnHints(
      ['姓名：喻某\n简历附件：过往公司+岗位+年限：某建设集团有限公司+管理+5年\n居住地址：'],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.upload_resume) ?? null).toBeNull();
  });

  it('should fall back to file message URL when 简历附件 label holds non-URL text', () => {
    const result = extractTurnHints(
      [
        '简历附件：见文件\n[文件消息] 文件名：张三简历.pdf；文件地址：https://example.com/resume.pdf；文件大小：2KB',
      ],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.upload_resume)).toBe(
      'https://example.com/resume.pdf',
    );
  });

  it('should extract upload resume from vision-described resume image message', () => {
    // 手写简历/简历照片：vision 描述回写时追加 "简历附件：URL" 行（图片简历支持）
    const result = extractTurnHints(
      [
        '[图片消息] 简历图片：姓名兮兮，手机号18271421690，籍贯启东，身高163cm。\n简历附件：https://example.com/artwork/abc123.jpg',
      ],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.upload_resume)).toBe(
      'https://example.com/artwork/abc123.jpg',
    );
  });

  it('should not extract upload resume from unrelated PDF file names', () => {
    const result = extractTurnHints(
      [
        '[文件消息] 文件名：入职材料.pdf；文件地址：https://example.com/onboarding.pdf；文件大小：2KB',
      ],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.upload_resume)).toBeNull();
  });

  it('should keep first stable scalars but use latest health and labor-form values', () => {
    const result = extractTurnHints(
      [
        '我25岁，男的，本科，有健康证，想做小时工，工资5000-6000，周末有空，13800138000',
        '我18岁，女的，硕士，没有健康证，想做寒假工，工资7000-8000，早班，13900139000',
      ],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.phone)).toBe('13800138000');
    expect(readProjectedValue(result?.interview_info.age)).toBe('25');
    expect(readProjectedValue(result?.interview_info.gender)).toBe('男');
    expect(readProjectedValue(result?.interview_info.education)).toBe('本科');
    // 健康证状态和办理意愿会变化，以最后一次明确表达为准。
    expect(readProjectedValue(result?.interview_info.has_health_certificate)).toBe('无');
    // labor_form 是意向字段，同批多条消息以候选人最后一次明确表达为准。
    expect(readProjectedValue(result?.preferences.labor_form)).toBe('寒假工');
    expect(readProjectedValue(result?.preferences.salary)).toBe('工资5000-6000');
    expect(readProjectedValue(result?.preferences.schedule)).toBe('周末');
  });

  it('emits every rule hit as an evidence-anchored claim before field policies resolve it', () => {
    const firstMessage = '我25岁，有健康证，想做小时工';
    const secondMessage = '我18岁，没有健康证，想做寒假工';
    const produced = produceTurnHints([firstMessage, secondMessage], brandData);

    expect(
      produced?.claims
        .filter((claim) => claim.field === 'interview_info.age')
        .map((claim) => ({ value: claim.value, quote: claim.evidence.quote })),
    ).toEqual([
      { value: '25', quote: '25岁' },
      { value: '18', quote: '18岁' },
    ]);
    expect(
      produced?.claims
        .filter((claim) => claim.field === 'interview_info.has_health_certificate')
        .map((claim) => claim.value),
    ).toEqual(['有', '无']);
    expect(readProjectedValue(projectTurnHints(produced)?.interview_info.age)).toBe('25');
    expect(
      readProjectedValue(projectTurnHints(produced)?.interview_info.has_health_certificate),
    ).toBe('无');
    expect(readProjectedValue(projectTurnHints(produced)?.preferences.labor_form)).toBe(
      '寒假工',
    );
  });

  it('should not extract phone from longer numeric strings', () => {
    const result = extractTurnHints(['订单号20261380013800123'], brandData);

    expect(result?.interview_info.phone ?? null).toBeNull();
  });

  it('should not extract age from job requirement wording', () => {
    const result = extractTurnHints(['要求20-35岁'], brandData);

    expect(result?.interview_info.age ?? null).toBeNull();
  });

  it('should extract structured age even when message also contains requirement text', () => {
    const result = extractTurnHints(['年龄：22，要求：18岁以上'], brandData);

    expect(readProjectedValue(result?.interview_info.age)).toBe('22');
  });

  it('should extract structured age when the value is written without a separator', () => {
    const result = extractTurnHints(
      ['姓名：张琰\n电话：19986247174\n年龄24\n明天吧\n有'],
      brandData,
    );

    expect(result?.interview_info.name).toBe('张琰');
    expect(result?.interview_info.phone).toBe('19986247174');
    expect(result?.interview_info.age).toBe('24');
  });

  it.each([
    ['年龄24', '24'],
    ['年龄 24', '24'],
    ['年龄：24', '24'],
    ['年龄:24', '24'],
    ['年龄 24岁', '24'],
    ['我24岁', '24'],
    ['今年24', '24'],
    ['岗位要求25-50岁，我24岁', '24'],
  ])('should extract candidate age from raw wording: %s', (raw, expectedAge) => {
    const result = extractTurnHints([raw], brandData);

    expect(readProjectedValue(result?.interview_info.age)).toBe(expectedAge);
  });

  it('should not extract structured age from age range text without a separator', () => {
    const result = extractTurnHints(['年龄25-50岁'], brandData);

    expect(result?.interview_info.age ?? null).toBeNull();
  });

  it('should extract candidate age when job requirement age appears in the same message', () => {
    const result = extractTurnHints(['岗位要求25-50岁，我24岁'], brandData);

    expect(readProjectedValue(result?.interview_info.age)).toBe('24');
  });

  it('should not extract salary from generic numeric ranges', () => {
    const result = extractTurnHints(['编号100-200'], brandData);

    expect(result?.preferences.salary ?? null).toBeNull();
  });

  it('should extract schedule hard constraints beyond simple shift keywords', () => {
    expect(
      readProjectedValue(
        extractTurnHints(['每周最多也就能干两天'], brandData)?.preferences.schedule,
      ),
    ).toBe('每周最多两天');

    expect(
      readProjectedValue(extractTurnHints(['我只能做一休一'], brandData)?.preferences.schedule),
    ).toBe('做一休一（隔天轮换，每周约3-4天）');

    expect(
      readProjectedValue(extractTurnHints(['有没有不上夜班的'], brandData)?.preferences.schedule),
    ).toBe('夜班、不上夜班');

    expect(
      readProjectedValue(extractTurnHints(['我今天六点才能下班'], brandData)?.preferences.schedule),
    ).toBe('下班后');
  });

  describe('schedule_constraint (Phase 3.1 structured)', () => {
    it('extracts onlyWeekends from "只能周末上班"', () => {
      const constraint = extractTurnHints(['我只能周末上班'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.onlyWeekends).toBe(true);
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBeNull();
    });

    it('extracts onlyEvenings from "只做晚班"', () => {
      const constraint = extractTurnHints(['我只做晚班'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.onlyEvenings).toBe(true);
    });

    it('「做一休一」是隔天轮换（≈每周3-4天），保守取 3——绝不是每周 1 天', () => {
      const constraint = extractTurnHints(['我只能做一休一'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBe(3);
    });

    it('N+M=7 的「做三休四」周频恰为 N', () => {
      const constraint = extractTurnHints(['我做三休四'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBe(3);
    });

    it('N+M=7 的「做六休一」周频恰为 N', () => {
      const constraint = extractTurnHints(['可以做六休一'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBe(6);
    });

    it('extracts maxDaysPerWeek=2 from "每周最多两天"', () => {
      const constraint = extractTurnHints(['每周最多也就能干两天'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBe(2);
    });

    it('「做二休一」= 3 天循环，周频 7×2/3 ≈ 4 天（保守下取整）', () => {
      const constraint = extractTurnHints(['可以做二休一'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBe(4);
    });

    it('combines multiple constraints in one message', () => {
      const constraint = extractTurnHints(['我只能周末做晚班，每周最多两天'], brandData)
        ?.preferences.schedule_constraint;
      expect(readProjectedValue(constraint)?.onlyWeekends).toBe(true);
      expect(readProjectedValue(constraint)?.onlyEvenings).toBe(true);
      expect(readProjectedValue(constraint)?.maxDaysPerWeek).toBe(2);
    });

    it('returns null when no constraint signal', () => {
      const constraint = extractTurnHints(['你好我想看下兼职'], brandData)?.preferences
        .schedule_constraint;
      expect(constraint ?? null).toBeNull();
    });

    // badcase batch_6a4e430dce406a6aee7a3421：候选人说"周六"而非"周末"，
    // 约束整轮丢失，模型反手把"七点才下班"译成 onlyEvenings
    it('extracts onlyWeekends from 周六求职意图"帮我找黄浦区周六嘛兼职"', () => {
      const facts = extractTurnHints(['帮我找黄浦区周六嘛兼职'], brandData);
      const constraint = readProjectedValue(facts?.preferences.schedule_constraint);
      expect(constraint?.onlyWeekends).toBe(true);
      expect(constraint?.onlyEvenings).toBeNull();
      expect(readProjectedValue(facts?.preferences.schedule)).toContain('周末');
    });

    it('extracts onlyWeekends from "只能星期六"', () => {
      const constraint = extractTurnHints(['我只能星期六过来上班'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.onlyWeekends).toBe(true);
    });

    it('extracts onlyWeekends from "周末有没有活"', () => {
      const constraint = extractTurnHints(['周末有没有活'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.onlyWeekends).toBe(true);
    });

    it('does not treat 周六面试时间安排 as weekend constraint', () => {
      const constraint = extractTurnHints(['周六下午过来面试可以吗'], brandData)?.preferences
        .schedule_constraint;
      expect(readProjectedValue(constraint)?.onlyWeekends ?? null).toBeNull();
    });
  });

  describe('available_after (Phase 3.2 future date constraint)', () => {
    beforeAll(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-20T10:00:00+08:00'));
    });
    afterAll(() => {
      jest.useRealTimers();
    });

    it('extracts明确日期"5月1日之后" → next future date', () => {
      const aa = extractTurnHints(['5月1日之后才能来面试'], brandData)?.preferences.available_after;
      expect(readProjectedValue(aa)?.date).toBe('2026-05-01');
      expect(readProjectedValue(aa)?.raw).toContain('5月1日');
    });

    it('extracts full date "2026-05-15 之后"', () => {
      const aa = extractTurnHints(['2026-05-15之后再面试吧'], brandData)?.preferences
        .available_after;
      expect(readProjectedValue(aa)?.date).toBe('2026-05-15');
    });

    it('rolls over to next year when month-day already passed', () => {
      const aa = extractTurnHints(['3月10日之后联系'], brandData)?.preferences.available_after;
      // 当前 2026-04-20，3月10日已过 → 2027-03-10
      expect(readProjectedValue(aa)?.date).toBe('2027-03-10');
    });

    it('does NOT extract fuzzy wording like "月底/等开学/下周再说"', () => {
      expect(
        extractTurnHints(['等开学再说'], brandData)?.preferences.available_after,
      ).toBeUndefined();
      expect(
        extractTurnHints(['月底再面试'], brandData)?.preferences.available_after,
      ).toBeUndefined();
    });
  });

  it.each([
    '都是需要有食品健康证是吗',
    '需要健康证吗',
    '是不是要先办健康证？',
    '这个岗位要求食品健康证吧',
  ])('badcase zj8b3rj1: 疑问句/要求转述不算持有健康证: %s', (message) => {
    expect(
      extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
    ).toBeUndefined();
  });

  it('裸类型词仅被提及不算持有（需持有动词或完成表述）', () => {
    expect(
      extractTurnHints(['上岗前需要食品健康证'], brandData)?.interview_info.has_health_certificate,
    ).toBeUndefined();
    expect(
      readProjectedValue(
        extractTurnHints(['食品健康证我已经办好了'], brandData)?.interview_info
          .has_health_certificate,
      ),
    ).toBe('有');
  });

  it('should distinguish health certificate type from missing certificate wording', () => {
    expect(
      readProjectedValue(
        extractTurnHints(['我有食品类健康证'], brandData)?.interview_info.has_health_certificate,
      ),
    ).toBe('有');
    expect(
      readProjectedValue(
        extractTurnHints(['健康证不是本地的'], brandData)?.interview_info.has_health_certificate,
      ),
    ).toBe('非本地健康证');
    expect(
      readProjectedValue(
        extractTurnHints(['我有上海本地健康证'], brandData)?.interview_info.has_health_certificate,
      ),
    ).toBe('有');
    expect(
      readProjectedValue(
        extractTurnHints(['我没有食品健康证'], brandData)?.interview_info.has_health_certificate,
      ),
    ).toBe('无');
  });

  it.each(['我有健康证，但是外地的', '我有健康证，是外地办的', '我有健康证，不是本地的'])(
    'keeps cross-clause non-local qualifier from upgrading to 有: %s（评审 874 P1-3 回归）',
    (message) => {
      expect(
        readProjectedValue(
          extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
        ),
      ).toBe('非本地健康证');
    },
  );

  it('still extracts 有 when the follow-up clause has no qualifier', () => {
    expect(
      readProjectedValue(
        extractTurnHints(['我有健康证，明天就能到岗'], brandData)?.interview_info
          .has_health_certificate,
      ),
    ).toBe('有');
  });

  it.each([
    '如果面试上了，他后期会去体检，然后办一个健康证',
    '目前没有健康证，但确定上岗前会去办',
    '我愿意入职前再办一张食品健康证',
    '后面去体检办健康证没问题',
    '我没有健康证，可以去办',
    '健康证暂时没有，入职前我会去办',
    '我愿意办健康证，费用怎么报销？',
    '我愿意办健康证，健康证费用怎么报销？',
    '健康证费用怎么报销？我愿意去办健康证',
    '我没有健康证，可以去免费办理',
  ])(
    'should treat future health-certificate commitment as accepting application: %s',
    (message) => {
      expect(
        readProjectedValue(
          extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
        ),
      ).toBe('无但接受办理健康证');
    },
  );

  it('should recognize a labeled health-certificate value without inventing willingness', () => {
    const result = extractTurnHints(['健康证：无'], brandData);

    expect(readProjectedValue(result?.interview_info.has_health_certificate)).toBe('无');
  });

  it('should let the latest explicit health-certificate answer override older history', () => {
    const result = extractTurnHints(
      ['健康证：无', '如果面试上了，后期会去体检，然后办一个健康证'],
      brandData,
    );

    expect(readProjectedValue(result?.interview_info.has_health_certificate)).toBe(
      '无但接受办理健康证',
    );
  });

  it.each([
    '健康证怎么办呀？',
    '能不能办健康证？',
    '这个需要我去办健康证吗？',
    '食品健康证哪里能免费办？公司会全额报销吗？',
    '健康证哪里能办？',
    '健康证可以线上办理吗？',
    '公司会帮我办健康证吗？',
    '公司会不会帮我办健康证？',
    '健康证后期会去办吗？',
    '健康证入职前会去办吗？',
    '健康证后期怎么办？',
    '健康证入职前怎么办呢？',
    '入职前可以办理健康证吗？',
    '后面可以去办健康证吗？',
    '你们接受办健康证吗？',
    '公司愿意帮我办健康证吗？',
    '门店准备统一办健康证吗？',
    '办健康证要多少钱，公司会报销吗？',
    '健康证办理费用公司会全额报销吗？',
    '健康证怎么办？我是本地人。',
    '健康证哪里办？其他材料已经办好了。',
    '健康证哪里办？我愿意办理入职手续。',
    '健康证怎么办？我准备办银行卡。',
  ])(
    'should not treat a health-certificate question as an application commitment: %s',
    (message) => {
      expect(
        readProjectedValue(
          extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
        ) ?? null,
      ).toBeNull();
    },
  );

  it.each([
    '我没有健康证，健康证哪里能免费办？',
    '我没有健康证，可以免费办理吗？',
    '我没有健康证，公司会帮我办吗？',
    '我没有健康证，我可以办理入职。',
  ])(
    'should preserve an explicit missing-certificate status before a consultation: %s',
    (message) => {
      expect(
        readProjectedValue(
          extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
        ),
      ).toBe('无');
    },
  );

  it.each([
    '我不打算办健康证',
    '后面也不会去办食品健康证',
    '不愿意去体检然后办健康证',
    '不可以去体检然后办健康证',
    '我不太愿意后面再去体检然后办一张食品健康证',
    '健康证我不考虑之后再去办理',
    '我不愿意办健康证，健康证费用怎么报销？',
  ])('should keep explicit refusal authoritative: %s', (message) => {
    expect(
      readProjectedValue(
        extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
      ),
    ).toBe('无且不接受办理健康证');
  });

  it.each([
    ['我原本不愿意办健康证，但现在愿意办健康证', '无但接受办理健康证'],
    ['我原本愿意办健康证，但现在不愿意办健康证', '无且不接受办理健康证'],
  ])('should let the latest explicit clause win: %s', (message, expected) => {
    expect(
      readProjectedValue(
        extractTurnHints([message], brandData)?.interview_info.has_health_certificate,
      ),
    ).toBe(expected);
  });

  it('should treat admitted or enrolled graduate students as student identity', () => {
    const admitted = extractTurnHints(['我去年毕业了但是今年考上研究生了能行吗'], brandData);
    expect(readProjectedValue(admitted?.interview_info.is_student)).toBe(true);
    expect(readProjectedValue(admitted?.interview_info.education)).toBe('硕士');

    const undergrad = extractTurnHints(['学历填本科在读有影响吗'], brandData);
    expect(readProjectedValue(undergrad?.interview_info.is_student)).toBe(true);
    expect(readProjectedValue(undergrad?.interview_info.education)).toBe('本科');
  });

  it('should normalize "本科在读" to the Sponge education label', () => {
    const result = extractTurnHints(['我是大三本科在读'], brandData);

    expect(readProjectedValue(result?.interview_info.education)).toBe('本科');
    expect(readProjectedValue(result?.interview_info.is_student)).toBe(true);
  });

  it.each([
    ['社会人士，目前待岗状态'],
    ['我是社会人士'],
    ['上班族，找个兼职'],
    ['我已经工作了'],
    ['之前工作过几年'],
    ['目前在职'],
    ['暂时待岗中'],
    ['失业了想找份兼职'],
    ['退休了想发挥余热'],
    ['全职妈妈，孩子上学后有空'],
    ['平时在家带娃'],
  ])('should mark non-student identity for message: %s', (message) => {
    const result = extractTurnHints([message], brandData);
    expect(readProjectedValue(result?.interview_info.is_student)).toBe(false);
  });

  it.each([
    ['社会人士岗位会影响我后续读书吗'],
    ['那就社会人士的早班吧'],
    ['嘉裕太阳城呢 不是有招社会人士岗吗'],
    ['那东方宝泰店我可以用社会人士身份入职是吗'],
  ])('should not treat job discussion as non-student identity: %s', (message) => {
    const result = extractTurnHints([message], brandData);
    expect(readProjectedValue(result?.interview_info.is_student)).toBeNull();
  });

  it('should extract labor_form (全职/兼职/小时工/寒假工/暑假工)', () => {
    const hourly = extractTurnHints(['我想做小时工'], brandData);
    expect(readProjectedValue(hourly?.preferences.labor_form)).toBe('小时工');

    const winter = extractTurnHints(['寒假想找寒假工'], brandData);
    expect(readProjectedValue(winter?.preferences.labor_form)).toBe('寒假工');

    // 全职放开后，"全职"/"兼职" 都是合法 labor_form 取值，应被提取。
    const partTime = extractTurnHints(['我要找兼职'], brandData);
    expect(readProjectedValue(partTime?.preferences.labor_form)).toBe('兼职');
    const fullTime = extractTurnHints(['我找全职'], brandData);
    expect(readProjectedValue(fullTime?.preferences.labor_form)).toBe('全职');

    // 伴随其他信号时，position 与 labor_form 都应提取。
    const combined = extractTurnHints(['想找兼职服务员'], brandData);
    expect(readProjectedValue(combined?.preferences.position)).toEqual(['服务员']);
    expect(readProjectedValue(combined?.preferences.labor_form)).toBe('兼职');
  });

  it.each(['暑期工', '暑期工作', '暑期兼职', '暑假兼职'])(
    'should normalize summer labor-form alias "%s" to 暑假工',
    (alias) => {
      const result = extractTurnHints([`我想找${alias}`], brandData);

      expect(readProjectedValue(result?.preferences.labor_form)).toBe('暑假工');
    },
  );

  it('should use the latest explicit labor form across batched user messages', () => {
    const result = extractTurnHints(['我想找兼职', '我只要暑期工'], brandData);

    expect(readProjectedValue(result?.preferences.labor_form)).toBe('暑假工');
  });

  it('should ignore a negated summer-worker phrase and extract the later part-time intent', () => {
    const result = extractTurnHints(['不是暑假工，想长期兼职'], brandData);

    expect(readProjectedValue(result?.preferences.labor_form)).toBe('兼职');
  });

  it('should not extract 暑假工 from an explicitly negated summer-work intent', () => {
    const result = extractTurnHints(['不找暑期工'], brandData);

    expect(readProjectedValue(result?.preferences.labor_form)).toBeNull();
  });

  it('should not lock an uncertain summer-worker answer to 暑假工', () => {
    const result = extractTurnHints(['我不知道是不是暑假工'], brandData);

    expect(readProjectedValue(result?.preferences.labor_form)).toBeNull();
  });

  it('should not enable summer-only filtering when the candidate explicitly accepts hourly work too', () => {
    const result = extractTurnHints(['暑假工或者小时工都可以'], brandData);

    expect(readProjectedValue(result?.preferences.labor_form)).toBe('小时工');
  });

  it('should not treat a question about the current job type as a new labor-form preference', () => {
    const result = extractTurnHints(['这个是小时工吗'], brandData);

    expect(readProjectedValue(result?.preferences.labor_form)).toBeNull();
  });

  it.each([
    ['暑假工我做不了，想找长期兼职', '兼职'],
    ['不要给我推荐暑假工，普通兼职就行', '兼职'],
    ['除了暑假工都可以', null],
    ['我不是只找暑假工，兼职也行', '兼职'],
    ['就是小时工是吗，一天9个小时？', null],
  ])(
    'should distinguish labor-form rejection and job-type clarification: %s',
    (message, expected) => {
      const result = extractTurnHints([message], brandData);

      expect(readProjectedValue(result?.preferences.labor_form)).toBe(expected);
    },
  );

  it.each([
    ['暑假工我做不了，想找长期兼职', '兼职'],
    ['不要给我推荐暑假工，普通兼职就行', '兼职'],
    ['除了暑假工都可以', null],
    ['我不是只找暑假工，兼职也行', '兼职'],
    ['就是小时工是吗，一天9个小时？', '暑假工'],
  ])(
    'should apply set/clear/ignore semantics after an earlier summer-only intent: %s',
    (message, expected) => {
      const result = extractTurnHints(['我只找暑假工', message], brandData);

      expect(readProjectedValue(result?.preferences.labor_form)).toBe(expected);
    },
  );

  it.each(['我不考虑普通兼职', '普通兼职不可以', '我不确定是暑假工还是小时工'])(
    'should not replace an existing summer intent with a rejected or uncertain alternative: %s',
    (message) => {
      const result = extractTurnHints(['我只找暑假工', message], brandData);

      expect(readProjectedValue(result?.preferences.labor_form)).toBe('暑假工');
    },
  );

  it.each(['我想找小时工，可以吗', '我就是想找小时工'])(
    'should still extract an explicit hourly-work preference: %s',
    (message) => {
      const result = extractTurnHints([message], brandData);

      expect(readProjectedValue(result?.preferences.labor_form)).toBe('小时工');
    },
  );

  it('区名唯一映射在查询路径生效（黄埔案，2026-07-28 收编）："黄埔区"→广州、"宝安"→深圳', () => {
    // 此前 黄埔→广州 只存在于 invite 城市门私表，提取路径不认——候选人报"黄埔区"
    // 仍被追问城市。统一到 UNIQUE_SUBDIVISION_TO_CITY 后提取层直接推导，补录只改一处。
    expect(extractTurnHints(['我在黄埔区这边找工作'], brandData)?.preferences.city).toEqual({
      value: '广州',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(extractTurnHints(['人在宝安'], brandData)?.preferences.city).toEqual({
      value: '深圳',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
  });

  it('should extract city from whitelist district even when preceded by greetings or positional verbs', () => {
    // badcase: 候选人发"你好我在青浦区"，贪婪正则把整段当成区名归一化为
    // "你好我在青浦"，导致 UNIQUE_SUBDIVISION_TO_CITY 永远查不到，city 留空，下游硬约束
    // 进入"当前没有已确认城市"分支，Agent 反复反问城市。修复后应正确识别青浦→上海。
    const greeted = extractTurnHints(['你好我在青浦区'], brandData);
    expect(greeted?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(readProjectedValue(greeted?.preferences.district)).toEqual(['青浦']);

    const positional = extractTurnHints(['我在浦东区'], brandData);
    expect(readProjectedValue(positional?.preferences.city)).toBe('上海');
    expect(readProjectedValue(positional?.preferences.district)).toEqual(['浦东']);

    const lived = extractTurnHints(['住在朝阳区'], brandData);
    expect(readProjectedValue(lived?.preferences.city)).toBe('北京');
    expect(readProjectedValue(lived?.preferences.district)).toEqual(['朝阳']);

    const nanjing = extractTurnHints(['我在栖霞区'], brandData);
    expect(nanjing?.preferences.city).toEqual({
      value: '南京',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(readProjectedValue(nanjing?.preferences.district)).toEqual(['栖霞']);

    const liuhe = extractTurnHints(['六合区'], brandData);
    expect(readProjectedValue(liuhe?.preferences.city)).toBe('南京');
    expect(readProjectedValue(liuhe?.preferences.district)).toEqual(['六合']);
  });

  it('should resolve city from whitelist district even when message glues district + sub-town/street', () => {
    // badcase 2026-05-18 (msg id 23946)：候选人发"浦东新区航头镇"，贪婪正则把整段
    // 当一个 district 捕获，归一化"浦东新区航头"查不到白名单，city 留空，硬约束
    // 又把 Agent 卡进"当前没有已确认城市"循环反问。重构成白名单驱动扫描后，
    // "浦东新区"应优先于"浦东"被认领，剩余"航头镇"通过正则兜底但**不影响 city 识别**。
    const district_plus_town = extractTurnHints(['浦东新区航头镇'], brandData);
    expect(district_plus_town?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(readProjectedValue(district_plus_town?.preferences.district)).toContain('浦东新区');

    // 同模式的另一种表达：区 + 街道
    const district_plus_street = extractTurnHints(['徐汇区漕河泾街道'], brandData);
    expect(readProjectedValue(district_plus_street?.preferences.city)).toBe('上海');
    expect(readProjectedValue(district_plus_street?.preferences.district)).toContain('徐汇');

    // 同模式的另一种城市：海淀 + 镇
    const beijing_district_plus_town = extractTurnHints(['海淀区清河镇'], brandData);
    expect(readProjectedValue(beijing_district_plus_town?.preferences.city)).toBe('北京');
    expect(readProjectedValue(beijing_district_plus_town?.preferences.district)).toContain('海淀');
  });

  it('should prefer the longest whitelist district when multiple keys could prefix match', () => {
    // "浦东" 和 "浦东新区" 都在白名单里。扫描必须先认领"浦东新区"，避免被短 key 偷走。
    const result = extractTurnHints(['浦东新区'], brandData);
    expect(readProjectedValue(result?.preferences.city)).toBe('上海');
    expect(readProjectedValue(result?.preferences.district)).toEqual(['浦东新区']);
  });

  it('should not extract education from location or school names', () => {
    const result = extractTurnHints(
      ['[位置分享] 大宁国际学校小学部（上海市静安区江场路1428号） [经纬度:31.295946,121.453613]'],
      brandData,
    );

    expect(result?.interview_info.education ?? null).toBeNull();
    expect(result?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      evidence: 'explicit_city',
    });
    expect(readProjectedValue(result?.preferences.district)).toEqual(['静安']);
    expect(readProjectedValue(result?.preferences.location)).toEqual([
      '大宁国际学校小学部',
      '上海市静安区江场路1428号',
    ]);
  });

  it.each(['大超市', '去夜市', '逛早市', '全市统一'])(
    'should not extract city from "%s"',
    (message) => {
      const result = extractTurnHints([message], brandData);

      expect(result?.preferences.city ?? null).toBeNull();
    },
  );

  it.each([
    ['苏州市有岗位吗', '苏州'],
    ['温岭市有活吗', '温岭'],
    ['芒市有店吗', '芒市'],
  ])('should extract explicit national city name from "%s"', (message, city) => {
    const result = extractTurnHints([message], brandData);

    expect(result?.preferences.city).toEqual({
      value: city,
      confidence: 'high',
      evidence: 'explicit_city',
    });
  });

  it('should map Yanji county-level city to the Sponge prefecture city and region (badcase 6a4f83a5ce406a6aeeeab4b2)', () => {
    const result = extractTurnHints(['延吉市铁男'], brandData);

    expect(result?.preferences.city).toEqual({
      value: '延边朝鲜族自治州',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(readProjectedValue(result?.preferences.district)).toEqual(['延吉市']);
  });

  it('昆山市 经县级市补录映射推导苏州市（Phase 3 补录，与延吉同构；badcase 同型防护）', () => {
    const result = extractTurnHints(['昆山市有没有兼职'], brandData);

    expect(result?.preferences.city).toEqual({
      value: '苏州市',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(readProjectedValue(result?.preferences.district)).toEqual(['昆山市']);
  });

  it('golden（Phase 0 基线）：余姚市 经区县白名单命中"余姚"推导宁波（方案 9.2 双轨现状）', () => {
    // 提取层现状：UNIQUE_SUBDIVISION_TO_CITY 的"余姚"在三轮扫描的 district 轮先命中，
    // city 推导为宁波；全国显式表的"余姚市→余姚"在此路径不生效。
    // Phase 3 海绵口径验证 + 县级市补录后，工具边界的转换将另行加测；本用例锁提取层不漂移。
    const result = extractTurnHints(['我在余姚市这边'], brandData);

    expect(result?.preferences.city).toEqual({
      value: '宁波',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
    expect(readProjectedValue(result?.preferences.district)).toEqual(['余姚']);
  });

  describe('extractStructuredName', () => {
    it('should extract name from "姓名：XX" key-value pair', () => {
      expect(extractStructuredName('姓名：赵堤')).toBe('赵堤');
      expect(extractStructuredName('姓名:张三')).toBe('张三');
      expect(extractStructuredName('名字：李四')).toBe('李四');
      expect(extractStructuredName('姓名 王五')).toBe('王五');
    });

    it('should extract name from multi-line structured form', () => {
      const form = '姓名：赵堤\n联系电话：18800001111\n年龄：24';
      expect(extractStructuredName(form)).toBe('赵堤');
    });

    it('should reject names that fail isLikelyRealChineseName', () => {
      expect(extractStructuredName('姓名：执子之魂加油')).toBeNull(); // 6 字 → 超上限
      expect(extractStructuredName('姓名：test123')).toBeNull(); // 非 CJK
      expect(extractStructuredName('姓名：加油宝贝吖哦')).toBeNull(); // 6 字 → 超上限
    });

    it('should return null when no structured name key is present', () => {
      expect(extractStructuredName('我叫张三')).toBeNull();
      expect(extractStructuredName('我是李四')).toBeNull();
      expect(extractStructuredName('想找工作')).toBeNull();
    });

    it('should accept 5-char minority names', () => {
      expect(extractStructuredName('姓名：布买日也木')).toBe('布买日也木');
    });

    it('should reject 6+ char names', () => {
      expect(extractStructuredName('姓名：阿不力克木江')).toBeNull();
    });
  });

  it('should extract structured name via extractTurnHints', () => {
    const result = extractTurnHints(['姓名：赵堤\n联系电话：18800001111\n年龄：24'], brandData);
    expect(readProjectedValue(result?.interview_info.name)).toBe('赵堤');
    expect(readProjectedValue(result?.interview_info.phone)).toBe('18800001111');
    expect(readProjectedValue(result?.interview_info.age)).toBe('24');
  });

  describe('extractStructuredName edge cases', () => {
    it('should NOT extract name from quoted block containing structured form', () => {
      // 引用块里的"姓名：XX"不是候选人填的，是经理发的模板
      // stripQuotedBlocks 剥离后剩余"好的我来填"，无可提取字段，整体返回 null
      const quoted = '[引用 李涵婷：姓名：王五\n联系电话：13800138000]\n好的我来填';
      const result = extractTurnHints([quoted], brandData);
      expect(result).toBeNull();
    });

    it('should extract name from candidate reply after quoted block', () => {
      // 引用块被剥离后，候选人自己填的部分应该被提取
      const msg = '[引用 经理：请按模板填写]\n姓名：赵堤\n年龄：24';
      const result = extractTurnHints([msg], brandData);
      expect(readProjectedValue(result?.interview_info.name)).toBe('赵堤');
      expect(readProjectedValue(result?.interview_info.age)).toBe('24');
    });

    it('should take first name when multiple messages contain structured names', () => {
      const result = extractTurnHints(['姓名：张三\n年龄：25', '姓名：李四\n年龄：30'], brandData);
      expect(readProjectedValue(result?.interview_info.name)).toBe('张三');
    });

    it('should extract name with space separator (姓名 XX)', () => {
      expect(extractStructuredName('姓名 赵堤')).toBe('赵堤');
    });

    it('should NOT extract single-char name from structured form', () => {
      // 单字不是合法姓名
      expect(extractStructuredName('姓名：赵')).toBeNull();
    });

    it('should NOT extract name when value is followed by comma on same line', () => {
      // 正则要求 value 延伸到行尾或字符串末尾，"姓名：张三，男"是单行混写，不符合结构化表单格式
      expect(extractStructuredName('姓名：张三，男')).toBeNull();
    });

    it('should extract name when value is on its own line even with trailing content below', () => {
      // 但如果"姓名：张三"独占一行，后面有其他行，应该提取
      expect(extractStructuredName('姓名：张三\n性别：男')).toBe('张三');
    });

    it('should handle time context suffix on structured form message', () => {
      // 短期记忆注入的时间后缀不应干扰结构化提取
      const msg = '姓名：赵堤\n年龄：24\n[消息发送时间：2026-04-23 14:26 周四]';
      const result = extractTurnHints([msg], brandData);
      expect(readProjectedValue(result?.interview_info.name)).toBe('赵堤');
    });

    it('should coexist with auto-greeting in multi-message extraction', () => {
      // T1 打招呼"我是阳光明媚"，T5 填表"姓名：赵堤"
      // 规则层应提取"赵堤"，不受打招呼语干扰
      const result = extractTurnHints(
        ['我是阳光明媚', '你好', '姓名：赵堤\n联系电话：18800001111'],
        brandData,
      );
      expect(readProjectedValue(result?.interview_info.name)).toBe('赵堤');
    });
  });

  describe('badcase 6a13c26f: quoted message stripping', () => {
    const badcaseMessages = [
      '都不太合适耶',
      '[引用 李涵婷：成都你六姐-莘庄龙之梦店 前厅服务员，3.1km 班次：11:30-14:30（午高峰短班，约3小时） 薪资：24元/时，满40小时26元/时，满80小时28元/时 要求：20-35岁，入职前办食品健康证]\n我36岁',
      '[引用 李涵婷：奥乐齐-1082鑫都 晚班补货，3.2km 班次：22:00-07:00（夜班） 薪资：5500-6500元/月（约30元/时） 要求：18-40岁]\n我白天9:00到下午三点有时间，上不就夜班',
    ];

    it('should extract age=36 from candidate text, not 35 from quoted job requirement', () => {
      const result = extractTurnHints(badcaseMessages, brandData);
      expect(readProjectedValue(result?.interview_info.age)).toBe('36');
    });

    it('should NOT extract salary from quoted job descriptions', () => {
      const result = extractTurnHints(badcaseMessages, brandData);
      expect(result?.preferences.salary).toBeNull();
    });

    it('should NOT extract position keywords from quoted job descriptions', () => {
      const result = extractTurnHints(badcaseMessages, brandData);
      expect(result?.preferences.position).toBeNull();
    });

    it('should NOT extract shift schedule from quoted job descriptions', () => {
      const result = extractTurnHints(badcaseMessages, brandData);
      // "不就夜班" from candidate's own text — should not match the shift keywords
      // from the quoted content like "晚班" "11:30-14:30" "夜班"
      const schedule = readProjectedValue(result?.preferences.schedule);
      if (schedule) {
        expect(schedule).not.toContain('11:30-14:30');
        expect(schedule).not.toContain('22:00-07:00');
      }
    });
  });
});
