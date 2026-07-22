import { PromptSection, PromptContext, AccountIdentity } from './section.interface';
import { StrategyPersona, StrategyRoleSetting } from '@shared-types/strategy-config.types';

/**
 * 身份段落 — 角色设定 + 账号身份 + 人格设定
 *
 * roleSetting 定义 Agent 的角色身份（注入为 # 角色 段落），
 * accountIdentity 把角色锚定到当前托管的企微账号本人（防人格分裂），
 * persona 的 textDimensions（style 组）构成沟通风格，
 * 不再把整份工作手册混进 identity，避免“身份设定”和“操作说明”边界不清。
 */
export class IdentitySection implements PromptSection {
  readonly name = 'identity';

  build(ctx: PromptContext): string {
    const roleText = this.buildRoleText(ctx.strategyConfig.role_setting);
    const accountIdentityText = this.buildAccountIdentityText(ctx.accountIdentity);
    const personaText = this.buildPersonaText(ctx.strategyConfig.persona);
    const parts: string[] = [];
    if (roleText) parts.push(roleText);
    if (accountIdentityText) parts.push(accountIdentityText);
    if (personaText) parts.push(personaText);
    return parts.join('\n\n');
  }

  /**
   * 账号身份锚定：你就是候选人看到的这个企微账号本人。
   *
   * 背景（badcase chat 6a5dedb2ce406a6aeee1ea62）：人设只有"你是招募经理"时，
   * 模型被候选人追问姓名/性别会现编（自称"李娜"+"我是女生"），并把账号主人
   * "东升"说成"另一个真人招募经理"——把自己和托管账号割裂成两个人。
   *
   * 昵称/性别来自 hosting_member_config（按 botImId 配置）：配置了就明示给模型
   * "你叫什么、你是男是女"；未配置时降级为"不认不否认、不编造"的保守口径。
   * 此段无论有无账号信息都注入（debug-chat/测试流同样受行为规则约束）。
   */
  private buildAccountIdentityText(identity: AccountIdentity | undefined): string {
    const nickname = identity?.nickname?.trim();
    const gender = identity?.gender?.trim();
    const botUserId = identity?.botUserId?.trim();

    const lines = [
      '# 账号身份',
      '',
      '你正以一个真实的企业微信账号和候选人一对一聊天——**候选人看到的这个企微账号就是你本人**，不存在"账号背后另有真人/人工"的说法。',
      '',
    ];

    if (nickname) {
      lines.push(
        `- **你的名字（企微昵称）：「${nickname}」**。候选人在聊天界面看到的就是这个名字；被问"你叫什么""你是不是${nickname}"时，按这个名字大方承认。`,
      );
    } else {
      lines.push(
        '- 你的名字就是候选人看到的账号昵称，但当前未提供具体昵称。候选人用某个名字称呼你时，**既不承认也不否认这个具体名字**，轻带过并拉回正事（如"叫我招聘经理就行哈"）；**严禁**顺着候选人口中的名字自认——候选人可能在试探或说笑（如让你"想一个名字"）。',
      );
    }

    if (gender) {
      lines.push(`- **你的性别：${gender}**。被问到时按此回答，不得说反。`);
    }

    if (botUserId) {
      lines.push(
        `- 本账号的内部标识是「${botUserId}」（可能是拼音/英文形式）；候选人提到与其对应的中文称呼时，指的也是你。`,
      );
    }

    lines.push(
      '- **严禁编造与上述不符的姓名、性别，也严禁编造年龄等未提供的个人信息**。被问到而上文没给的信息，不否认、不编造，轻带过并拉回正事（如"咱先把岗位的事定了哈"）；**严禁**把账号名说成"另一个人""真人经理""我同事"。',
      '- 报名登记、约面提交、拉群都是你本人在操作；确需他人协助时口径是"我让同事帮你确认下"，**永远不说**"转人工""人工客服""会有真人/专人联系你"。',
    );
    return lines.join('\n');
  }

  private buildRoleText(roleSetting: StrategyRoleSetting | undefined): string {
    if (!roleSetting?.content?.trim()) return '';
    return `# 角色\n\n${roleSetting.content.trim()}`;
  }

  private buildPersonaText(persona: StrategyPersona): string {
    const dims = (persona.textDimensions || []).filter((d) => d.group === 'style' && d.value);
    if (dims.length === 0) return '';

    const sections: string[] = ['# 人格设定'];
    for (const dim of dims) {
      sections.push(`## ${dim.label}\n${dim.value}`);
    }
    return sections.join('\n\n');
  }
}
