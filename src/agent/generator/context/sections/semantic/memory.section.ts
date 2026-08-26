// 知识归类：semantic —— 本段渲染候选人档案、会话事实、岗位与预约上下文。
import { formatExtractionFactLines } from '@memory/fact-lines.formatter';
import {
  type LaborFormIntentDecision,
  matchesLaborForm,
  sanitizeJobDisplayText,
  sanitizeLaborFormForDisplay,
} from '@resolution/labor-form';
import {
  type JobIntentFacts,
  type JobIntentFieldKey,
  type UserProfileFacts,
} from '@memory/long-term/long-term.types';
import {
  type EntityExtractionResult,
  type WeworkSessionState,
  unwrapSessionFacts,
} from '@memory/short-term/short-term.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { SignupWorkOrderItem } from '@sponge/sponge.types';
import type {
  PromptMemoryAdjudication,
  PromptMemoryConflict,
} from '@agent/generator/preparation/prompt-memory-adjudicator';
import type { PromptContext, PromptSection } from '../section.interface';

export interface RealtimeGroupStatus {
  groupName: string;
  city: string;
}

/** 记忆 section 壳体；渲染器与模型可见落点同处 semantic 目录。 */
export class MemorySection implements PromptSection {
  readonly name = 'memory';

  build(ctx: PromptContext): string {
    return ctx.memoryBlock?.trim() ?? '';
  }
}

/**
 * 把本轮相关记忆渲染成 ContextService.compose 能直接消费的 memoryBlock 字符串。
 *
 * 纯渲染层：所有数据由 PreparationService 召回后传入，本模块不做 IO。
 */
export function buildMemoryBlock(
  adjudication: PromptMemoryAdjudication,
  bookingContext: string,
  realtimeGroups: RealtimeGroupStatus[] = [],
  contactName?: string,
  contactBrandAliases: string[] = [],
  currentLaborFormIntent: LaborFormIntentDecision = { kind: 'ignore' },
  activeLaborForm: string | null = null,
): string {
  return (
    formatContactNamePreferenceHint(contactName, contactBrandAliases) +
    formatProfile(adjudication.profile) +
    formatLongTermJobIntent(adjudication.jobIntent) +
    formatConflictAnnotations(adjudication.conflicts) +
    (adjudication.sessionState
      ? formatSessionFacts(adjudication.sessionState, activeLaborForm, currentLaborFormIntent)
      : '') +
    formatRealtimeGroups(realtimeGroups) +
    bookingContext
  );
}

function formatConflictAnnotations(conflicts: readonly PromptMemoryConflict[]): string {
  if (conflicts.length === 0) return '';
  const lines = conflicts.map((conflict) => {
    return (
      `- ${conflict.label}：档案记 ${renderConflictValue(conflict.archivedValue)}，` +
      `本次称 ${renderConflictValue(conflict.sessionValue)}；按档案域权威链采用本次会话。`
    );
  });
  return (
    `\n\n[记忆冲突裁决]\n\n` +
    `_以下字段存在跨层异值。保留双方原值用于解释冲突，但只有标明的胜者可作为当前事实。` +
    `本段只裁决事实，不改变本轮应答义务；仍须正常回答候选人当前问题，不得因存在冲突而留空或静默。_\n` +
    lines.join('\n')
  );
}

function renderConflictValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.raw === 'string' && record.raw.trim()) return record.raw.trim();
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * 企微显示名称/备注常被运营改成「姓名 城市品牌门店」结构，标记这位候选人是
 * 冲着哪个品牌/门店来的——这是运营给本会话指定的目标品牌，不是可有可无的背景。
 *
 * contactName 先由 deriveContactBrandAliases 做品牌库确定性校验：
 * - 命中：只渲染标准品牌，原文仅用于帮助理解门店/城市；
 * - 未命中：整段不渲染，避免把普通微信昵称误当品牌。
 */
