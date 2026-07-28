import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

type SettlementCycle = '日结' | '周结' | '月结';

interface SettlementGroundTruth {
  primary: Set<SettlementCycle>;
  supplemental: Set<SettlementCycle>;
}

const CYCLE_PATTERNS: ReadonlyArray<{ cycle: SettlementCycle; pattern: RegExp }> = [
  { cycle: '日结', pattern: /日结|当日结|当天结/u },
  { cycle: '周结', pattern: /周结|按周结/u },
  { cycle: '月结', pattern: /月结|按月结|次月/u },
];
const SUPPLEMENTAL_TYPE_PATTERN = /培训|试用|试工/u;
const SUPPLEMENTAL_CONTEXT_PATTERN = /阶梯|差价|培训|试用|试工|补发/u;

function cyclesFromText(text: string): SettlementCycle[] {
  return CYCLE_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ cycle }) => cycle);
}

function readMarkdownSettlement(markdown: string, truth: SettlementGroundTruth): void {
  const scenarioPattern = /#### 薪资方案 \d+（([^）]+)）([\s\S]*?)(?=#### 薪资方案|### |---|$)/gu;
  let foundScenario = false;
  for (const match of markdown.matchAll(scenarioPattern)) {
    foundScenario = true;
    const target = SUPPLEMENTAL_TYPE_PATTERN.test(match[1]) ? truth.supplemental : truth.primary;
    for (const cycle of cyclesFromText(match[2])) target.add(cycle);
  }
  if (foundScenario) return;

  for (const line of markdown.split('\n')) {
    if (!line.includes('结算周期')) continue;
    for (const cycle of cyclesFromText(line)) truth.primary.add(cycle);
  }
}

function readStructuredSettlement(value: unknown, truth: SettlementGroundTruth): void {
  if (Array.isArray(value)) {
    for (const item of value) readStructuredSettlement(item, truth);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.salaryPeriod === 'string') {
    const salaryType = typeof record.salaryType === 'string' ? record.salaryType : '';
    const target = SUPPLEMENTAL_TYPE_PATTERN.test(salaryType) ? truth.supplemental : truth.primary;
    for (const cycle of cyclesFromText(record.salaryPeriod)) target.add(cycle);
  }
  for (const child of Object.values(record)) readStructuredSettlement(child, truth);
}

function callTargetsJob(call: AgentToolCall, focusJobId: number | undefined): boolean {
  if (focusJobId === undefined) return true;
  const jobIdList = call.args.jobIdList;
  return Array.isArray(jobIdList) && jobIdList.some((value) => Number(value) === focusJobId);
}

function readSettlementGroundTruth(
  toolCalls: AgentToolCall[],
  focusJobId: number | undefined,
): SettlementGroundTruth | null {
  const truth: SettlementGroundTruth = { primary: new Set(), supplemental: new Set() };
  for (const call of toolCalls) {
    if (
      call.toolName !== 'duliday_job_list' ||
      call.status === 'error' ||
      !call.result ||
      !callTargetsJob(call, focusJobId)
    ) {
      continue;
    }
    const result = call.result as Record<string, unknown>;
    if (typeof result.markdown === 'string') readMarkdownSettlement(result.markdown, truth);
    if (result.rawData) readStructuredSettlement(result.rawData, truth);
  }
  return truth.primary.size > 0 || truth.supplemental.size > 0 ? truth : null;
}

function splitClaimSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

// 否定前缀词表。2026-07-21 审计：原表只有「不是|并非|不按|不算」，漏掉最常用的
// 「没有/没/无/暂无」，导致"附近暂时没有日结的岗位"被判成"回复声称日结"——窗口内
// 16 条命中里 5 条属此类假阳，且 rewrite 二审通过率 0%（任何正确回答都必须出现结算词）。
// 2026-07-24 审计追补「不支持|没找到|未找到|找不到」："也不支持日结或周结"整句失防
// （trace batch_6a61a550…，rewrite 为修它追加了无依据的月结断言）。
const NEGATION_PREFIX =
  '不是|并非|不按|不算|没有|没找到|未找到|找不到|没排到|排不到|没|无|暂无|不提供|不做|不支持';

