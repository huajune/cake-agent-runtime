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

function sentenceAssertsCycle(sentence: string, cycle: SettlementCycle): boolean {
  const pattern = CYCLE_PATTERNS.find((entry) => entry.cycle === cycle)?.pattern;
  if (!pattern?.test(sentence)) return false;
  if (/[吗么嘛？?]|是不是|是否/u.test(sentence)) return false;
  return !new RegExp(`(?:不是|并非|不按|不算)[^，。；]{0,5}${cycle}`, 'u').test(sentence);
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
      if (truth.supplemental.has(cycle) && SUPPLEMENTAL_CONTEXT_PATTERN.test(sentence)) continue;
      return {
        ruleId: 'settlement_cycle_mismatch',
        label: `回复声称“${cycle}”，但本轮岗位正式工资结算口径是“${[...truth.primary].join(
          '/',
        )}”；培训/阶梯等补充结算不能改写成整份工资的结算周期`,
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }
  return null;
}