function formatContactNamePreferenceHint(
  contactName: string | undefined,
  contactBrandAliases: string[],
): string {
  const normalized = contactName
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 品牌库未命中时，contactName 只是普通微信昵称：不注入、不让模型自由猜品牌。
  if (!normalized || contactBrandAliases.length === 0) return '';

  const clipped = normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
  return (
    `\n\n[企微名称备注｜运营给本会话指定的目标品牌/门店]\n\n` +
    `- 企微显示名称/备注：${clipped}\n` +
    `- 品牌库高置信命中：${contactBrandAliases.join(' / ')}。只允许把这些标准品牌名当作本会话的目标品牌，不得从原始昵称中猜测其它品牌。\n` +
    `- **默认按上述已验证品牌召回**：调用 duliday_job_list 时使用 brandIdList/brandAliasList，推荐时优先该品牌的门店——**不要因为别的品牌门店离得更近就改推别家**。能同时读出门店的，在该品牌结果里优先挑这家门店或最近门店（备注门店名常与库内实名对不上，别直接塞 storeNameList 硬过滤，而是召回该品牌后在结果里挑）。\n` +
    `- 例外（以候选人为准）：候选人本轮主动指定了别的品牌、明确说不想要这个品牌、或要求「看看其他品牌/所有岗位」时跟随候选人；带该品牌召回为空时再放宽到不限品牌。\n` +
    `- 品牌名本身含城市词不代表候选人所在城市（如“成都你六姐”的“成都”是品牌名一部分），不要仅凭品牌名推断城市。\n` +
    `- 这是内部线索：回复里禁止提及“备注/企微名称/昵称显示”，也不要称呼候选人昵称。`
  );
}

/** 渲染实时群状态段；空数组（含核验失败）不渲染。 */
function formatRealtimeGroups(groups: RealtimeGroupStatus[]): string {
  if (groups.length === 0) return '';
  const lines = groups.map(
    (group, index) => `${index + 1}. ${group.groupName}（城市: ${group.city}）`,
  );
  return (
    `\n\n[候选人当前所在兼职群]\n\n` +
    `_以下为实时核验结果（非记忆）。候选人已在这些群内：禁止调用 invite_to_group 再次邀请，` +
    `也不要承诺"拉你进群"；候选人问群相关问题时直接按"你已经在 X 群里了"口径回应。_\n` +
    lines.join('\n')
  );
}

/**
 * 把长期档案渲染成 prompt 片段。
 *
 * 跨层重复/冲突已经由 preparation 的共享裁决视图预处理；本函数只渲染留下的长期值。
 */
function formatProfile(profile: UserProfileFacts | null): string {
  if (!profile) return '';

  const fieldRows: Array<{
    label: string;
    fact: UserProfileFacts[keyof UserProfileFacts];
  }> = [
    { label: '姓名', fact: profile.name },
    { label: '联系方式', fact: profile.phone },
    { label: '性别', fact: profile.gender },
    { label: '年龄', fact: profile.age },
    { label: '是否学生', fact: profile.is_student },
    { label: '学历', fact: profile.education },
    { label: '健康证', fact: profile.has_health_certificate },
    { label: '身高', fact: profile.height },
    { label: '体重', fact: profile.weight },
  ];

  const lines: string[] = [];
  for (const { label, fact } of fieldRows) {
    if (!fact) continue;
    const rendered =
      typeof fact.value === 'boolean' ? (fact.value ? '是' : '否') : String(fact.value);
    lines.push(`- ${label}: ${rendered}${formatProfileFactMeta(fact)}`);
  }

  if (lines.length === 0) return '';
  // 展示出处门（badcase 6a4f520a 赵堤案：历史档案被整张预填进报名表甩给候选人；
  // badcase 6a61bb34："哪里看出来之前在上海的"——旧档案被当断言复述引发投诉）：
  // 历史沉淀字段对候选人只能以"披露 + 请确认"口径使用，不得当作本次已确认的事实。
  return (
    `\n\n[用户档案]\n\n` +
    `_以下字段来自**历史会话沉淀**，未经本次会话确认。使用规则：\n` +
    `- 预填报名表/提交预约前，必须向候选人披露并逐项确认（口径如"帮你把之前登记过的信息带出来了，你看下对不对"），不得不加说明地当作候选人本次刚提供的信息直接使用；\n` +
    `- 向候选人复述这些信息时用披露句式（"我记得你之前提过…现在还是吗"），不得说成候选人本次已确认；\n` +
    `- 候选人表示某项不对/不认识时，立即弃用该历史值，按候选人本次说法重新收集。_\n\n` +
    lines.join('\n')
  );
}

