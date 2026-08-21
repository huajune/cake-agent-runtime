import {
  type EntityExtractionResult,
  type Preferences,
  type SessionFacts,
  unwrapSessionFacts,
} from '@memory/session/session-facts.types';
import { projectRuleFactClaims } from '@resolution/evidence/merge';
import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import { isHardFilteredLaborForm, isValidLaborForm } from '@resolution/labor-form';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 本轮查询约束段落（硬约束 + 软提示）
 *
 * 把 [会话记忆] / [本轮解析线索] 中可供查询的字段分两层渲染：
 *
 * **硬约束**（6 个）：city / district / location / age / schedule / salary
 * 这些字段如果模型"忘了"，搜索结果要么完全无效（跨城/跨区），要么严重不匹配
 * （年龄差太大/班次完全冲突/薪资远低于预期），必须强制体现到查询参数中。
 * 其中 age 的弹性判定整体委托 precheck ageBoundary（severity=boundary 可继续推进、
 * hard_reject 必须拦截），本段只负责禁止模型自行通融。
 *
 * **软提示**（其余字段）：gender / position / brands / education / health_cert 等
 * 这些是结果过滤/筛选条件，模型不带这些条件搜索结果集会大一些，但不会"完全无效"。
 * 渲染为"建议参考"而非"必须"，模型有权根据上下文判断是否采纳——避免提取错误
 * 时模型被锁死无法自救。
 */
export class HardConstraintsSection implements PromptSection {
  readonly name = 'hard-constraints';

  build(ctx: PromptContext): string {
    const merged = this.mergeFacts(
      ctx.sessionFacts ?? null,
      ctx.ruleFacts ?? null,
      ctx.currentLaborFormIntent,
    );
    const hardLines = this.collectHardConstraintLines(merged);
    const softLines = this.collectSoftHintLines(merged, ctx.sessionBrandState ?? null);
    if (hardLines.length === 0 && softLines.length === 0) return '';

    const sections: string[] = [];

    if (hardLines.length > 0) {
      sections.push(
        '[本轮查询硬约束]',
        '',
        '以下硬约束来自 [会话记忆] 与 [本轮解析线索] 中满足查询阈值的字段。',
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
        '以下信息来自 [会话记忆] 与 [本轮解析线索]，供查询和推荐时参考。',
        '这些是建议性过滤条件——优先用于结果筛选，但如果你判断提取可能有误（如从引用消息中误提取），',
        '可以根据上下文自行决定是否采纳。',
        '',
        ...softLines,
      );
    }

    return sections.join('\n');
  }

