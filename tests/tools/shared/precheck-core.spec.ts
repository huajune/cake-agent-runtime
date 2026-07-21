import {
  evaluateBookingNameGate,
  extractQuotedSpeakers,
  extractUserTexts,
  isNameAuthoritative,
  isNameOnlyQuotedSpeaker,
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
    it('ignores 姓名：X inside a quoted block (bot 发的表单被候选人引用)', () => {
      // 候选人引用 bot 发的收资表单追问——表单里的"姓名：高雅琪"是被引用内容，不是候选人说的
      expect(
        isNameAuthoritative('高雅琪', [userMsg('[引用 琪琪：姓名：高雅琪 联系方式：] 怎么填')]),
      ).toBe(false);
    });
  });

  describe('extractQuotedSpeakers / isNameOnlyQuotedSpeaker', () => {
    // 生产 badcase（2026-07-17 / 07-20 三例）：候选人引用招募经理发的岗位卡，
    // 经理中文显示名随 [引用 XXX：...] 进入对话，被模型误当候选人姓名预填进报名表。
    const quoted = userMsg(
      '[引用 高雅琪：M Stand（白云五号店，距你6km）：早班 07:30-10:30，26元/小时] 这',
    );

    it('extracts quoted speakers from user messages', () => {
      expect(extractQuotedSpeakers([quoted, asstMsg('好的')])).toEqual(['高雅琪']);
    });

    it('flags a name that only appears as a quoted speaker', () => {
      expect(isNameOnlyQuotedSpeaker('高雅琪', [quoted])).toBe(true);
    });

    it('flags a name embedded in a composite 昵称(真名) speaker display name', () => {
      const msg = userMsg(
        '[引用 琪琪(高雅琪)：奥乐齐这个晚班补货岗你要考虑的话，我可以帮你登记] 可以',
      );
      expect(isNameOnlyQuotedSpeaker('高雅琪', [msg])).toBe(true);
    });

    it('does not flag when the candidate typed the name in their own words', () => {
      expect(
        isNameOnlyQuotedSpeaker('高雅琪', [quoted, userMsg('姓名：高雅琪，电话13800000000')]),
      ).toBe(false);
    });

    it('does not flag a name that never appears as a quoted speaker', () => {
      expect(isNameOnlyQuotedSpeaker('王建国', [quoted])).toBe(false);
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

    it('rejects a manager name that only appears in a quote prefix (生产 badcase 姓名预填高雅琪)', () => {
      const verdict = evaluateBookingNameGate('高雅琪', [
        userMsg('[引用 高雅琪：M Stand（白云五号店，距你6km）：早班 07:30-10:30] 这'),
      ]);
      expect(verdict.decision).toBe('reject_collect');
      expect(verdict.reason).toContain('引用');
    });

    it('does not double-reject format-invalid names (left to checkRealName)', () => {
      // 'Mike' 无负向证据 → 本闸门放行，交给 runBookingGuards.checkRealName 形态拦截
      expect(evaluateBookingNameGate('Mike', [userMsg('帮我约面试')]).decision).toBe('allow');
    });
  });
});
