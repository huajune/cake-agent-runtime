import type { EntityExtractionResult, Preferences } from '@memory/types/session-facts.types';
import { isValidLaborForm } from '@memory/facts/labor-form';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 本轮查询约束段落（硬约束 + 软提示）
 *
 * 把 [会话记忆] / [本轮高置信线索] 中已经明确的字段分两层渲染：
 *
 * **硬约束**（6 个）：city / district / location / age / schedule / salary
 * 这些字段如果模型"忘了"，搜索结果要么完全无效（跨城/跨区），要么严重不匹配
 * （年龄差太大/班次完全冲突/薪资远低于预期），必须强制体现到查询参数中。
 * 其中 age 带弹性：差距 ≤3 岁的岗位不排除，标注"需 precheck 确认"。
 *
 * **软提示**（其余字段）：gender / position / brands / education / health_cert 等
 * 这些是结果过滤/筛选条件，模型不带这些条件搜索结果集会大一些，但不会"完全无效"。
 * 渲染为"建议参考"而非"必须"，模型有权根据上下文判断是否采纳——避免提取错误
 * 时模型被锁死无法自救。
 */
export class HardConstraintsSection implements PromptSection {
  readonly name = 'hard-constraints';

  build(ctx: PromptContext): string {
    const merged = this.mergeFacts(ctx.sessionFacts ?? null, ctx.highConfidenceFacts ?? null);
    const hardLines = this.collectHardConstraintLines(merged);
    const softLines = this.collectSoftHintLines(merged);
    if (hardLines.length === 0 && softLines.length === 0) return '';

    const sections: string[] = [];

    if (hardLines.length > 0) {
      sections.push(
        '[本轮查询硬约束]',
        '',
        '以下硬约束来自 [会话记忆] 与 [本轮高置信线索]，是候选人已经明确表达过的核心筛选条件。',
        '调用 duliday_job_list 时**必须**把这些约束体现到 filter 参数；缺少任一硬约束的查询结果',
        '不得用于"该候选人场景下无空缺"的结论。',
        '',
        ...hardLines,
      );
    }

    if (softLines.length > 0) {
      sections.push(
        '',
        '[本轮查询参考信息]',
        '',
        '以下信息来自 [会话记忆] 与 [本轮高置信线索]，供查询和推荐时参考。',
        '这些是建议性过滤条件——优先用于结果筛选，但如果你判断提取可能有误（如从引用消息中误提取），',
        '可以根据上下文自行决定是否采纳。',
        '',
        ...softLines,
      );
    }

    return sections.join('\n');
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
      delayed_intent:
        sessionFacts?.preferences.delayed_intent ??
        highConfidenceFacts?.preferences.delayed_intent ??
        null,
      short_term:
        sessionFacts?.preferences.short_term ?? highConfidenceFacts?.preferences.short_term ?? null,
      open_position:
        sessionFacts?.preferences.open_position ??
        highConfidenceFacts?.preferences.open_position ??
        null,
      time_windows:
        sessionFacts?.preferences.time_windows ??
        highConfidenceFacts?.preferences.time_windows ??
        null,
      schedule_constraint:
        sessionFacts?.preferences.schedule_constraint ??
        highConfidenceFacts?.preferences.schedule_constraint ??
        null,
      available_after:
        sessionFacts?.preferences.available_after ??
        highConfidenceFacts?.preferences.available_after ??
        null,
    };

