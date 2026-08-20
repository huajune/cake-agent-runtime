import {
  evaluateBookingNameGate,
  evaluateBookingPhoneGate,
  isNameAuthoritative,
  isNameOnlyQuotedSpeaker,
  isPhoneAuthoritative,
} from '@resolution/evidence/identity-gates';

const message = (role: 'user' | 'assistant', content: string) => ({ role, content });

describe('identity-gates（直接出处，不含 legacy 确认识别）', () => {
  it('结构化候选人原话可确权姓名和手机号', () => {
    const messages = [message('user', '姓名：兮兮，电话：18271421690')];
    expect(isNameAuthoritative('兮兮', messages)).toBe(true);
    expect(isPhoneAuthoritative('18271421690', messages)).toBe(true);
    expect(evaluateBookingNameGate('兮兮', messages)).toEqual({ decision: 'allow' });
    expect(evaluateBookingPhoneGate('18271421690', messages)).toEqual({ decision: 'allow' });
  });

  it('引用前缀里的经理名不能成为候选人姓名', () => {
    const messages = [message('user', '[引用 兮兮：这个岗位可以吗] 可以')];
    expect(isNameOnlyQuotedSpeaker('兮兮', messages)).toBe(true);
    expect(evaluateBookingNameGate('兮兮', messages).decision).toBe('reject_collect');
  });

  it('自动打招呼昵称被拒绝', () => {
    const messages = [message('user', '我是兮兮')];
    expect(evaluateBookingNameGate('兮兮', messages).decision).toBe('reject_collect');
  });

  it('候选人原文不存在的手机号被拒绝', () => {
    expect(
      evaluateBookingPhoneGate('18271421690', [message('user', '我还没发手机号')]).decision,
    ).toBe('reject_collect');
  });

  it('跨轮“对/确认”不再由本闸门正则解锁', () => {
    const messages = [message('assistant', '手机号是18271421690，对吗？'), message('user', '对')];
    expect(evaluateBookingPhoneGate('18271421690', messages).decision).toBe('reject_collect');
  });
});
