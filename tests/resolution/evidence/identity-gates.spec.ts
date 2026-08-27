import {
  evaluateBookingNameGate,
  evaluateBookingPhoneGate,
  isAgentQuestionConfirmedInDialogue,
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

  describe('确认式 claim 的真实问答对绑定', () => {
    const question = '姓名是兮兮，手机号是18271421690，对吗？';

    it('真实 assistant 问句 + 紧邻候选人肯定短答才成立', () => {
      const messages = [message('assistant', question), message('user', '确认')];
      expect(isAgentQuestionConfirmedInDialogue(question, '确认', messages)).toBe(true);
    });

    it('模型自报的问句未出现在 assistant 历史时拒绝', () => {
      expect(isAgentQuestionConfirmedInDialogue(question, '确认', [message('user', '确认')])).toBe(
        false,
      );
    });

    it('只认问句后的第一条 user，应答被其他消息隔开时拒绝', () => {
      const messages = [
        message('assistant', question),
        message('user', '我先看看'),
        message('user', '确认'),
      ];
      expect(isAgentQuestionConfirmedInDialogue(question, '确认', messages)).toBe(false);
    });
  });
});
