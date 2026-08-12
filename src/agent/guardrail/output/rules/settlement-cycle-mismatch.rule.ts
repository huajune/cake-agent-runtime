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

// 话题指代：「关于日结的问题」「你问的日结」是在点名话题，不是对岗位断言结算周期。
// 2026-08-04 审计假阳 ×2（`…_1785472764565`"关于日结的问题…所以结算方式暂时也没法确认"
// 整段本就合规，rewrite 压成"好的，那你先忙"信息全丢；`…_1785487619837` 同形态 fail-open）。
// 判定前把该片段从句子里剥掉再跑全部检查——只剥指代片段而非豁免整句，
// 保证"关于日结的问题，这家就是日结的"里的真断言仍被捕获。
const TOPIC_REFERENCE_PATTERN =
  /(?:关于|至于|说到|你(?:说|问|提)的)[^，。；、]{0,4}(?:当日结|当天结|按周结|按月结|日结|周结|月结|次月)(?:的问题|的事|方面)?/gu;

function sentenceAssertsCycle(rawSentence: string, cycle: SettlementCycle): boolean {
  const sentence = rawSentence.replace(TOPIC_REFERENCE_PATTERN, '');
  const pattern = CYCLE_PATTERNS.find((entry) => entry.cycle === cycle)?.pattern;
  if (!pattern?.test(sentence)) return false;
  if (/[吗么嘛？?]|是不是|是否/u.test(sentence)) return false;
  if (PROSPECTIVE_CONTEXT_PATTERN.test(sentence)) return false;
  if (new RegExp(`(?:${DESIRE_ECHO_PREFIX})[^，。；、]{0,6}${cycle}`, 'u').test(sentence)) {
    return false;
  }
  // 后缀否定窗口 4→16：仍禁跨逗号/顿号（子句边界），但允许同子句内隔着修饰语的否定
  // （2026-08-04 审计假阳 `…_1785400091574`"肯德基的日结兼职在你附近暂时没找到在招的"
  // ——「日结」到「没找到」隔 8 字，旧窗口跨不过去，把候选人的诉求词判成断言）。
  if (new RegExp(`${cycle}[^，。；、]{0,16}(?:${NEGATION_SUFFIX})`, 'u').test(sentence)) {
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
        // guardrail-quality-system.md §2.2）。三期审计假阳率触发目录
        // 治理条款"精确率 <70% 应自动降 observe"（07-21 抽样 6/6 假阳、07-27 命中
        // 2/2 均为否定句误判）；本 PR 同时修复否定语序假阳，observe 期用守卫档案
        // 重新累计精确率，连续两周 ≥90% 方可重新申请 revise。
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }
  }
  return null;
}