// 后缀否定：否定词在结算词之后（"日结的暂时没排到哈"）。前缀正则不认这种语序，
// 2026-07-27 审计 FP：trace batch_6a62db88…（"日结的暂时没排到哈"被判声称日结，
// rewrite 空转丢了"时薪 20 多"）。间隔同样禁跨逗号/顿号。
const NEGATION_SUFFIX =
  '没排到|排不到|没找到|找不到|没约到|约不到|没有|暂时没|暂无|没了|不做|不支持';

// 愿望复述：句子在复述候选人自己的诉求（"你想找日结、只做一周左右的岗位是吧"），
// 不是对焦点岗位的结算承诺。问号被 splitClaimSentences 剥掉、"吧"不在疑问词表，
// 这类句子会漏进断言判定（2026-07-27 审计 FP：trace batch_6a63278c…）。
// 窗口禁跨逗号/顿号，避免"你想找日结，这家就是日结"里第二个断言被连带豁免。
const DESIRE_ECHO_PREFIX = '你想找|你想要|你是想|你想|你要|想找|要找';

// 前瞻/他岗语境：句子谈的是"其他岗位/未来供给/别家的灵工单"，不是焦点岗位的结算承诺。
// 2026-07-24 审计："后面有周结/日结的新岗位第一时间通知你"、"海底捞……灵工单（短期/日结）"
// 均被判成对焦点岗位声称日结/周结（trace batch_6a5ee3e8…、batch_6a5db79e…）。
// 词表刻意只收"未来供给/他岗实体"强信号（新岗位/灵工单/第一时间通知…），不收
// 泛化的"留意/帮你看看"——后者常与焦点岗位断言同句出现，会豁免掉真违规。
const PROSPECTIVE_CONTEXT_PATTERN =
  /其他[^，。；]{0,8}岗位|新岗位|灵工单|第一时间|后面有|后续(?:有|如果)|发(?:到)?群里/u;

function sentenceAssertsCycle(sentence: string, cycle: SettlementCycle): boolean {
  const pattern = CYCLE_PATTERNS.find((entry) => entry.cycle === cycle)?.pattern;
  if (!pattern?.test(sentence)) return false;
  if (/[吗么嘛？?]|是不是|是否/u.test(sentence)) return false;
  if (PROSPECTIVE_CONTEXT_PATTERN.test(sentence)) return false;
  if (new RegExp(`(?:${DESIRE_ECHO_PREFIX})[^，。；、]{0,6}${cycle}`, 'u').test(sentence)) {
    return false;
  }
  if (new RegExp(`${cycle}[^，。；、]{0,4}(?:${NEGATION_SUFFIX})`, 'u').test(sentence)) {
    return false;
  }
  // 间隔禁跨逗号/顿号：保证"这家不是月结，是日结"里的"日结"仍算断言。
  // 并列穿透只走显式可选组「…或/、//」一次（如"没找到其他周结或日结的岗位"——「日结」
  // 距否定词 7 字超出旧窗口，alternation 后段照旧假阳，2026-07-24 审计）。基础间隔
  // 排除顿号 + 并列后残余间隔收紧到 1 字，避免"没有月结、只有日结"这类转折被误豁免。
  return !new RegExp(
    `(?:${NEGATION_PREFIX})[^，。；、]{0,5}(?:[^，。；、]{0,4}[或、/])?[^，。；、]?${cycle}`,
    'u',
  ).test(sentence);
}

// ==================== 形态二扩展：发薪时点（payday）无证据断言 ====================
// badcase recviaaF780Ag2（2026-07-27 路线更新「payday 臆答」）：结算周期之外，
// "当天发薪/次日到账/每周三发工资/每月15号发"这类**发薪时点**断言同样影响候选人
// 决策；岗位数据的结算周期自由文本（"周结算, 每周三发薪"）才是唯一口径，本轮查无
// 时凭通识/其他品牌规则填空同属编造。词形刻意收窄到强发薪语义（发薪/发工资/到账/
// 结工资），不收裸"发"——"当天发你定位/次日发面试地址"是高频无害表达。
const PAYDAY_ASSERTION_PATTERNS: readonly RegExp[] = [
  /(?:当天|当日|次日|隔天|第二天)[^，。；、]{0,2}(?:发薪|发工资|结工资|发钱|到账)/u,
  /(?:工资|薪水|薪资)[^，。；、]{0,6}(?:当天|当日|次日|隔天|第二天)[^，。；、]{0,2}(?:发|结|到账)/u,
  /每(?:周|星期)[一二三四五六日天][^，。；、]{0,4}(?:发薪|发工资|到账)/u,
  /每月\s*\d{1,2}\s*[号日][^，。；、]{0,4}(?:发薪|发工资|到账|发)/u,
  /发薪日(?:是|为|定在)[^，。；、]{0,8}/u,
];

