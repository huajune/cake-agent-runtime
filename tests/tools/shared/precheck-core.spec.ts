import {
  evaluateBookingNameGate,
  extractUserTexts,
  isNameAuthoritative,
} from '@tools/shared/precheck-core';

const userMsg = (content: unknown) => ({ role: 'user', content });
const asstMsg = (text: string) => ({ role: 'assistant', content: text });

describe('precheck-core', () => {
  describe('extractUserTexts', () => {
    it('collects user text from string and array-part content', () => {
      const messages = [
        asstMsg('你好'),
        userMsg('我叫王建国'),
        userMsg([
          { type: 'text', text: '电话13800000000' },
          { type: 'image', image: 'x' },
        ]),
      ];
      expect(extractUserTexts(messages)).toEqual(['我叫王建国', '电话13800000000 ']);
    });

    it('ignores non-user and malformed entries', () => {
      expect(extractUserTexts([asstMsg('hi'), null, 42, { role: 'user' }])).toEqual([]);
    });
  });

  describe('isNameAuthoritative', () => {
    it('returns true when name has a user_text source', () => {
      expect(isNameAuthoritative('王建国', [userMsg('姓名：王建国')])).toBe(true);
      expect(isNameAuthoritative('李雷', [userMsg('我叫李雷')])).toBe(true);
    });
    it('returns false when name only appears as an auto-greeting nickname', () => {
      expect(isNameAuthoritative('小晴早点睡', [userMsg('我是小晴早点睡')])).toBe(false);
    });
    it('returns false when name is absent from conversation', () => {
      expect(isNameAuthoritative('王建国', [userMsg('想看看附近岗位')])).toBe(false);
    });
  });

  describe('evaluateBookingNameGate (negative-evidence)', () => {
    it('allows a name with a structured user_text source', () => {
      expect(evaluateBookingNameGate('王建国', [userMsg('姓名：王建国')]).decision).toBe('allow');
    });

    it('allows a bare real name without structured source (no false reject)', () => {
      // 候选人裸答"张伟"——parser 不解析裸名，但无负向证据 → 放行（形态交给 checkRealName）
      expect(evaluateBookingNameGate('张伟', [userMsg('张伟')]).decision).toBe('allow');
    });

    it('rejects a format-valid name that only appears as an auto-greeting nickname', () => {
      // "小王" 形态合法（checkRealName 放行）但只是"我是小王"打招呼昵称 → HC-2 缺口
      const verdict = evaluateBookingNameGate('小王', [userMsg('我是小王')]);
      expect(verdict.decision).toBe('reject_collect');
      expect(verdict.reason).toContain('真实姓名');
    });

    it('does not double-reject format-invalid names (left to checkRealName)', () => {
      // 'Mike' 无负向证据 → 本闸门放行，交给 runBookingGuards.checkRealName 形态拦截
      expect(evaluateBookingNameGate('Mike', [userMsg('帮我约面试')]).decision).toBe('allow');
    });
  });
});
