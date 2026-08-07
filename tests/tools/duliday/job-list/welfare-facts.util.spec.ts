import {
  extractWelfareFacts,
  renderWelfareFactsBanner,
} from '@tools/duliday/job-list/welfare-facts.util';

describe('extractWelfareFacts', () => {
  it('returns unspecified for null/undefined/empty welfare', () => {
    expect(extractWelfareFacts(null).meals).toBe('unspecified');
    expect(extractWelfareFacts(undefined).accommodation).toBe('unspecified');
    expect(extractWelfareFacts({}).insurance).toBe('unspecified');
  });

  describe('meals classification', () => {
    it('classifies 包吃 as company', () => {
      expect(extractWelfareFacts({ catering: '包吃' }).meals).toBe('company');
      expect(extractWelfareFacts({ catering: '免费工作餐' }).meals).toBe('company');
      expect(extractWelfareFacts({ catering: '公司提供员工餐' }).meals).toBe('company');
    });

    it('classifies 不包吃/员工自理/无 as self_or_none', () => {
      expect(extractWelfareFacts({ catering: '不包吃' }).meals).toBe('self_or_none');
      expect(extractWelfareFacts({ catering: '员工自理' }).meals).toBe('self_or_none');
      expect(extractWelfareFacts({ catering: '无' }).meals).toBe('self_or_none');
    });

    it('promotes self_or_none to allowance when 餐补 numeric present', () => {
      expect(extractWelfareFacts({ catering: '不包吃', cateringSalary: 15 }).meals).toBe(
        'allowance',
      );
      expect(extractWelfareFacts({ catering: '员工自理', cateringSalary: '500元/月' }).meals).toBe(
        'allowance',
      );
    });

    it('classifies unrecognized text as unspecified', () => {
      expect(extractWelfareFacts({ catering: '面议' }).meals).toBe('unspecified');
    });

    it('classifies real sponge enum strings (无餐饮福利/餐饮补贴)', () => {
      // 海绵真实取值是完整描述串，旧逻辑会误判为 unspecified。
      expect(extractWelfareFacts({ catering: '无餐饮福利' }).meals).toBe('self_or_none');
      expect(extractWelfareFacts({ catering: '餐饮补贴' }).meals).toBe('allowance');
    });
  });

  describe('accommodation classification', () => {
    it('classifies 包住 as company, 不包住 as self_or_none', () => {
      expect(extractWelfareFacts({ accommodation: '包住' }).accommodation).toBe('company');
      expect(extractWelfareFacts({ accommodation: '不包住' }).accommodation).toBe('self_or_none');
    });

    it('promotes to allowance when accommodationAllowance numeric', () => {
      expect(
        extractWelfareFacts({
          accommodation: '员工自理',
          accommodationAllowance: 500,
        }).accommodation,
      ).toBe('allowance');
    });
  });

  describe('insurance classification', () => {
    it('classifies 公司购买 as company', () => {
      expect(extractWelfareFacts({ haveInsurance: '公司购买' }).insurance).toBe('company');
    });

    it('classifies 不购买/员工自理 as self_or_none (no allowance concept for insurance)', () => {
      expect(extractWelfareFacts({ haveInsurance: '不购买' }).insurance).toBe('self_or_none');
      expect(extractWelfareFacts({ haveInsurance: '员工自理' }).insurance).toBe('self_or_none');
    });

    it('classifies real sponge enum strings (独立日购买/独立日不购买)', () => {
      // "独立日/独立客" = 本公司，"独立日购买" 表示公司参保；旧逻辑误判为 unspecified。
      expect(extractWelfareFacts({ haveInsurance: '独立日购买' }).insurance).toBe('company');
      expect(extractWelfareFacts({ haveInsurance: '独立日不购买' }).insurance).toBe('self_or_none');
    });
  });

  describe('traffic / promotion / other welfare', () => {
    it('flags hasTrafficAllowance only when trafficAllowanceSalary numeric', () => {
      expect(extractWelfareFacts({ trafficAllowanceSalary: 200 }).hasTrafficAllowance).toBe(true);
      expect(extractWelfareFacts({ trafficAllowanceSalary: '300元/月' }).hasTrafficAllowance).toBe(
        true,
      );
      expect(extractWelfareFacts({ trafficAllowanceSalary: '' }).hasTrafficAllowance).toBe(false);
      expect(extractWelfareFacts({}).hasTrafficAllowance).toBe(false);
    });

    it('flags hasPromotionWelfare on non-empty string', () => {
      expect(extractWelfareFacts({ promotionWelfare: '半年晋升一次' }).hasPromotionWelfare).toBe(
        true,
      );
      expect(extractWelfareFacts({ promotionWelfare: '' }).hasPromotionWelfare).toBe(false);
    });

    it('extracts otherWelfareItems from string array', () => {
      expect(
        extractWelfareFacts({ otherWelfare: ['节日福利', '年终奖', '', null] }).otherWelfareItems,
      ).toEqual(['节日福利', '年终奖']);
    });
  });
});

