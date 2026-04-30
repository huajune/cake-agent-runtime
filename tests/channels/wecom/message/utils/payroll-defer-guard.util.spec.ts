import { detectPayrollDeferToStore } from '@/channels/wecom/message/utils/payroll-defer-guard.util';

describe('detectPayrollDeferToStore', () => {
  it('flags 工资问题 + "到店再问"', () => {
    expect(
      detectPayrollDeferToStore('工资是发银行卡吗？这个具体到店再问下店长就行'),
    ).not.toBeNull();
  });

  it('flags 薪资问题 + "面试时问店长"', () => {
    expect(
      detectPayrollDeferToStore('薪资具体怎么发，可以面试的时候直接问店长确认。'),
    ).not.toBeNull();
  });

  it('flags 发薪问题 + "跟店长确认"', () => {
    expect(
      detectPayrollDeferToStore('工资几号到账你可以跟店长确认下。'),
    ).not.toBeNull();
  });

  it('does not flag 普通"到店面试"等合法表达', () => {
    expect(
      detectPayrollDeferToStore('面试地点在徐汇店，到店找店长签到就行。'),
    ).toBeNull();
    expect(
      detectPayrollDeferToStore('明天到店面试，记得带身份证。'),
    ).toBeNull();
  });

  it('does not flag 不含发薪话题的"店长确认"', () => {
    expect(
      detectPayrollDeferToStore('排班具体细节店长会跟你确认下。'),
    ).toBeNull();
  });

  it('does not flag 工资问题但 Agent 给了正面回答', () => {
    expect(
      detectPayrollDeferToStore('工资是按月发到本人银行卡，每月 15 号到账。'),
    ).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(detectPayrollDeferToStore('')).toBeNull();
  });
});