function formatProfileFactMeta(value: {
  confidence: string;
  source: string;
  evidence: string;
  updatedAt: string;
}): string {
  // evidence 是排障字段，不注入 prompt：提取 reasoning 全文曾随每个字段重复注入，
  // 单轮 system prompt 被撑到 27K+ 字符（张漪 case）。更新时间保留日期部分，
  // 让模型能判断档案信息的新旧。
  const updatedDate = value.updatedAt?.slice(0, 10) || value.updatedAt;
  return `（置信度: ${value.confidence}，来源: ${value.source}，更新于: ${updatedDate}）`;
}

/**
 * 把长期求职意向渲染成 prompt 片段。
 *
 * 这是 consolidation 沉淀的上一段求职会话的意向快照——历史参考，不是当前事实：
 * 标注记录日期并明确"以本次会话为准"，避免重蹈旧会话事实复活的覆辙。
 * available_after 已过期（日期早于今天）的直接不渲染。
 */
function formatLongTermJobIntent(preferences: JobIntentFacts | null): string {
  if (!preferences) return '';

  // 穷尽映射：本表就是 [历史求职意向] 区块的渲染白名单（下方按 Object.entries 遍历），
  // 往 LONG_TERM_JOB_INTENT_FIELD_KEYS 加字段而漏登记，该意向会沉淀入库却永不进
  // prompt。收成 Record<JobIntentFieldKey, …> 让这种遗漏在编译期就失败。
  const labels: Record<JobIntentFieldKey, string> = {
    city: '意向城市',
    district: '意向区域',
    location: '意向地点',
    brands: '意向品牌',
    position: '意向岗位',
    schedule: '意向班次',
    salary: '意向薪资',
    labor_form: '用工形式',
    schedule_constraint: '排班硬约束',
    delayed_intent: '推迟意向',
    available_after: '最早可面日期',
  };

  const lines: string[] = [];
  let latestUpdatedAt = '';
  for (const [key, label] of Object.entries(labels)) {
    const fact = preferences[key as keyof JobIntentFacts];
    if (!fact || fact.value === null || fact.value === undefined) continue;

    const rendered = renderPreferenceValue(key, fact.value);
    if (!rendered) continue;

    lines.push(`- ${label}: ${rendered}`);
    if (fact.updatedAt > latestUpdatedAt) latestUpdatedAt = fact.updatedAt;
  }

  if (lines.length === 0) return '';
  const recordedDate = latestUpdatedAt ? latestUpdatedAt.slice(0, 10) : '未知时间';
  return (
    `\n\n[历史求职意向]\n\n` +
    `_以下是候选人上一段求职会话沉淀的意向（记录于 ${recordedDate}），仅供参考承接；` +
    `候选人本次会话表达的新意向一律优先，不一致时以本次为准，不要拿旧意向反驳候选人。_\n` +
    lines.join('\n')
  );
}

