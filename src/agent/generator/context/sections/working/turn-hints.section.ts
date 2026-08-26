// 知识归类：working —— 本段呈现从候选人当前消息提取的临时线索。
import { formatTurnHintLines } from '@memory/fact-lines.formatter';
import type { TurnHints, TurnHintFieldPath } from '@resolution/evidence/claim.types';
import { resolveTurnHints } from '@resolution/evidence/merge';
import { PromptContext, PromptSection } from '../section.interface';

/**
 * 本轮规则 claim 先由统一字段策略裁决，再按是否与会话记忆冲突拆成普通/待确认视图。
 * 本类只做展示分流，不再理解 first/last/union/composite，也不持有另一套事实包装。
 */
export class TurnHintsSection implements PromptSection {
  readonly name = 'turn-hints';

  build(ctx: PromptContext): string {
    if (ctx.displayTurnHints === undefined || ctx.pendingTurnHintFields === undefined) {
      throw new Error(
        'TurnHintsSection 缺少共享裁决视图：请先调用 adjudicatePromptMemory，并显式传入 displayTurnHints 与 pendingTurnHintFields。',
      );
    }
    const { normalHints, pendingHints } = this.partitionSharedView(
      ctx.displayTurnHints,
      new Set(ctx.pendingTurnHintFields),
    );
    const parts: string[] = [];
    const currentTurnTexts = ctx.currentTurnTexts;
    if (normalHints) parts.push(this.renderCurrentHints(normalHints, currentTurnTexts));
    if (pendingHints) parts.push(this.renderPendingConfirmation(pendingHints, currentTurnTexts));
    return parts.join('\n\n');
  }

  private renderCurrentHints(
    facts: TurnHints,
    currentTurnTexts: readonly string[] | undefined,
  ): string {
    const lines = formatTurnHintLines(facts, {
      includeEvidence: true,
      includeQuote: true,
      currentTurnTexts,
    });
    if (lines.length === 0) return '';
    return [
      '[本轮解析线索]',
      '',
      '**这些线索是什么**：由确定性解析器从当前消息**机械提取**，每条附解析依据；能定位到' +
        '具体片段、或本轮合并了多条消息时另附「原话」指明来源，没有「原话」即表示来自本轮消息' +
        '本身。常见形态（表单回填、明确自陈）下通常准确；但它认字不认语境，存在两类已知误判：' +
        '候选人复述岗位要求（"这岗位要求18-45岁"）、指代他人（"我姐今年24"）。',
      '**冲突时听谁的**：用前对照原话核验，以你的理解为准；与[用户档案]、[会话记忆]或候选人' +
        '当前明示信息冲突时，一律以候选人当前明示信息为准。',
      '**能拿它干什么**：要把其中任何一项当作候选人报名资料使用，必须经 duliday_interview_precheck 的 candidateClaims 提交并附候选人原话 quote——' +
        '这里的解析线索本身不构成资料依据，不要据此直接填表或向候选人断言"你是XX"。',
      '**别说漏嘴**：以上提示行是内部信息，严禁向候选人复述或提及“系统识别/系统提示/系统解析”字样。',
      '**地点与城市**：地点线索（行政区/商圈/地标/街道/详细地址）该不该先 geocode，口径见 [本轮查询硬约束]，' +
        '本段不另立规则。城市行的「证据」是机器码，含义：municipality_compact=直辖市紧凑写法、' +
        'explicit_city=显式城市名、unique_district_alias=全国唯一区名映射、hotspot_alias=热门地标映射；' +
        '四者均为确定性白名单命中，查岗可直接采用。与候选人本轮新表述冲突时，仍以候选人当前明示为准。',
      '',
      '## 当前消息解析结果',
      lines.join('\n'),
    ].join('\n');
  }

  private renderPendingConfirmation(
    facts: TurnHints,
    currentTurnTexts: readonly string[] | undefined,
  ): string {
    const lines = formatTurnHintLines(facts, {
      includeEvidence: true,
      includeQuote: true,
      currentTurnTexts,
    });
    if (lines.length === 0) return '';
    return [
      '[本轮待确认线索]',
      '',
      '以下内容由当前消息前置识别得到，但与[会话记忆]中的已知信息存在冲突。',
      '这些异值已标记为「待确认更新」，不是已完成的事实覆盖。',
      '这些内容只用于帮助你判断是否需要澄清，不得直接覆盖已确认的会话记忆。',
      '若候选人本轮表达明确，可按当前表达继续；若表达仍有歧义，先做一次简短确认。',
      '完成判断后仍须正常回答候选人当前问题，不得因存在冲突而留空或静默。',
      '',
      '## 当前消息待确认结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** preparation 已完成同值去重；渲染层只按共享视图的待确认标记分流。 */
  private partitionSharedView(
    turnHints: TurnHints | null,
    pendingFields: ReadonlySet<TurnHintFieldPath>,
  ): { normalHints: TurnHints | null; pendingHints: TurnHints | null } {
    if (!turnHints) return { normalHints: null, pendingHints: null };
    const normalFields = new Set<TurnHintFieldPath>();
    for (const fact of resolveTurnHints(turnHints)) {
      if (!pendingFields.has(fact.field)) normalFields.add(fact.field);
    }
    return {
      normalHints: this.selectClaims(turnHints, normalFields),
      pendingHints: this.selectClaims(turnHints, pendingFields),
    };
  }

  private selectClaims(facts: TurnHints, fields: ReadonlySet<TurnHintFieldPath>): TurnHints | null {
    const claims = facts.claims.filter((claim) => fields.has(claim.field));
    if (claims.length === 0) return null;
    const selected = { claims, reasoning: facts.reasoning };
    return formatTurnHintLines(selected).length > 0 ? selected : null;
  }
}
