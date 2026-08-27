/**
 * 适配器路由：契约字段 → 写入适配器。
 *
 * 识别顺序（蓝图 §1，D4 纪律）：
 * 1. **身份语义标记** `systemField` —— 映射层按环境级 labelId 锚点 + 标题核验产出
 *    （contract-mapping.ts；原「契约带 systemField」诉求 0826 已废弃）；
 * 2. **标题语义族** —— 用标题词面判定字段族（健康证族/学历族…）。生产实测配置卫生病
 *    在标签系统内复发：学生/学信网语义分裂为 12 个 labelId（582/660/728/735/605/609/
 *    565/554/750/671/703/175），多为 TEXT 且标题里携带筛选指令。按 ID 精确表必漏，
 *    按标题语义族才兜得住；
 * 3. **fieldType 通用道** —— 上面都不认的走通用道（选项型走 optionLabel 直配，
 *    TEXT 型交模型作证），并记一条 configDebt。
 *
 * ⚠️ **代码里没有一个 labelId 字面量**（D4，0818 用户裁定）。确需 ID 锚点的加速表
 * 走环境级配置 + 每轮实时契约核验 labelTitle，核验不过告警并降通用道——测试与生产
 * 环境 ID 可能不同是硬约束。本文件当前不需要任何 ID 锚点。
 */

import { matchOptionInText } from '../option-matching';
import type { ContractFieldDef } from '../form.types';
import { proposeEducation } from './education.adapter';
import { proposeHealthCertificate } from './health-certificate.adapter';
import { proposeIdentityCore } from './identity-core.adapter';
import { proposeIdentityStatus } from './identity-status.adapter';
import { proposeSocialInsurance } from './social-insurance.adapter';
import type { AdapterInput, SlotAdapter, SlotProposal } from './adapter.types';

/** 标题语义族判据（词面判定，不认 ID）。 */
const TITLE_FAMILIES: ReadonlyArray<{ test: RegExp; adapter: SlotAdapter }> = [
  { test: /健康证/u, adapter: proposeHealthCertificate },
  { test: /学历|最高学历|文化程度/u, adapter: proposeEducation },
  // 身份族排在学历之后：学历标题不含"学生"，不会互相截胡；反过来
  //「是否学生」若排在学历前会先命中身份族，正确。
  { test: /社会身份|是否学生|学生|学信网|在籍|身份/u, adapter: proposeIdentityStatus },
  // 社保族排在身份族之后：「社保缴纳情况」标题不含身份词，不会互相截胡。
  { test: /社保/u, adapter: proposeSocialInsurance },
];

/**
 * 通用道：选项型字段用 optionLabel 逐字直配；TEXT / FILE 型不产确定性提案
 * （自由文本的值边界由模型作证给出，产物仍过公证）。
 */
export const genericAdapter: SlotAdapter = (input: AdapterInput): SlotProposal | null => {
  const { field, candidateText } = input;
  if (field.fieldType !== 'SINGLE_OPTION' && field.fieldType !== 'MULTIPLE_OPTION') return null;
  const matched = matchOptionInText(field, candidateText);
  if (!matched) return null;
  return {
    labelId: field.labelId,
    value: matched.option.optionLabel,
    optionCodes: [matched.option.optionCode],
    sourceText: matched.sourceText,
    producer: 'candidate_quote',
  };
};

export type AdapterRoute = 'identity_core' | 'title_family' | 'generic';

/** 该字段由哪条道承接。通用道意味着"没有专用判据"，调用方据此记 configDebt。 */
export function routeOf(field: ContractFieldDef): AdapterRoute {
  if (field.systemField) return 'identity_core';
  if (TITLE_FAMILIES.some((family) => family.test.test(field.labelTitle))) return 'title_family';
  return 'generic';
}

/** 取该字段的写入适配器。永远返回一个可调用的适配器，最差是通用道。 */
export function adapterFor(field: ContractFieldDef): SlotAdapter {
  if (field.systemField) return proposeIdentityCore;
  const family = TITLE_FAMILIES.find((item) => item.test.test(field.labelTitle));
  return family ? family.adapter : genericAdapter;
}

/** 便捷入口：按契约字段解析本轮候选人原话，产出未公证的值提案。 */
export function proposeForField(input: AdapterInput): SlotProposal | null {
  return adapterFor(input.field)(input);
}