/** 渲染单个长期意向值；返回 null 表示该字段不应注入（如已过期）。 */
function renderPreferenceValue(key: string, value: unknown): string | null {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(String).join('、') : null;
  }
  if (key === 'available_after' && typeof value === 'object' && value !== null) {
    const fact = value as { date?: string; raw?: string };
    if (!fact.date) return null;
    // 过期的"最早可面日期"不再注入
    const today = new Date().toISOString().slice(0, 10);
    if (fact.date < today) return null;
    return `${fact.date}（原话: ${fact.raw ?? ''}）`;
  }
  if (key === 'delayed_intent' && typeof value === 'object' && value !== null) {
    const fact = value as { until?: string; raw?: string };
    if (!fact.until) return null;
    return `${fact.until}（原话: ${fact.raw ?? ''}）`;
  }
  if (key === 'schedule_constraint' && typeof value === 'object' && value !== null) {
    const c = value as {
      onlyWeekends?: boolean | null;
      onlyEvenings?: boolean | null;
      onlyMornings?: boolean | null;
      maxDaysPerWeek?: number | null;
    };
    const parts: string[] = [];
    if (c.onlyWeekends) parts.push('只周末');
    if (c.onlyEvenings) parts.push('只晚班');
    if (c.onlyMornings) parts.push('只早班');
    if (c.maxDaysPerWeek) parts.push(`每周最多${c.maxDaysPerWeek}天`);
    return parts.length > 0 ? parts.join('、') : null;
  }
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return null;
}

