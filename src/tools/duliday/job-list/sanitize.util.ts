/**
 * duliday-job-list 工具的"对外口径净化层"（Phase 1.B 数据契约层起点）。
 *
 * sponge / duliday 原始数据里夹杂内部排版编码 / 已废品牌名 / 内部短语，
 * 直接透传给 Agent 会让 Agent 把这些噪音当业务事实复述给候选人。
 * 本模块统一剥离这些噪音，让 Agent 看到的字段是"候选人友好"的对外口径。
 *
 * 设计原则：
 * - 仅剥离明显的内部噪音（数字编码 / 版本后缀 / 旧品牌名），保留品牌+门店标识本体
 * - 当工具数据源未来清洗到位时，这层退化为 no-op；理想态是 sponge API 直接清洗
 */

import { stripCityPrefixFromStoreName } from '@tools/duliday/job-list/helpers.util';

/**
 * 剥离 storeName 里"品牌-数字编码"等内部排版噪音。
 *
 * 历史 badcase 2xcajl7w：sponge 返回 "奥乐齐-1084奉贤苏宁广场"（"1084" 是
 * 海绵系统内部标题编码），Agent 把 1084 当门牌号转述给候选人，导致候选人
 * 到错门店。
 *
 * 规则（保守，只剥明显的内部编码 pattern）：
 * 1. "-数字+-" 中段：`奥乐齐-1084-奉贤苏宁广场` → `奥乐齐奉贤苏宁广场`
 * 2. "-数字+ 中文" 中段：`奥乐齐-1084奉贤苏宁广场` → `奥乐齐奉贤苏宁广场`
 * 3. 末尾 "-数字+"：`奥乐齐 1084` → `奥乐齐`
 * 4. 不动门店实名本体里的合法数字（如 "肯德基T1店"、"肯德基 24h 店"——只有 ≥3 位
 *    连续数字且紧贴 "-" / 空格分隔符才视为内部编码）
 */
export function cleanInternalStoreCode(storeName: string | null | undefined): string | null {
  if (!storeName) return storeName ?? null;
  const trimmed = String(storeName).trim();
  if (!trimmed) return trimmed;

  let cleaned = trimmed;
  // pattern 1: "品牌-数字+-门店" → "品牌门店"（中段 -数字-）
  cleaned = cleaned.replace(/-\d{3,}-/g, '');
  // pattern 2: "品牌-数字+ 中文" → "品牌 中文"（数字后直接接中文）
  cleaned = cleaned.replace(/-\d{3,}(?=[一-龥])/g, '');
  // pattern 3: 末尾 "-数字+" / " 数字+" → 剥除
  cleaned = cleaned.replace(/[-\s]\d{3,}\s*$/, '');
  // pattern 4: 兜底 trim 残留分隔符
  cleaned = cleaned.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();

  return cleaned || trimmed;
}

/**
 * 工具对外暴露的 storeName 净化入口：先剥内部编码 → 再剥城市前缀。
 *
 * 历史上 stripCityPrefixFromStoreName 是单独一道净化；本函数把"内部编码剥离"
 * 前置，避免内部编码混进城市前缀匹配（如 "奥乐齐-1084 上海莘庄..." 中 "上海"
 * 还在最前面时能命中前缀剥除）。
 */
export function normalizeStoreNameForAgent(
  storeName: string | null | undefined,
  storeCityName: string | null | undefined,
): string | null {
  const codeStripped = cleanInternalStoreCode(storeName);
  return stripCityPrefixFromStoreName(codeStripped, storeCityName);
}
