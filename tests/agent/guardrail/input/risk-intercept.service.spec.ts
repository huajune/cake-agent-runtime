import {
  RiskInterceptService,
  type RiskInterceptInput,
} from '@agent/guardrail/input/risk-intercept.service';

describe('RiskInterceptService', () => {
  let service: RiskInterceptService;

  const baseInput = (over: Partial<RiskInterceptInput> = {}): RiskInterceptInput => ({
    corpId: 'org-1',
    chatId: 'chat-1',
    userId: 'ct-1',
    pauseTargetId: 'chat-1',
    scanContent: '滚',
    messageId: 'msg-1',
    contactName: 'Alice',
    botImId: 'wxid-bot',
    botUserName: 'mgr-bob',
    ...over,
  });

  beforeEach(() => {
    service = new RiskInterceptService();
  });

  it('returns hit:false early when scanContent is empty (channel filtered it)', async () => {
    await expect(service.precheck(baseInput({ scanContent: '   ' }))).resolves.toEqual({
      hit: false,
    });
  });

  it('returns hit:false early when chatId is missing', async () => {
    await expect(service.precheck(baseInput({ chatId: '' }))).resolves.toEqual({
      hit: false,
    });
  });

  it('returns hit:false when current input has no high-confidence risk keyword', async () => {
    await expect(service.precheck(baseInput({ scanContent: '你好' }))).resolves.toEqual({
      hit: false,
    });
  });

  it.each(['滚', '滚开，别烦我', '滚犊子，这么多信息，太麻烦了', '你给我滚出去'])(
    'detects abusive "滚" context: %s',
    async (scanContent) => {
      await expect(service.precheck(baseInput({ scanContent }))).resolves.toEqual({
        hit: true,
        riskType: 'abuse',
        reason: expect.stringContaining('滚'),
        label: '辱骂/攻击',
      });
    },
  );

  it('returns conversation_risk sideEffect intent when high-confidence input risk hits', async () => {
    await expect(
      service.evaluate(baseInput({ scanContent: '你们这帮人真是垃圾' })),
    ).resolves.toEqual(
      expect.objectContaining({
        hit: true,
        riskType: 'abuse',
        reason: expect.stringContaining('垃圾'),
        label: '辱骂/攻击',
        sideEffect: expect.objectContaining({
          kind: 'conversation_risk',
          source: 'regex_intercept',
          riskType: 'abuse',
          riskLabel: '辱骂/攻击',
          currentMessageContent: '你们这帮人真是垃圾',
        }),
      }),
    );
  });

  it('does not execute side effects from precheck compatibility method', async () => {
    await expect(
      service.precheck(baseInput({ scanContent: '你们这帮人真是垃圾' })),
    ).resolves.toEqual({
      hit: true,
      riskType: 'abuse',
      reason: expect.stringContaining('垃圾'),
      label: '辱骂/攻击',
    });
  });

  it('detects complaint risk keywords', async () => {
    await expect(
      service.precheck(baseInput({ scanContent: '你们是不是骗子，我要投诉' })),
    ).resolves.toEqual({
      hit: true,
      riskType: 'complaint_risk',
      reason: expect.stringContaining('投诉'),
      label: '投诉/举报风险',
    });
  });

  it.each(['坑', '太坑了', '你们这是坑人吧', '我被你们坑惨了', '就是坑钱的'])(
    'detects scam-sense "坑" as complaint risk: %s',
    async (scanContent) => {
      await expect(service.precheck(baseInput({ scanContent }))).resolves.toEqual({
        hit: true,
        riskType: 'complaint_risk',
        reason: expect.stringContaining('坑'),
        label: '投诉/举报风险',
      });
    },
  );

  it.each([
    '你好',
    '坪山坑梓这边',
    '我在坑梓附近，沙坑村那边也行',
    '前面有个大坑，路不太好走',
    '这个游戏我早就入坑了',
  ])('does NOT flag benign "坑" (place names / neutral words): %s', async (scanContent) => {
    await expect(service.precheck(baseInput({ scanContent }))).resolves.toEqual({
      hit: false,
    });
  });

  it('does NOT flag "家里有病人 / 我爸有病" as abuse', async () => {
    await expect(
      service.precheck(
        baseInput({ scanContent: '其他都好说，太晚超过十点半我就真没办法，家里有病人。' }),
      ),
    ).resolves.toEqual({ hit: false });

    await expect(
      service.precheck(
        baseInput({
          scanContent: '我爸去年底得了癌症需要化疗，我爸病了后我就以早班、下午班为准。',
        }),
      ),
    ).resolves.toEqual({ hit: false });
  });

  it('does NOT flag ordinary rolling words as abuse', async () => {
    await expect(
      service.precheck(baseInput({ scanContent: '麻烦把页面滚动一下，我看不到下面' })),
    ).resolves.toEqual({ hit: false });
  });

  it('detects interview result inquiry as a high-confidence input risk', async () => {
    await expect(
      service.precheck(baseInput({ scanContent: '上次面试结果怎么样' })),
    ).resolves.toEqual({
      hit: true,
      riskType: 'interview_result_inquiry',
      reason: expect.stringContaining('上次面试结果'),
      label: '历史面试结果追问',
    });
  });

  describe('human_handoff_request（badcase 6a5df7e7：礼貌要人工无响应，骂人才触发拦截）', () => {
    it.each(['转人工', '转人工[强]', '麻烦转人工谢谢', '可以转接人工吗'])(
      'detects explicit 转人工 request anywhere: %s',
      async (scanContent) => {
        await expect(service.precheck(baseInput({ scanContent }))).resolves.toEqual({
          hit: true,
          riskType: 'human_handoff_request',
          reason: expect.stringContaining('转人工'),
          label: '候选人主动要求人工',
        });
      },
    );

    it.each(['找人工', '人工客服', '要人工！', '叫人工来[微笑]'])(
      'detects short-message human request: %s',
      async (scanContent) => {
        await expect(service.precheck(baseInput({ scanContent }))).resolves.toMatchObject({
          hit: true,
          riskType: 'human_handoff_request',
        });
      },
    );

    it('does NOT hit when 人工客服 appears inside a long job inquiry (防误伤)', async () => {
      await expect(
        service.precheck(baseInput({ scanContent: '你们那个人工客服的岗位还在招人吗，待遇怎么样' })),
      ).resolves.toEqual({ hit: false });
    });

    it('does NOT hit on unrelated 人工 mentions in long text', async () => {
      await expect(
        service.precheck(baseInput({ scanContent: '我之前在厂里做人工质检，想换个餐饮工作' })),
      ).resolves.toEqual({ hit: false });
    });

    it('abuse takes precedence when both appear (拦截理由更贴近现场)', async () => {
      await expect(
        service.precheck(baseInput({ scanContent: '转人工，你们是骗子吗，滚' })),
      ).resolves.toMatchObject({ hit: true, riskType: 'abuse' });
    });
  });
});