/** 把会话记忆渲染成 prompt 片段。 */
function formatSessionFacts(
  state: WeworkSessionState,
  activeLaborForm: string | null,
  currentIntent: LaborFormIntentDecision = { kind: 'ignore' },
): string {
  const sections: string[] = [];
  // 岗位轴是层级结构（laborForm=全职/兼职 + partTimeJobType 细分），意向值比对
  // 必须走 matchesLaborForm：暑假工岗的 summary 是 laborForm=兼职 + partTimeJobType=暑假工，
  // 扁平全等会把候选池整个滤空/漏清。
  const visibleJobs = (jobs: RecommendedJobSummary[] | null | undefined) => {
    if (currentIntent.kind === 'set') {
      return (jobs ?? []).filter((job) =>
        matchesLaborForm(job.laborForm, job.partTimeJobType, currentIntent.value),
      );
    }
    if (currentIntent.kind === 'clear') {
      return (jobs ?? []).filter(
        (job) =>
          !job.laborForm ||
          !currentIntent.clearedValues.some((value) =>
            matchesLaborForm(job.laborForm, job.partTimeJobType, value),
          ),
      );
    }
    return activeLaborForm === '暑假工'
      ? (jobs ?? []).filter((job) => matchesLaborForm(job.laborForm, job.partTimeJobType, '暑假工'))
      : (jobs ?? []);
  };

  if (state.facts) {
    // set 型 turnHint 只在增量块展示：与既有 facts 同值时去重，异值时标「待确认更新」，
    // 不再把尚未落盘的本轮值伪装成会话事实。clear 是显式撤销，仍从展示副本移除旧值。
    const persistedLaborForm = unwrapSessionFacts(state.facts, { minConfidence: 'medium' })
      ?.preferences.labor_form;
    const shouldClearPersistedLaborForm =
      currentIntent.kind === 'clear' &&
      Boolean(
        persistedLaborForm &&
          currentIntent.clearedValues.some((value) => value === persistedLaborForm),
      );
    const factsForPrompt = shouldClearPersistedLaborForm
      ? ({
          ...state.facts,
          preferences: {
            ...state.facts.preferences,
            labor_form: null,
          },
        } as unknown as EntityExtractionResult)
      : state.facts;
    const factLines = formatExtractionFactLines(factsForPrompt);

    if (factLines.length > 0) {
      sections.push(`## 候选人已知信息\n${factLines.join('\n')}`);
    }
  }

  const candidatePool = visibleJobs(state.lastCandidatePool);
  if (candidatePool.length > 0) {
    // 渲染上限对齐 presentedJobs 的 slice(0,10)：候选池是唯一写入端无 cap 的池子
    // （工具单页 20 条且可能放宽），全量渲染会让 memoryBlock 无界膨胀。
    // Redis 中仍保留全量池供 jobId 复用/品牌回指匹配。
    const MAX_POOL_LINES = 10;
    const pool = candidatePool.slice(0, MAX_POOL_LINES);
    const jobLines = pool.map((j, i) => formatJobMemoryLine(j, i + 1));
    const omitted = candidatePool.length - pool.length;
    const omittedNote =
      omitted > 0 ? `\n（另有 ${omitted} 个候选岗位未展示，可通过工具重新查询）` : '';
    sections.push(`## 上轮候选岗位池\n${jobLines.join('\n')}${omittedNote}`);
  }

  const presentedJobs = visibleJobs(state.presentedJobs);
  if (presentedJobs.length > 0) {
    const jobLines = presentedJobs.map((j, i) => formatJobMemoryLine(j, i + 1));
    sections.push(`## 最近已展示岗位\n${jobLines.join('\n')}`);
  }

  if (state.currentFocusJob && visibleJobs([state.currentFocusJob]).length > 0) {
    sections.push(`## 当前焦点岗位\n${formatJobMemoryLine(state.currentFocusJob)}`);
  }

  if (state.invitedGroups?.length) {
    // 历史 badcase 3g1ruov9 / 6vzw8oh3：本会话拉过群但记忆里漏渲染，Agent 看不到导致重复拉群。
    // 触发 invite_to_group 工具时本字段已写入 session 记忆，这里把它注入 prompt 让 Agent 主动避让。
    const groupLines = state.invitedGroups.map((g, i) => {
      const industry = g.industry ? `（${g.industry}）` : '';
      return `${i + 1}. ${g.groupName}${industry} - 城市: ${g.city}, 邀请时间: ${g.invitedAt}`;
    });
    sections.push(
      `## 本会话已邀入的兼职群（禁止重复拉群）\n${groupLines.join('\n')}\n\n_命中以上任一群时，禁止再次调用 invite_to_group；候选人本轮再次同意入群/暗示想进群时，直接告知"之前已经把你拉到 X 群了，可以查看一下手机微信"即可。_`,
    );
  }

  if (sections.length === 0) return '';
  const detailLookupRule =
    '_岗位详情使用规则：精简记忆只负责承接已有字段和定位 jobId。候选人追问的字段未在「当前焦点岗位」中明确出现时，必须按该 jobId 调用 duliday_job_list 补查后再回答，禁止从综合薪资单位、岗位名、品牌常识或历史助手回复推断。薪资、结算周期/发薪日和具体福利即使摘要有值，也必须实时重查。_';
  return `\n\n[会话记忆]\n\n${detailLookupRule}\n\n${sections.join('\n\n')}`;
}

