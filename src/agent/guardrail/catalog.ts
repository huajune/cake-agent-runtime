/**
 * Guardrail 统一目录（可审计登记表）。
 *
 * 治理价值（§2.5）：逐条审计"每个 guardrail 带不带**新外生信号**"——只读同样信息再想
 * 一遍的 reviewer 在决策论上被中心化决策者支配，堆多了准确率反而崩。这里把现有/规划中的
 * guardrail 登记成一张表，`exogenousSignal` 字段是审计抓手；`source` 标注物理位置
 * （tool guardrail 因分层物理留 tools/，仅在此登记引用，不反向依赖 agent）。
 *
 * 注意：本目录是**聚合后的登记/审计视图**，不在此执行 guardrail（执行仍在各自的
 * in-loop / 出站调用点）。output/tool 的详细目录分别由各自子域维护，本文件只派生汇总，
 * 避免同一个 rule id 在多处手写后漂移。
 */

import { GUARDRAIL_LAYER, type GuardrailLayer } from '@shared-types/guardrail.contract';
import { OUTPUT_RULE_CATALOG } from './output/rules/output-rule-catalog';
import { TOOL_GUARDRAIL_CATALOG } from './tool/tool-guardrail.catalog';

export interface GuardrailCatalogEntry {
  /** 稳定 id（rule id / service 名）。 */
  id: string;
  layer: GuardrailLayer;
  /** 面向运营/审计/文档的人读中文说明。 */
  description: string;
  /** 物理位置（文件/服务）。 */
  source: string;
  /** 该 guardrail 对齐/带入的"新外生信号"——审计核心字段。 */
  exogenousSignal: string;
  status: 'active' | 'planned';
}

const INPUT_GUARDRAIL_CATALOG = [
  {
    id: 'input_prompt_injection',
    layer: GUARDRAIL_LAYER.INPUT,
    description: '识别候选人输入中的提示注入、越权指令或试图操控系统行为的文本。',
    source: 'agent/guardrail/input/input-guard.service.ts',
    exogenousSignal: 'prompt-injection 模式库（外生检测器）',
    status: 'active',
  },
  {
    id: 'pre_agent_risk_intercept',
    layer: GUARDRAIL_LAYER.INPUT,
    description: '在 Agent 生成前拦截辱骂、投诉风险、面试结果追问等需要人工介入的入站风险。',
    source: 'agent/guardrail/input/risk/risk-intercept.service.ts',
    exogenousSignal: 'conversation-risk 高危关键词信号',
    status: 'active',
  },
] as const satisfies readonly GuardrailCatalogEntry[];

const OUTPUT_GUARDRAIL_CATALOG = OUTPUT_RULE_CATALOG.map(
  (rule): GuardrailCatalogEntry => ({
    id: rule.id,
    layer: GUARDRAIL_LAYER.OUTPUT,
    description: rule.description,
    source: 'agent/guardrail/output/hard-rules.service.ts + agent/guardrail/output/rules/*.rule.ts',
    exogenousSignal: rule.exogenousSignal,
    status: 'active',
  }),
);

const TOOL_GUARDRAIL_CATALOG_ENTRIES = TOOL_GUARDRAIL_CATALOG.map(
  (entry): GuardrailCatalogEntry => ({
    id: entry.id,
    layer: GUARDRAIL_LAYER.TOOL,
    description: entry.description,
    source: entry.source,
    exogenousSignal: entry.exogenousSignal,
    status: entry.status,
  }),
);

const OUTPUT_LLM_GUARDRAIL_CATALOG = [
  {
    id: 'output_semantic_reviewer',
    layer: GUARDRAIL_LAYER.OUTPUT,
    description:
      '出站 llm 档唯一语义 reviewer：基于证据包审查岗位推荐、地理品牌歧义、预约状态三类问题；' +
      'enforce flag 开启时参与裁决（低置信强制降级 observe），shadow flag 开启时只观测。',
    source:
      'agent/guardrail/output/llm/semantic-reviewer.service.ts + agent/guardrail/output/llm/review-packet.builder.ts',
    exogenousSignal: 'jobList/precheck/booking/geocode 工具证据包 + 候选人本轮消息',
    status: 'active',
  },
  {
    id: 'output_repair_writer_mode',
    layer: GUARDRAIL_LAYER.OUTPUT,
    description:
      '在 output guardrail rewrite 修复时注入受控 Repair Writer 指令，只按规则反馈改写上一版回复。',
    source: 'agent/runner/agent-runner.service.ts + agent/agent-preparation.service.ts',
    exogenousSignal: 'output rule violations + feedbackToGenerator + 已提交副作用摘要',
    status: 'active',
  },
] as const satisfies readonly GuardrailCatalogEntry[];

export const GUARDRAIL_CATALOG: readonly GuardrailCatalogEntry[] = [
  ...INPUT_GUARDRAIL_CATALOG,
  ...TOOL_GUARDRAIL_CATALOG_ENTRIES,
  ...OUTPUT_GUARDRAIL_CATALOG,
  ...OUTPUT_LLM_GUARDRAIL_CATALOG,
];

/** 按层取 catalog 条目（审计/测试用）。 */
export function catalogByLayer(layer: GuardrailLayer): GuardrailCatalogEntry[] {
  return GUARDRAIL_CATALOG.filter((entry) => entry.layer === layer);
}
