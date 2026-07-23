import {
  countRealNameAsks,
  evaluateBookingNameGate,
  evaluateBookingPhoneGate,
  extractQuotedSpeakers,
  extractUserTexts,
  isNameAuthoritative,
  isNameConfirmedInDialogue,
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

  describe('isNameConfirmedInDialogue / 姓名闸门解锁路径（badcase g4ytra23 死锁修复）', () => {
    // 陈佩珊案：打招呼语昵称=真名，isFromAutoGreeting 存在性判断导致后续任何确认都解不开
    const greeting = userMsg('我是陈佩珊');

    it('unlocks via 直陈确认 "就是X"', () => {
      const messages = [greeting, asstMsg('麻烦发一下身份证上的真实姓名'), userMsg('就是陈佩珊')];
      expect(isNameConfirmedInDialogue('陈佩珊', messages)).toBe(true);
      expect(evaluateBookingNameGate('陈佩珊', messages).decision).toBe('allow');
    });

    it('unlocks via 确认问答对（assistant 问"全名对吧" + user 答"是的"）', () => {
      const messages = [
        greeting,
        asstMsg('门店登记需要用身份证上的本名，"陈佩珊"是你的全名对吧？确认下我这边就直接帮你登记了'),
        userMsg('是的'),
      ];
      expect(isNameConfirmedInDialogue('陈佩珊', messages)).toBe(true);
      expect(evaluateBookingNameGate('陈佩珊', messages).decision).toBe('allow');
    });

    it('unlocks via 确认问答对（肯定答复带时间后缀——7-15 时间后缀击穿教训回归）', () => {
      const messages = [
        greeting,
        asstMsg('"陈佩珊"是你的全名对吧？'),
        userMsg('是的\n[消息发送时间：2026-07-22 17:11 星期三]'),
      ];
      expect(isNameConfirmedInDialogue('陈佩珊', messages)).toBe(true);
    });

    it('unlocks via 身份证图片 OCR 描述（无冒号分隔形态）', () => {
      const messages = [greeting, userMsg('[图片消息] 身份证图片：姓名陈佩珊，性别女，民族汉')];
      expect(isNameConfirmedInDialogue('陈佩珊', messages)).toBe(true);
      expect(evaluateBookingNameGate('陈佩珊', messages).decision).toBe('allow');
    });

    it('does NOT unlock when the affirmative answers an unrelated question', () => {
      const messages = [
        greeting,
        asstMsg('这个岗位是早班，你时间能排开吗'),
        userMsg('是的'),
      ];
      expect(isNameConfirmedInDialogue('陈佩珊', messages)).toBe(false);
      expect(evaluateBookingNameGate('陈佩珊', messages).decision).toBe('reject_collect');
    });

    it('does NOT unlock when the next user message is not affirmative', () => {
      const messages = [greeting, asstMsg('"陈佩珊"是你的全名对吧？'), userMsg('到时候联系谁呢')];
      expect(isNameConfirmedInDialogue('陈佩珊', messages)).toBe(false);
    });
  });

  describe('countRealNameAsks', () => {
    it('counts assistant real-name asks (同题限问依据)', () => {
      const messages = [
        asstMsg('麻烦发一下身份证上的真实姓名，我帮你登记上'),
        userMsg('发了呀'),
        asstMsg('门店登记需要用身份证上的本名哈，麻烦发一下身份证上的真实姓名'),
        asstMsg('到时候面试前会提前跟你联系确认'),
      ];
      expect(countRealNameAsks(messages)).toBe(2);
    });
  });

  describe('evaluateBookingPhoneGate（badcase 6e9ar9gd 簇：编造手机号提交预约）', () => {
    it('allows a phone that appears verbatim in user text', () => {
      expect(
        evaluateBookingPhoneGate('15921708092', [userMsg('手机号15921708092')]).decision,
      ).toBe('allow');
    });

    it('allows a phone written with separators (155 2189 9062)', () => {
      expect(
        evaluateBookingPhoneGate('15521899062', [userMsg('电话 155 2189 9062')]).decision,
      ).toBe('allow');
    });

    it('rejects a phone with no user-text provenance (示例回声/沿用洗白的编造号)', () => {
      const verdict = evaluateBookingPhoneGate('15921708092', [
        userMsg('我是陈佩珊'),
        userMsg('周四下午'),
      ]);
      expect(verdict.decision).toBe('reject_collect');
      expect(verdict.reason).toContain('手机号');
    });

    it('ignores phone digits inside quoted blocks (bot 表单被引用不算候选人出处)', () => {
      const verdict = evaluateBookingPhoneGate('13800000000', [
        userMsg('[引用 招募经理：联系电话：13800000000] 怎么填'),
      ]);
      expect(verdict.decision).toBe('reject_collect');
    });

    it('passes through empty phone (交给必填校验)', () => {
      expect(evaluateBookingPhoneGate('', [userMsg('你好')]).decision).toBe('allow');
    });
  });
});