  /**
   * 合并 sessionFacts（已确认）与 ruleFacts（本轮新增）。
   *
   * 取并集，**本轮高置信值优先覆盖旧 session 值**（候选人资料证据化 Phase 0 第 2 条）：
   * 工具层 tool-context.builder 的 mergeSessionFactsWithRuleClaims 一直是"本轮非 null
   * 高置信覆盖旧值"，本段若取"旧值优先、本轮仅补缺"——prompt 与工具就会对同一字段
   * 展示不同值（候选人刚改口的年龄/城市，硬约束段仍念旧值）。此处与工具层统一口径。
   * labor_form 走独立分支：除覆盖外还承担 clear（明确不要某形式）语义。
   *
   * 入参只接受 SessionFacts（带信封的存储态）：裸 EntityExtractionResult 会绕过
   * unwrapSessionFacts 的 minConfidence 比较，下面这道 high 门对它形同虚设（议题 1-1）。
   */
  private mergeFacts(
    sessionFacts: SessionFacts | null,
    ruleFacts: RuleFactClaims | null,
    currentLaborFormIntent: PromptContext['currentLaborFormIntent'],
  ): { interview: EntityExtractionResult['interview_info']; pref: Preferences } | null {
    const trustedSessionFacts = unwrapSessionFacts(sessionFacts, { minConfidence: 'high' });
    const currentRuleValues = projectRuleFactClaims(ruleFacts, { minConfidence: 'high' });
    if (!trustedSessionFacts && !currentRuleValues && currentLaborFormIntent?.kind !== 'set') {
      return null;
    }

    const interview = {
      ...this.emptyInterviewInfo(),
      ...this.dropNulls(trustedSessionFacts?.interview_info),
      ...this.dropNulls(currentRuleValues?.interview_info),
    };

    const currentRuleLaborForm = currentRuleValues?.preferences.labor_form ?? null;
    const sessionLaborForm = trustedSessionFacts?.preferences.labor_form ?? null;
    const previousLaborForm = currentRuleLaborForm ?? sessionLaborForm;
    const activeLaborForm =
      currentLaborFormIntent?.kind === 'set'
        ? currentLaborFormIntent.value
        : currentLaborFormIntent?.kind === 'clear' &&
            previousLaborForm &&
            currentLaborFormIntent.clearedValues.some((value) => value === previousLaborForm)
          ? null
          : previousLaborForm;

    const pref: Preferences = {
      // 品牌不进 Preferences（brands 字段已于 2026-08-19 记忆审计 S9 整体删除）；
      // 软提示行直读 sessionBrandState，品牌唯一真相是 brand_state。
      brand_ids:
        currentRuleValues?.preferences.brand_ids ??
        trustedSessionFacts?.preferences.brand_ids ??
        null,
      salary:
        currentRuleValues?.preferences.salary ?? trustedSessionFacts?.preferences.salary ?? null,
      position:
        currentRuleValues?.preferences.position ??
        trustedSessionFacts?.preferences.position ??
        null,
      schedule:
        currentRuleValues?.preferences.schedule ??
        trustedSessionFacts?.preferences.schedule ??
        null,
      city: currentRuleValues?.preferences.city ?? trustedSessionFacts?.preferences.city ?? null,
      district:
        currentRuleValues?.preferences.district ??
        trustedSessionFacts?.preferences.district ??
        null,
      location:
        currentRuleValues?.preferences.location ??
        trustedSessionFacts?.preferences.location ??
        null,
      labor_form: activeLaborForm,
      delayed_intent:
        currentRuleValues?.preferences.delayed_intent ??
        trustedSessionFacts?.preferences.delayed_intent ??
        null,
      short_term:
        currentRuleValues?.preferences.short_term ??
        trustedSessionFacts?.preferences.short_term ??
        null,
      open_position:
        currentRuleValues?.preferences.open_position ??
        trustedSessionFacts?.preferences.open_position ??
        null,
      time_windows:
        currentRuleValues?.preferences.time_windows ??
        trustedSessionFacts?.preferences.time_windows ??
        null,
      schedule_constraint:
        currentRuleValues?.preferences.schedule_constraint ??
        trustedSessionFacts?.preferences.schedule_constraint ??
        null,
      available_after:
        currentRuleValues?.preferences.available_after ??
        trustedSessionFacts?.preferences.available_after ??
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
        `- 城市: ${pref.city.value}（必填到 duliday_job_list.cityNameList；调用 invite_to_group 时也必须用这个城市级名称；若本轮需要对商圈/地标/街道调 geocode，也必须把该城市作为 geocode.city 传入，不要留空）`,
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
        `- 年龄: ${interview.age}（开 includeHiringRequirement；年龄弹性由 precheck ageBoundary 字段判定：severity=boundary 的可继续推进，severity=hard_reject 的必须拦截换岗；不要自行决定"稍微超了帮你试试"）`,
      );
    }
    if (pref.schedule) {
      lines.push(
        `- 班次/工时偏好: ${pref.schedule}（结合 includeWorkTime 校验；结果集中无匹配班次/出勤的岗位不要推荐；岗位要求"每天/做六休一/周四周六周日都要给班/早开晚结全天时段"时，不能当作"只周末/每周最多几天/做一休一/下班后/只晚班"匹配；"每天/周一至周日"不等于"可只排周末"；"做一休一"通常每周出勤 3–4 天，不满足"每周最多 1–2 天"，不得把它列为低周频候选人的合适方案；若正在收资/约面且本轮刚补充或重复该硬约束，未校验匹配前不得说"没问题/备注上"，也不得继续追问身高体重住址等收资字段）`,
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
    sessionBrandState: PromptContext['sessionBrandState'] = null,
  ): string[] {
    const lines: string[] = [];

    // 品牌口径改读 SessionBrandState（§9.3 终态：currentBrand + excludedBrands，
    // 不再读 preferences.brands 投影）：排斥语义首次可显式注入提示词（软约束，§8.1）。
    if (sessionBrandState?.currentBrand) {
      lines.push(
        `- 当前意向品牌: ${sessionBrandState.currentBrand.canonicalName}` +
          `（会话品牌状态；模型省略品牌参数时工具会自动沿用它查询。建议可得 ID 时用 brandIdList；` +
          `若要放宽探索别家，显式传 brandFilterMode='clear'）`,
      );
    }
    if (sessionBrandState?.excludedBrands?.length) {
      lines.push(
        `- 排斥品牌: ${sessionBrandState.excludedBrands.map((brand) => brand.canonicalName).join('、')}` +
          `（候选人明确表示过不要这些品牌：不要主动推荐其岗位，无品牌查询的结果里出现时优先跳过；` +
          `候选人本轮重新点名想去时按其最新表达处理）`,
      );
    }

    if (!merged) return lines;

    const { interview, pref } = merged;

    if (interview.gender) {
      lines.push(
        `- 性别: ${interview.gender}（建议开 includeHiringRequirement，结果中性别不符的优先排除）`,
      );
    }
    if (pref.brand_ids?.length) {
      lines.push(
        `- 意向品牌ID: ${pref.brand_ids.join('、')}（来自 Boss 岗位标题 [brand_id]；调用 duliday_job_list 时优先填到 brandIdList）`,
      );
    }
    if (pref.position?.length) {
      lines.push(
        `- 意向岗位: ${pref.position.join('、')}（候选人明确点名的具体工种可填 jobCategoryList——它**只影响排序不过滤**，匹配岗位会排在结果最前；只接受具体工种如"服务员"、"收银员"，不要填用工形式词。结果里没有明确匹配工种时，按每个岗位真实的岗位名称/工作内容判断相近岗位并如实介绍，不得把其他工种包装成候选人要的工种）`,
      );
    }
    if (pref.labor_form && isValidLaborForm(pref.labor_form)) {
      const hardFiltered = isHardFilteredLaborForm(pref.labor_form);
      lines.push(
        hardFiltered
          ? `- 用工形式: ${pref.labor_form}（工具会按岗位 用工形式/兼职类型 结构化字段**硬过滤**，只保留匹配「${pref.labor_form}」的岗位；不要填入 jobCategoryList。是否有「${pref.labor_form}」一律以工具结果为准，查岗前禁止承诺"有/没有「${pref.labor_form}」"，过滤后为空就如实告知附近暂无该用工形式岗位${pref.labor_form === '暑假工' ? '；暑假工无岗时直接拒绝并结束本轮，禁止追加问题、替代岗位或“是否考虑普通兼职/小时工/全职”等劝转话术' : ''}）`
          : `- 用工形式: ${pref.labor_form}（不要填入 jobCategoryList；介绍岗位用工形式时严格照岗位 用工形式/兼职类型 结构化字段，不要把别的用工形式的岗位说成「${pref.labor_form}」）`,
      );
    }
    if (interview.is_student !== null && interview.is_student !== undefined) {
      lines.push(
        interview.is_student
          ? '- 是否学生: 是（学生能否安排只看岗位数据；建议开 includeHiringRequirement 或 duliday_interview_precheck 核对。明确"不接受学生"则停止，明确接受/学生优先则继续；未写学生限制或未返回学生筛选项时按没有额外学生硬限制继续其余校验，不得凭空增加门店确认或人工介入。资格允许只代表可继续，约面阶段仍必须保持 candidateIsStudent=true 调 precheck，禁止只查 job_list 就承诺提交预约）'
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
      is_student: null,
      education: null,
      has_health_certificate: null,
      upload_resume: null,
    };
  }
}