    return { interview, pref };
  }

  /**
   * 硬约束：city / district / location / age / schedule / salary
   *
   * 这些字段如果模型"忘了"，搜索结果要么完全无效（跨城/跨区），
   * 要么严重不匹配（年龄差太大/班次冲突/薪资远低于预期）。
   */
  private collectHardConstraintLines(
    merged: { interview: EntityExtractionResult['interview_info']; pref: Preferences } | null,
  ): string[] {
    if (!merged) return [];

    const { interview, pref } = merged;
    const lines: string[] = [];

    if (pref.city?.value) {
      lines.push(
        `- 城市: ${pref.city.value}（必填到 duliday_job_list.cityNameList；调用 invite_to_group 时也必须用这个城市级名称）`,
      );
    }
    if (pref.district?.length) {
      if (pref.city?.value) {
        lines.push(
          `- 区域: ${pref.district.join('、')}（填到 duliday_job_list.regionNameList；严禁填到 invite_to_group.city）`,
        );
      } else {
        lines.push(
          `- 区域: ${pref.district.join('、')}（当前没有已确认城市；优先把区/县名作为 address 传给 \`geocode\` 工具，让工具按 unique/ambiguous 三态判定——单城返回直接用，多城同名再反问；不要先反问候选人城市再调工具；反问时不得带具体城市名）`,
        );
      }
    }
    if (pref.location?.length) {
      lines.push(
        `- 位置/商圈/地标: ${pref.location.join('、')}（做具体门店或附近岗位推荐前，必须先 geocode 或使用位置分享经纬度，再用 location 调 duliday_job_list；不得直接复用历史岗位事实）`,
      );
    }
    if (interview.age) {
      lines.push(
        `- 年龄: ${interview.age}（开 includeHiringRequirement；年龄弹性规则：候选人超岗位上限 ≤3 岁（如要求20-35、候选人36-38）或候选人 ≥23 岁且差岗位下限 ≤2 岁（如要求25-40、候选人23-24），该岗位仍可推荐，不要排除也不要说"年龄卡了/超龄"，应说"年龄差一点点，我帮你确认下"，由 precheck ageBoundary 判定；超出弹性范围的才视为不符）`,
      );
    }
    if (pref.schedule) {
      lines.push(
        `- 班次/工时偏好: ${pref.schedule}（结合 includeWorkTime 校验；结果集中无匹配班次/出勤的岗位不要推荐；岗位要求"每天/做六休一/周四周六周日都要给班/早开晚结全天时段"时，不能当作"只周末/每周最多几天/做一休一/下班后/只晚班"匹配；"每天/周一至周日"不等于"可只排周末"；若正在收资/约面且本轮刚补充或重复该硬约束，未校验匹配前不得说"没问题/备注上"，也不得继续追问身高体重住址等收资字段）`,
      );
    }
    if (pref.salary) {
      lines.push(`- 意向薪资: ${pref.salary}（开 includeJobSalary，结果中明显低于此预期的不要推）`);
    }

    return lines;
  }

  /**
   * 软提示：gender / position / brands / education / health_cert / is_student 等
   *
   * 这些是结果过滤/筛选条件，模型不带这些条件搜索结果集会大一些但不会"完全无效"。
   * 模型有权根据上下文判断是否采纳——避免提取错误时被锁死无法自救。
   */
  private collectSoftHintLines(
    merged: { interview: EntityExtractionResult['interview_info']; pref: Preferences } | null,
  ): string[] {
    if (!merged) return [];

    const { interview, pref } = merged;
    const lines: string[] = [];

    if (interview.gender) {
      lines.push(
        `- 性别: ${interview.gender}（建议开 includeHiringRequirement，结果中性别不符的优先排除）`,
      );
    }
    if (pref.brands?.length) {
      lines.push(
        `- 意向品牌: ${pref.brands.join('、')}（建议用 brandIdList；若搜索无结果可尝试去掉品牌限制扩大召回）`,
      );
    }
    if (pref.position?.length) {
      lines.push(
        `- 意向岗位: ${pref.position.join('、')}（建议填 jobCategoryList；注意只接受具体工种如"咖啡师"、"服务员"，严禁填入用工形式词；若搜索结果全部不匹配候选人的时间/年龄等硬约束，应清空 jobCategoryList 放宽重查一次）`,
      );
    }
    if (pref.labor_form && isValidLaborForm(pref.labor_form)) {
      lines.push(
        `- 用工形式细分: ${pref.labor_form}（仅作为结果过滤器，不要填入 jobCategoryList；开 includeWorkTime 后基于岗位排班/工时特征筛选）`,
      );
    }
    if (interview.is_student !== null && interview.is_student !== undefined) {
      lines.push(
        interview.is_student
          ? '- 是否学生: 是（学生/在读/准研究生身份需谨慎处理；建议开 includeHiringRequirement 或 duliday_interview_precheck 核对；结果中明确"不接受学生"的不要推给学生候选人；figure=不限、学历够、未写学生限制都不能推断为身份没限制，必须保守说明需要确认）'
          : '- 是否学生: 否（建议开 includeHiringRequirement 核对，不要把社会人士误问成学生）',
      );
    }
    if (interview.has_health_certificate) {
      lines.push(
        `- 健康证: ${interview.has_health_certificate}（建议开 includeHiringRequirement，岗位要求健康证而候选人没有时优先排除）`,
      );
    }
    if (interview.education) {
      lines.push(
        `- 学历: ${interview.education}（建议开 includeHiringRequirement，结果中学历不符的优先排除）`,
      );
    }
    if (pref.open_position) {
      lines.push(
        `- 候选人岗位开放: 是（候选人说过"什么都可以"等宽口径句式；jobCategoryList 建议留空，按区域/品牌/班次召回后由候选人自选）`,
      );
    }
    if (pref.short_term) {
      lines.push(
        `- 短期工意向: 是（候选人明确表示"做几天/临时/短期"；最少工作月数 ≥ 1 的岗位优先排除）`,
      );
    }
    if (pref.delayed_intent) {
      lines.push(
        `- 推迟意向: ${pref.delayed_intent.until}（候选人明确推迟/再说；建议按招募者口吻收尾，不主动催面/催报名）`,
      );
    }
    if (pref.time_windows?.length) {
      lines.push(
        `- 可用时间窗口: ${pref.time_windows.join('、')}（推荐岗位的工时班次建议与该窗口有交集）`,
      );
    }
    if (pref.schedule_constraint) {
      const parts: string[] = [];
      if (pref.schedule_constraint.onlyWeekends) parts.push('只周末');
      if (pref.schedule_constraint.onlyEvenings) parts.push('只晚班');
      if (pref.schedule_constraint.onlyMornings) parts.push('只早班');
      if (pref.schedule_constraint.maxDaysPerWeek)
        parts.push(`每周最多${pref.schedule_constraint.maxDaysPerWeek}天`);
      if (parts.length > 0) {
        lines.push(`- 结构化排班约束: ${parts.join('、')}（建议结合 includeWorkTime 校验匹配度）`);
      }
    }
    if (pref.available_after) {
      lines.push(
        `- 最早可面试日期: ${pref.available_after.date}（候选人原话："${pref.available_after.raw}"；该日期前不要催面试）`,
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
