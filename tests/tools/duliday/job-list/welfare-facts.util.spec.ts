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
      expect(
        extractWelfareFacts({ catering: '不包吃', cateringSalary: 15 }).meals,
      ).toBe('allowance');
      expect(
        extractWelfareFacts({ catering: '员工自理', cateringSalary: '500元/月' }).meals,
      ).toBe('allowance');
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
      expect(
        extractWelfareFacts({ promotionWelfare: '半年晋升一次' }).hasPromotionWelfare,
      ).toBe(true);
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
    const banner = renderWelfareFactsBanner(
      extractWelfareFacts({ catering: '包吃' }),
    );
    expect(banner).toContain('福利字段速览');
    expect(banner).toContain('员工餐：✅ 公司提供');
    expect(banner).toContain('住宿：❓ 未明确');
    expect(banner).toContain('保险：❓ 未明确');
    expect(banner).toContain('交通补贴：❓ 未明确');
    expect(banner).not.toContain('禁止在 reply 里声称');
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
    expect(banner).toContain('保险：❌ 无');
    expect(banner).toContain('不得包装成"有"');
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
    const banner = renderWelfareFactsBanner(
      extractWelfareFacts({ catering: '员工自理' }),
    );
    expect(banner).not.toContain('禁止在 reply 里声称');
    expect(banner).not.toContain('禁止在 reply 里声称');
  });
});
