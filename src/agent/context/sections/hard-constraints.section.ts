import type { EntityExtractionResult, Preferences } from '@memory/types/session-facts.types';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 本轮查询硬约束段落
 *
 * 把 [会话记忆] / [本轮高置信线索] 中已经明确的「会决定 duliday_job_list filter 应该传什么」
 * 的字段，集中、扁平地列出来，强制模型在调用查询工具时把它们体现到 filter 中。
 *
 * 设计动机：
 * - 排障发现，模型在管理员/历史轮已经讲过「急需男生晚班打烊」的会话里，仍会调用一个
 *   不带性别/班次过滤的宽泛查询，再用结果代表"该候选人场景下无空缺"。
 * - sessionFacts 已有这些字段，但被埋在 [会话记忆] 段落内，模型决策时未必会显式提取。
 * - 这里把它们集中渲染成"调用 duliday_job_list 必须考虑"的清单，提高被引用概率。
 */
export class HardConstraintsSection implements PromptSection {
  readonly name = 'hard-constraints';

  build(ctx: PromptContext): string {
    const merged = this.mergeFacts(ctx.sessionFacts ?? null, ctx.highConfidenceFacts ?? null);
    const lines = this.collectConstraintLines(merged);
    if (lines.length === 0) return '';

    return [
      '[本轮查询硬约束]',
      '',
      '以下硬约束来自 [会话记忆] 与 [本轮高置信线索]，是候选人或管理员已经明确表达过的筛选条件。',
      '调用 duliday_job_list 时**必须**把这些约束体现到 filter 参数；缺少任一硬约束的查询结果',
      '不得用于"该候选人场景下无空缺"的结论。',
      '',
      ...lines,
    ].join('\n');
  }

  /**
   * 合并 sessionFacts（已确认）与 highConfidenceFacts（本轮新增）。
   *
   * 取并集：sessionFacts 已有的优先保留；highConfidenceFacts 仅补充 sessionFacts 缺失的字段。
   * 这里不处理冲突——TurnHintsSection 已负责把冲突字段单独拎到「待确认线索」段落。
   */
  private mergeFacts(
    sessionFacts: EntityExtractionResult | null,
    highConfidenceFacts: EntityExtractionResult | null,
  ): { interview: EntityExtractionResult['interview_info']; pref: Preferences } | null {
    if (!sessionFacts && !highConfidenceFacts) return null;

    const interview = {
      ...this.emptyInterviewInfo(),
      ...this.dropNulls(highConfidenceFacts?.interview_info),
      ...this.dropNulls(sessionFacts?.interview_info),
    };

    const pref: Preferences = {
      brands: sessionFacts?.preferences.brands ?? highConfidenceFacts?.preferences.brands ?? null,
      salary: sessionFacts?.preferences.salary ?? highConfidenceFacts?.preferences.salary ?? null,
      position:
        sessionFacts?.preferences.position ?? highConfidenceFacts?.preferences.position ?? null,
      schedule:
        sessionFacts?.preferences.schedule ?? highConfidenceFacts?.preferences.schedule ?? null,
      city: sessionFacts?.preferences.city ?? highConfidenceFacts?.preferences.city ?? null,
      district:
        sessionFacts?.preferences.district ?? highConfidenceFacts?.preferences.district ?? null,
      location:
        sessionFacts?.preferences.location ?? highConfidenceFacts?.preferences.location ?? null,
      labor_form:
        sessionFacts?.preferences.labor_form ?? highConfidenceFacts?.preferences.labor_form ?? null,
    };

    return { interview, pref };
  }

  /**
   * 从合并后的 facts 中挑出"决定 duliday_job_list 应当传什么"的字段。
   *
   * 不重复渲染所有 facts（那样会和 [会话记忆] 完全冗余），只渲染对查询 filter 直接相关的硬约束。
   */
  private collectConstraintLines(
    merged: { interview: EntityExtractionResult['interview_info']; pref: Preferences } | null,
  ): string[] {
    if (!merged) return [];

    const { interview, pref } = merged;
    const lines: string[] = [];

    if (pref.city?.value) {
      lines.push(`- 城市: ${pref.city.value}（必填到 cityNameList）`);
    }
    if (pref.district?.length) {
      lines.push(`- 区域: ${pref.district.join('、')}（填到 regionNameList）`);
    }
    if (pref.brands?.length) {
      lines.push(`- 意向品牌: ${pref.brands.join('、')}（用 brandIdList 而非 brandAliasList）`);
    }
    if (pref.position?.length) {
      lines.push(`- 意向岗位: ${pref.position.join('、')}（必要时填 jobCategoryList）`);
    }
    if (pref.schedule) {
      lines.push(
        `- 班次/工时偏好: ${pref.schedule}（结合 includeWorkTime 校验，结果集中无匹配班次的岗位不要推荐）`,
      );
    }
    if (pref.salary) {
      lines.push(`- 意向薪资: ${pref.salary}（开 includeJobSalary，结果中明显低于此预期的不要推）`);
    }

    if (interview.gender) {
      lines.push(
        `- 性别: ${interview.gender}（开 includeHiringRequirement，结果中性别不符的不要推荐）`,
      );
    }
    if (interview.age) {
      lines.push(
        `- 年龄: ${interview.age}（开 includeHiringRequirement，结果中年龄不符的不要推荐）`,
      );
    }
    if (interview.is_student !== null && interview.is_student !== undefined) {
      lines.push(
        `- 是否学生: ${interview.is_student ? '是' : '否'}（开 includeHiringRequirement，结果中明确"不接受学生/学生勿扰"的不要推给学生候选人）`,
      );
    }
    if (interview.has_health_certificate) {
      lines.push(
        `- 健康证: ${interview.has_health_certificate}（开 includeHiringRequirement，岗位要求健康证而候选人没有时不要推）`,
      );
    }
    if (interview.education) {
      lines.push(
        `- 学历: ${interview.education}（开 includeHiringRequirement，结果中学历不符的不要推荐）`,
      );
    }

    return lines;
  }

  private dropNulls(
    obj: EntityExtractionResult['interview_info'] | undefined,
  ): Partial<EntityExtractionResult['interview_info']> {
    if (!obj) return {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      result[key] = value;
    }
    return result as Partial<EntityExtractionResult['interview_info']>;
  }

  private emptyInterviewInfo(): EntityExtractionResult['interview_info'] {
    return {
      name: null,
      phone: null,
      gender: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    };
  }
}