// 历史出处豁免用宽口径：往轮卡片常写"周结每周三发/每月15号发"（不带"薪"字），
// 豁免判定必须比断言判定松，否则真实出处会被自己的窄词形漏掉造成假阳。
const PAYDAY_HISTORY_HINT_PATTERN =
  /每(?:周|星期)[一二三四五六日天][^，。；、]{0,4}(?:发|到账)|(?:当天|当日|次日|隔天|第二天)[^，。；、]{0,2}(?:发|结|到账)|每月\s*\d{1,2}\s*[号日][^，。；、]{0,4}(?:发|到账)|发薪日/u;

const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * 发薪时点断言判定：复用形态二全套假阳防线（疑问句/前瞻语境/愿望复述/否定前后缀），
 * 否定窗口以命中原文为锚（payday 词形不定长，无法像 cycle 那样用枚举词构窗）。
 */
function sentenceAssertsPayday(sentence: string): string | null {
  const matched = PAYDAY_ASSERTION_PATTERNS.map((pattern) => sentence.match(pattern)?.[0]).find(
    Boolean,
  );
  if (!matched) return null;
  if (/[吗么嘛？?]|是不是|是否/u.test(sentence)) return null;
  if (PROSPECTIVE_CONTEXT_PATTERN.test(sentence)) return null;
  const escaped = matched.replace(REGEX_ESCAPE_PATTERN, '\\$&');
  if (new RegExp(`(?:${DESIRE_ECHO_PREFIX})[^，。；、]{0,6}${escaped}`, 'u').test(sentence)) {
    return null;
  }
  if (new RegExp(`${escaped}[^，。；、]{0,4}(?:${NEGATION_SUFFIX})`, 'u').test(sentence)) {
    return null;
  }
  if (
    new RegExp(
      `(?:${NEGATION_PREFIX})[^，。；、]{0,5}(?:[^，。；、]{0,4}[或、/])?[^，。；、]?${escaped}`,
      'u',
    ).test(sentence)
  ) {
    return null;
  }
  return matched;
}

/** 助手侧历史文本（含往轮岗位卡片）。候选人提问（"日结月结？"）不构成结算出处，故只取 assistant。 */
function readAssistantHistoryText(recentMessages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const message of recentMessages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'assistant' || typeof record.content !== 'string') continue;
    parts.push(record.content);
  }
  return parts.join('\n');
}

/**
 * 形态二：无证据结算断言（2026-07-27 复测双证 RT-009/RT-010，badcase psx3d3f4/831tvtl0）。
 *
 * 形态一（detectSettlementCycleMismatch）只在本轮工具**有**结算数据时对账；
 * 本轮 duliday_job_list 全部失败/查无时 truth=null 直接放行——恰好放过了
 * "查无仍自信断言「都是月结」/「日结当天发」"这类纯编造（模型用通识或
 * 其他品牌规则填空）。本形态补上这半边：
 *
 * - 触发条件：本轮调过 duliday_job_list 且**没有任何一次**返回岗位数据
 *   （全部 error / success:false / 无 markdown 与 rawData）；
 * - 出处豁免：该结算词在**助手侧历史**（往轮真实岗位卡片）出现过则不拦
 *   ——候选人自己的提问（"日结月结？"）不算出处；
 * - 断言判定复用形态一全部假阳防线（疑问句/否定前后缀/愿望复述/前瞻语境/补充结算限定）。
 *
 * 快环确定性动作（2026-07-27 架构裁定合规）：纯文本与工具结果比较，无 LLM 参与。
 */
