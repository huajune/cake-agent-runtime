import { IdentitySection } from '@agent/generator/context/sections/identity.section';
import { PromptContext } from '@agent/generator/context/sections/section.interface';

describe('IdentitySection', () => {
  const buildCtx = (overrides: Partial<PromptContext> = {}): PromptContext => ({
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {
      role_setting: { content: '你是招募经理，主要为大型公司招人。' },
      persona: { textDimensions: [] },
    } as unknown as PromptContext['strategyConfig'],
    ...overrides,
  });

  it('renders role setting as # 角色', () => {
    const text = new IdentitySection().build(buildCtx());
    expect(text).toContain('# 角色');
    expect(text).toContain('你是招募经理，主要为大型公司招人。');
  });

  describe('账号身份锚定 (badcase chat 6a5dedb2ce406a6aeee1ea62)', () => {
    it('renders configured nickname and gender as the agent own identity', () => {
      const text = new IdentitySection().build(
        buildCtx({
          accountIdentity: { botUserId: 'ZhuDongSheng', nickname: '东升', gender: '男' },
        }),
      );
      expect(text).toContain('# 账号身份');
      expect(text).toContain('你的名字（企微昵称）：「东升」');
      expect(text).toContain('你的性别：男');
      expect(text).toContain('本账号的内部标识是「ZhuDongSheng」');
      // 有真名时不应再出现"未提供昵称"的保守分支
      expect(text).not.toContain('当前未提供具体昵称');
    });

    it('falls back to no-fabrication rules when nickname/gender are not configured', () => {
      const text = new IdentitySection().build(buildCtx({ accountIdentity: {} }));
      expect(text).toContain('# 账号身份');
      expect(text).toContain('候选人看到的这个企微账号就是你本人');
      expect(text).toContain('当前未提供具体昵称');
      expect(text).toContain('既不承认也不否认这个具体名字');
      expect(text).toContain('严禁编造与上述不符的姓名、性别');
      expect(text).not.toContain('你的性别：');
      expect(text).not.toContain('内部标识');
    });

    it('always injects the anchor even without accountIdentity at all', () => {
      const text = new IdentitySection().build(buildCtx());
      expect(text).toContain('# 账号身份');
      expect(text).toContain('永远不说**"转人工""人工客服"');
    });

    it('ignores blank identity fields', () => {
      const text = new IdentitySection().build(
        buildCtx({ accountIdentity: { botUserId: '  ', nickname: ' ', gender: '' } }),
      );
      expect(text).toContain('当前未提供具体昵称');
      expect(text).not.toContain('内部标识');
      expect(text).not.toContain('你的性别：');
    });

    it('anchor comes after role text and before persona text', () => {
      const ctx = buildCtx();
      (ctx.strategyConfig as unknown as { persona: unknown }).persona = {
        textDimensions: [{ group: 'style', label: '聊天习惯', value: '短句直出' }],
      };
      const text = new IdentitySection().build(ctx);
      const rolePos = text.indexOf('# 角色');
      const anchorPos = text.indexOf('# 账号身份');
      const personaPos = text.indexOf('# 人格设定');
      expect(rolePos).toBeGreaterThanOrEqual(0);
      expect(anchorPos).toBeGreaterThan(rolePos);
      expect(personaPos).toBeGreaterThan(anchorPos);
    });
  });
});
