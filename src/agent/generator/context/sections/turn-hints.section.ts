import { formatRuleFactClaimLines } from '@memory/formatters/fact-lines.formatter';
import {
  type CityFact,
  type EntityExtractionResult,
  type SessionFacts,
  unwrapSessionFacts,
} from '@memory/types/session-facts.types';
import type { RuleFactClaims, RuleFactFieldPath } from '@resolution/evidence/claim.types';
import {
  isSameFactValue,
  projectRuleFactClaims,
  resolveRuleFactClaims,
} from '@resolution/evidence/merge';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 本轮规则 claim 先由统一字段策略裁决，再按是否与会话记忆冲突拆成普通/待确认视图。
 * 本类只做展示分流，不再理解 first/last/union/composite，也不持有另一套事实包装。
 */
export class TurnHintsSection implements PromptSection {
  readonly name = 'turn-hints';

  build(ctx: PromptContext): string {
    const { normalHints, pendingHints } = this.partition(
      ctx.sessionFacts ?? null,
      ctx.ruleFacts ?? null,
    );
    const parts: string[] = [];
    if (normalHints) parts.push(this.renderCurrentHints(normalHints));
    if (pendingHints) parts.push(this.renderPendingConfirmation(pendingHints));
    return parts.join('\n\n');
  }

  private renderCurrentHints(facts: RuleFactClaims): string {
    const lines = formatRuleFactClaimLines(facts);
    if (lines.length === 0) return '';
    return [
      '[本轮高置信线索]',
      '',
      '以下内容由当前消息前置识别得到，仅用于理解本轮意图，不视为跨轮已确认的会话记忆。',
      '若与[用户档案]、[会话记忆]或候选人当前明示信息冲突，以候选人当前明示信息为准。',
      '以上提示行是内部信息，严禁向候选人复述或提及“系统识别/系统提示”字样。',
      '若识别出地点线索，行政区域可直接查岗；但商圈、地标、街道、详细地址这类自由位置线索不能直接当区域。只要本轮准备做具体岗位或门店推荐，就应优先先 geocode 获取经纬度，"附近/离我近"只是最明显场景。',
      '城市字段带有 confidence 与 evidence：confidence=high 的结果来自明确规则匹配（如直辖市紧凑、显式城市、唯一区名映射、热门地标映射），可直接采用；若与候选人本轮新表述冲突，优先相信候选人当前明示信息。',
      '',
      '## 当前消息识别结果',
      lines.join('\n'),
    ].join('\n');
  }

  private renderPendingConfirmation(facts: RuleFactClaims): string {
    const lines = formatRuleFactClaimLines(facts);
    if (lines.length === 0) return '';
    return [
      '[本轮待确认线索]',
      '',
      '以下内容由当前消息前置识别得到，但与[会话记忆]中的已知信息存在冲突。',
      '这些内容只用于帮助你判断是否需要澄清，不得直接覆盖已确认的会话记忆。',
      '若候选人本轮表达明确，可按当前表达继续；若表达仍有歧义，先做一次简短确认。',
      '',
      '## 当前消息待确认结果',
      lines.join('\n'),
    ].join('\n');
  }

  private partition(
    sessionFacts: EntityExtractionResult | SessionFacts | null,
    ruleFacts: RuleFactClaims | null,
  ): {
    normalHints: RuleFactClaims | null;
    pendingHints: RuleFactClaims | null;
  } {
    const projected = projectRuleFactClaims(ruleFacts);
    if (!projected) return { normalHints: null, pendingHints: null };

    const comparable = unwrapSessionFacts(sessionFacts, { minConfidence: 'medium' });
    if (!comparable) return { normalHints: ruleFacts, pendingHints: null };

    const normalFields = new Set<RuleFactFieldPath>();
    const pendingFields = new Set<RuleFactFieldPath>();
    for (const fact of resolveRuleFactClaims(ruleFacts)) {
      if (fact.field === 'interview_info.gender_source') continue;
      const currentValue = this.readPath(projected, fact.field);
      if (!this.hasValue(currentValue)) continue;

      const previousValue = this.readPath(comparable, fact.field);
      const target =
        fact.field === 'preferences.labor_form' ||
        !this.hasValue(previousValue) ||
        this.valuesEqual(fact.field, previousValue, currentValue)
          ? normalFields
          : pendingFields;
      target.add(fact.field);

      if (fact.field === 'interview_info.gender') {
        target.add('interview_info.gender_source');
      }
    }

    return {
      normalHints: this.selectClaims(ruleFacts, normalFields),
      pendingHints: this.selectClaims(ruleFacts, pendingFields),
    };
  }

  private readPath(facts: EntityExtractionResult, path: RuleFactFieldPath): unknown {
    const [group, field] = path.split('.') as ['interview_info' | 'preferences', string];
    return (facts[group] as unknown as Record<string, unknown>)[field];
  }

  private valuesEqual(path: RuleFactFieldPath, previous: unknown, current: unknown): boolean {
    if (path === 'preferences.city') {
      return this.cityValue(previous) === this.cityValue(current);
    }
    return isSameFactValue(previous, current);
  }

  private cityValue(value: unknown): string {
    if (!value) return '';
    return typeof value === 'string'
      ? value.trim()
      : String((value as CityFact).value ?? '').trim();
  }

  private hasValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  private selectClaims(
    facts: RuleFactClaims,
    fields: ReadonlySet<RuleFactFieldPath>,
  ): RuleFactClaims | null {
    const claims = facts.claims.filter((claim) => fields.has(claim.field));
    if (claims.length === 0) return null;
    const selected = { claims, reasoning: facts.reasoning };
    return formatRuleFactClaimLines(selected).length > 0 ? selected : null;
  }
}