export function detectSettlementNoEvidenceAssertion(
  replyText: string,
  toolCalls: AgentToolCall[],
  recentMessages: readonly unknown[] = [],
): RuleContradiction | null {
  const jobListCalls = toolCalls.filter((call) => call.toolName === 'duliday_job_list');
  if (jobListCalls.length === 0) return null;
  const anyProductive = jobListCalls.some((call) => {
    if (call.status === 'error' || !call.result) return false;
    const result = call.result as Record<string, unknown>;
    return typeof result.markdown === 'string' || Boolean(result.rawData);
  });
  if (anyProductive) return null; // 有数据一律走形态一的对账逻辑

  const assistantHistory = readAssistantHistoryText(recentMessages);
  for (const { cycle, pattern } of CYCLE_PATTERNS) {
    if (pattern.test(assistantHistory)) continue; // 往轮卡片出现过该结算词：出处判定豁免
    const claims = splitClaimSentences(replyText).filter((sentence) =>
      sentenceAssertsCycle(sentence, cycle),
    );
    for (const sentence of claims) {
      if (SUPPLEMENTAL_CONTEXT_PATTERN.test(sentence)) continue;
      return {
        ruleId: 'settlement_no_evidence_assertion',
        label:
          `本轮岗位查询全部失败/查无、会话历史亦无出处，回复却断言“${cycle}”` +
          '——结算周期是影响候选人决策的关键事实，禁止用通识或其他品牌规则填空',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }

  // payday 子项：发薪时点断言。历史豁免同样按"往轮助手卡片出现过发薪表述"粗粒度放行
  // （observe 期宁松勿紧，精确的时点对账留给形态一族后续扩展）。
  const historyHasPayday = PAYDAY_HISTORY_HINT_PATTERN.test(assistantHistory);
  if (!historyHasPayday) {
    for (const sentence of splitClaimSentences(replyText)) {
      if (SUPPLEMENTAL_CONTEXT_PATTERN.test(sentence)) continue;
      const payday = sentenceAssertsPayday(sentence);
      if (!payday) continue;
      return {
        ruleId: 'settlement_no_evidence_assertion',
        label:
          `本轮岗位查询全部失败/查无、会话历史亦无出处，回复却断言发薪时点“${payday}”` +
          '——发薪时间是影响候选人决策的关键事实，禁止用通识或其他品牌规则填空',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }
  return null;
}

/** 正式工资结算为主口径；培训/阶梯月补只有在回复写清范围时才能作为“月结”依据。 */
export function detectSettlementCycleMismatch(
  replyText: string,
  toolCalls: AgentToolCall[],
  focusJobId?: number,
): RuleContradiction | null {
  const truth = readSettlementGroundTruth(toolCalls, focusJobId);
  if (!truth) return null;

  for (const { cycle } of CYCLE_PATTERNS) {
    const claims = splitClaimSentences(replyText).filter((sentence) =>
      sentenceAssertsCycle(sentence, cycle),
    );
    for (const sentence of claims) {
      if (truth.primary.has(cycle)) continue;
      // 句子已把结算周期限定在阶梯/差价/培训等补充项上时一律豁免，不再要求
      // truth.supplemental 也收录该周期。本规则的risk goal 是"补充结算不能改写成整份
      // 工资的结算周期"——已显式限定范围的句子按定义没有犯这个错。
      // 2026-07-21 审计：原实现要求 supplemental 命中同一周期，而岗位数据常常根本不编码
      // 培训/阶梯方案，导致"基础日结、超 100 小时的阶梯差价月结"这类**正确且规则自己
      // 要求的**写法被判违规（规则 feedback 要求"分别说明各自如何结算"，恰恰产出这种句子）。
      if (SUPPLEMENTAL_CONTEXT_PATTERN.test(sentence)) continue;
      return {
        ruleId: 'settlement_cycle_mismatch',
        label: `回复声称“${cycle}”，但本轮岗位正式工资结算口径是“${[...truth.primary].join(
          '/',
        )}”；培训/阶梯等补充结算不能改写成整份工资的结算周期`,
        // 2026-07-27 发牌切换第一批：revise → observe（docs/architecture/
        // guardrail-chain-assessment-and-rebuild.md §2.2）。三期审计假阳率触发目录
        // 治理条款"精确率 <70% 应自动降 observe"（07-21 抽样 6/6 假阳、07-27 命中
        // 2/2 均为否定句误判）；本 PR 同时修复否定语序假阳，observe 期用守卫档案
        // 重新累计精确率，连续两周 ≥90% 方可重新申请 revise。
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }
  }
  return null;
}