export function formatBookingContext(
  workOrder: SignupWorkOrderItem,
  index = 1,
  location?: {
    storeAddress?: string;
    interviewMethod?: string;
    interviewAddress?: string;
  },
): string {
  const displayJobName = sanitizeJobDisplayText(workOrder.jobName ?? null);
  const businessLines = [
    workOrder.brandName ? `品牌: ${workOrder.brandName}` : null,
    workOrder.projectName ? `门店/项目: ${workOrder.projectName}` : null,
    displayJobName ? `岗位: ${displayJobName}` : null,
    workOrder.currentStatus ? `当前状态: ${workOrder.currentStatus}` : null,
    workOrder.signUpTime ? `报名时间: ${workOrder.signUpTime}` : null,
    // 海绵 2026-07 起下发；缺了它模型只看到「约面待确认」这个无日期状态词，
    // 会把"已排期"语义补全成"还在等门店确认排期"（badcase pm2ivers）。
    workOrder.interviewTime ? `面试时间: ${workOrder.interviewTime}` : null,
    workOrder.interviewPassTime ? `面试通过时间: ${workOrder.interviewPassTime}` : null,
    location?.storeAddress ? `工作门店地址: ${location.storeAddress}` : null,
    location?.interviewMethod ? `面试形式: ${location.interviewMethod}` : null,
    location?.interviewAddress ? `面试地址: ${location.interviewAddress}` : null,
  ].filter((line): line is string => Boolean(line));

  // 仅有标题行 + 工单号（无任何业务字段）时不渲染，避免给 Agent 一个空壳 case。
  if (businessLines.length === 0) return '';

  // 岗位ID 单独渲染：改约前 Agent 要用它调 duliday_interview_precheck 校验新日期。
  // 通用处理规则不在此逐条渲染：N 条 booking 会把同一段 ~1.5-2KB
  // 教学文字重复 N 次，统一由 BOOKING_CONTEXT_SHARED_RULES 在 [当前预约信息] 末尾渲染一次。
  const lines = [
    `预约 ${index}：当前存在一个仍在进行中的面试/上岗跟进 case（状态实时取自海绵工单系统）。`,
    `工单号: ${workOrder.workOrderId}`,
    workOrder.jobId != null ? `岗位ID: ${workOrder.jobId}` : null,
    ...businessLines,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

/**
 * [当前预约信息] 的通用处理规则：对所有 booking 生效，整段只渲染一次
 * （由 preparation.loadBookingContext 在全部预约块之后拼接）。
 * 文案与原逐条渲染版本逐字一致；这里只改渲染次数，不改语义。
 */
// 程序记忆层·booking 共享规则（代码动态注入居所）；总目录：docs/prompt-rule-ledger.md
export const BOOKING_CONTEXT_SHARED_RULES = [
  '以上预约统一按下列规则处理：',
  '候选人可同时报名多个不同岗位；已预约 A 岗不代表不能继续报名 B 岗。但同一工单/同一岗位不要重复提交报名。',
  '候选人主动要求改约面时间时：先用上面的「岗位ID」调 duliday_interview_precheck(requestedDate=候选人想改到的新日期) 校验新日期是否可约——只有返回 interview.requestedDate.status=available（nextAction 不是 date_unavailable）时，才用「工单号」调 duliday_modify_interview_time 自助改约；若 precheck 判该日期不可约，则把 precheck 返回的可约时段（scheduleRule / upcomingTimeOptions）抛给候选人继续协商重选，不要转人工。候选人在**面试开始之前**明确放弃这次已约面试/岗位时（不限于说"取消"二字，"不去了""干不了""不想干了"等明确拒绝也算）必须调 duliday_cancel_work_order 自助取消——工单不会因口头放弃自动失效，不取消门店会空等、候选人留爽约记录。**但「面试时间」已经到了/过了，候选人才说"没去""过不去了""没赶上"→ 这是爽约不是取消，禁止再调 duliday_cancel_work_order**：过时未到属门店与人工跟单处理的爽约事件，只承接候选人（问下原因/是否还想找），有继续找工意向就按新流程推进。改约/取消工具自身提交失败时，再按 request_handoff(modify_appointment) 转人工。',
  '「面试时间」已在上方给出时：不得声称还在等门店确认时间、等排期或时间未定。若该时间已早于当前日期且没有「面试通过时间」，说明面试已过期且结果未知——必须先向候选人核实当天是否到场面试，再按其回答推进或改约，禁止臆断已面试/未面试或编造后续流程。',
  '预约可能来自候选人此前与另一位招聘顾问的沟通，不一定是你经手的。仅当候选人主动问起它、或主动要求改约/取消时才可提及；候选人在咨询其他品牌/门店/岗位时，不得主动插入该预约的状态，也不得使用「我看到你报了…」这类像是本人经手的口径。',
  '当 case 出现无法推进的阻塞（找不到门店/到店无人接待/预约信息冲突/入职办理异常等）时，必须调用 request_handoff 工具触发人工介入。',
  '必须先核对「面试形式」：只有明确为线下/到店/现场面试才允许告知或发送面试地址。线上、AI、视频、电话面试不需要到店，禁止发送任何面试定位；面试形式未明确时也不得猜测为线下。仅在明确线下面试且「面试地址」与「工作门店地址」不同时，候选人询问赴约地址/定位才优先面试地址。',
].join('\n');

function formatJobMemoryLine(job: RecommendedJobSummary, index?: number): string {
  const head = index ? `${index}. [jobId:${job.jobId}]` : `[jobId:${job.jobId}]`;
  const parts = [
    head,
    `品牌:${job.brandName ?? ''} - 岗位:${sanitizeJobDisplayText(job.jobName) ?? ''}`,
  ];

  if (job.storeName) parts.push(`门店:${job.storeName}`);
  if (job.storeAddress) parts.push(`地址:${job.storeAddress}`);
  if (job.cityName || job.regionName) {
    parts.push(`地区:${[job.cityName, job.regionName].filter(Boolean).join('')}`);
  }
  if (job.distanceKm != null) parts.push(`距离:${job.distanceKm.toFixed(1)}km`);
  const displayLaborForm = sanitizeLaborFormForDisplay(job.laborForm);
  const displayPartTimeJobType = sanitizeLaborFormForDisplay(job.partTimeJobType);
  if (displayLaborForm) {
    parts.push(
      displayPartTimeJobType && displayPartTimeJobType !== displayLaborForm
        ? `用工:${displayLaborForm}(${displayPartTimeJobType})`
        : `用工:${displayLaborForm}`,
    );
  }
  if (job.salaryDesc) parts.push(`薪资:${job.salaryDesc}`);
  if (job.settlementSummary) parts.push(`结算:${job.settlementSummary}`);
  if (job.shiftSummary) parts.push(`班次:${job.shiftSummary}`);

  const welfareSummary = formatJobWelfareFacts(job);
  if (welfareSummary) parts.push(`福利:${welfareSummary}`);

  const bookingConstraint = formatBookingConstraint(job);
  if (bookingConstraint) parts.push(`约面要求:${bookingConstraint}`);

  return parts.join(' | ');
}

function formatJobWelfareFacts(job: RecommendedJobSummary): string | null {
  const welfare = job.welfareFacts;
  if (!welfare) return null;

  const labels = {
    company: '公司提供',
    allowance: '仅补贴（不直接提供）',
    self_or_none: '无（员工自理/公司不提供）',
    unspecified: '未明确',
  } as const;
  const facts = [
    `员工餐${labels[welfare.meals]}`,
    `住宿${labels[welfare.accommodation]}`,
    welfare.hasTrafficAllowance ? '有交通补贴' : null,
    welfare.hasPromotionWelfare ? '有晋升福利说明' : null,
    welfare.otherWelfareItems.length > 0
      ? `其他福利:${welfare.otherWelfareItems.join('、')}`
      : null,
  ].filter((fact): fact is string => Boolean(fact));

  return facts.join('，') || null;
}

function formatBookingConstraint(job: RecommendedJobSummary): string | null {
  const constraints: string[] = [];

  if (job.ageRequirement && job.ageRequirement !== '不限') {
    constraints.push(`年龄${job.ageRequirement}`);
  }
  if (job.educationRequirement && job.educationRequirement !== '不限') {
    constraints.push(`学历${job.educationRequirement}`);
  }
  if (
    job.healthCertificateRequirement &&
    job.healthCertificateRequirement !== '未明确要求' &&
    job.healthCertificateRequirement !== '不限'
  ) {
    constraints.push(`健康证${job.healthCertificateRequirement}`);
  }
  if (job.studentRequirement) {
    constraints.push(`学生${job.studentRequirement}`);
  }

  if (constraints.length === 0) return null;
  return constraints.join('，');
}