describe('renderWelfareFactsBanner', () => {
  it('returns empty when all fields unspecified and arrays empty', () => {
    expect(renderWelfareFactsBanner(extractWelfareFacts({}))).toBe('');
    expect(renderWelfareFactsBanner(extractWelfareFacts(null))).toBe('');
  });

  it('renders all 4 main slots even when only one has signal', () => {
    const banner = renderWelfareFactsBanner(extractWelfareFacts({ catering: '包吃' }));
    expect(banner).toContain('福利字段速览');
    expect(banner).toContain('员工餐：✅ 公司提供');
    // welfare 块已加载（有 catering 键）而住宿未配置 → 按运营口径判 ❌ 无，不再是 ❓ 未明确。
    // 2026-08-06 运营：「吃和住都在岗位福利中，如果没有填就默认没有」。
    expect(banner).toContain('住宿：❌ 无');
    // 保险不吃该默认：敏感字段未配置时不得替公司断言"无保险"。
    expect(banner).toContain('保险（敏感，仅候选人主动问时可答）：未明确');
    expect(banner).toContain('保险/社保严禁主动提及');
    expect(banner).toContain('交通补贴：❓ 未明确');
    expect(banner).not.toContain('禁止在 reply 里声称');
  });

  // 2026-08-06 运营口径：「吃和住都在岗位福利中，如果没有填就默认没有」。
  // 但"没填"必须区分两种形态，否则会把"没加载"误答成"没有福利"。
  describe('吃/住未配置默认按无（运营口径）', () => {
    it('welfare 已加载但吃/住字段缺失时判 self_or_none', () => {
      // 只有 memo 的岗位：welfare 确实被加载过，吃住没配 → 默认没有
      const facts = extractWelfareFacts({ memo: '门店统一安排' });
      expect(facts.meals).toBe('self_or_none');
      expect(facts.accommodation).toBe('self_or_none');
    });

    it('吃/住为 null 或空串时同样判 self_or_none', () => {
      const facts = extractWelfareFacts({ catering: null, accommodation: '   ', memo: 'x' });
      expect(facts.meals).toBe('self_or_none');
      expect(facts.accommodation).toBe('self_or_none');
    });

    it('空对象 {} 不适用该默认，仍是 unspecified（无信息 ≠ 没有福利）', () => {
      // 现网 includeWelfare=false 时海绵回的是 welfare=null；{} 属"加载了但啥都没有"
      // 的退化形态，此时替门店断言"不包吃住"是编造，必须保持未明确。
      const facts = extractWelfareFacts({});
      expect(facts.meals).toBe('unspecified');
      expect(facts.accommodation).toBe('unspecified');
    });

    it('welfare=null（未请求 includeWelfare）不适用该默认', () => {
      expect(extractWelfareFacts(null).meals).toBe('unspecified');
      expect(extractWelfareFacts(null).accommodation).toBe('unspecified');
    });

    it('缺失但有餐补/房补时仍升格为 allowance，不被默认覆盖', () => {
      const facts = extractWelfareFacts({ cateringSalary: 15, accommodationAllowance: 800 });
      expect(facts.meals).toBe('allowance');
      expect(facts.accommodation).toBe('allowance');
    });

    it('保险不吃该默认：welfare 已加载但未配保险时仍是 unspecified', () => {
      expect(extractWelfareFacts({ memo: 'x' }).insurance).toBe('unspecified');
    });
  });

  it('banner 声明自己是吃住的最终事实，禁止据此转人工', () => {
    const banner = renderWelfareFactsBanner(extractWelfareFacts({ catering: '无餐饮福利' }));
    expect(banner).toContain('最终事实');
    expect(banner).toContain('request_handoff');
  });

  it('renders 员工自理 case as ❌ 无, not as 有', () => {
    const banner = renderWelfareFactsBanner(
      extractWelfareFacts({
        catering: '员工自理',
        accommodation: '员工自理',
        haveInsurance: '不购买',
      }),
    );
    expect(banner).toContain('员工餐：❌ 无');
    expect(banner).toContain('住宿：❌ 无');
    expect(banner).toContain('保险（敏感，仅候选人主动问时可答）：内部事实：无');
    expect(banner).toContain('不得包装成"有"');
  });

  it('marks company insurance as sensitive internal fact instead of active welfare', () => {
    const banner = renderWelfareFactsBanner(
      extractWelfareFacts({
        haveInsurance: '公司购买',
      }),
    );
    expect(banner).toContain(
      '保险（敏感，仅候选人主动问时可答）：内部事实：公司购买（敏感，禁止主动提及）',
    );
    expect(banner).toContain('保险/社保严禁主动提及');
  });

  it('renders 仅补贴 path correctly', () => {
    const banner = renderWelfareFactsBanner(
      extractWelfareFacts({
        catering: '员工自理',
        cateringSalary: 15,
      }),
    );
    expect(banner).toContain('员工餐：💵 仅给补贴');
  });

  it('shows otherWelfareItems and promotion welfare when present', () => {
    const banner = renderWelfareFactsBanner(
      extractWelfareFacts({
        catering: '包吃',
        promotionWelfare: '半年评级晋升',
        otherWelfare: ['年终奖', '节日礼品'],
      }),
    );
    expect(banner).toContain('晋升福利：✅ 有说明');
    expect(banner).toContain('其它福利：年终奖、节日礼品');
  });

  it('always includes free-text precedence rule', () => {
    const banner = renderWelfareFactsBanner(extractWelfareFacts({ catering: '员工自理' }));
    expect(banner).not.toContain('禁止在 reply 里声称');
    expect(banner).not.toContain('禁止在 reply 里声称');
  });
});
