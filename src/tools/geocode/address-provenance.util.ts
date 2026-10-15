import { normalizeDistrictForLookup, scanGeoSignalsFromText } from '@resolution/geo';
import { normalizeCitationText, normalizedIncludes } from '@resolution/notary/text-normalization';
import {
  extractDialogueTurns,
  isAffirmativeAnswer,
  normalizeShortAnswer,
} from '@resolution/signal/dialogue';

/**
 * geocode.address 的出处判定（纯函数，shadow 观测）。
 *
 * 坐标与城市都不能信任模型转抄（docs/architecture/geo-resolution.md §7），地址同理：
 * 2026-10-09 模型凭工具教学示例虚构「你还是在漕宝路这边吗」，次轮又以自己的回复为据
 * geocode「漕宝路」，结果被确权成已确认上海。这里判定地址是否能追溯到外生出处：
 * 候选人原话（含位置分享）、真人招募经理消息、本轮工具结果 / 焦点岗位门店，或
 * 「助手问 + 候选人紧接着肯定答复」。只做逐字公证（封闭形态），不解释语义。
 *
 * 当前只记录判定、不改变工具行为：离线估算显示合理调用的地址常经模型规范化
 * （「方圆」→「方圆LIVE」）或来自门店结果，先用生产数据校准误拒率再决定是否拦截。
 */

export type GeocodeAddressProvenanceSource =
  | 'candidate_text'
  | 'human_agent'
  | 'tool_result'
  | 'dialogue_confirmation';

export interface GeocodeAddressProvenance {
  verdict: 'attested' | 'unattested';
  matchedBy: GeocodeAddressProvenanceSource | null;
  /** 去掉开头行政区与结尾方位/站名后的核心地名，排障与校准用。 */
  core: string;
  /** 未找到外生出处、但核心地名出现在我方（Agent 自动发送）消息里：疑似自说自证。 */
  assistantOnly: boolean;
}

export interface GeocodeAddressProvenanceInput {
  address: string;
  /** 候选人原话（已剥引用块），含位置分享渲染文本。 */
  candidateTexts: readonly string[];
  /** 真人招募经理手动发送的消息正文（已去来源标记）。 */
  humanAgentTexts: readonly string[];
  /** Agent 自动发送的消息正文；只用于标记 assistantOnly，不构成出处。 */
  assistantTexts: readonly string[];
  /** 本轮工具结果与焦点岗位门店名/地址等确定性数据文本。 */
  toolResultTexts: readonly string[];
  /** 证据域 user/assistant 对话，用于识别「助手问 + 候选人肯定」。 */
  dialogueMessages: readonly unknown[];
}

const TRAILING_FILLER_PATTERN = /(?:附近|周边|周围|一带|这边|那边|这块|那块|这里|那里)$/u;
const TRAILING_STATION_PATTERN = /(?:地铁站|火车站|高铁站|站)$/u;
const LEADING_ADMIN_PATTERN =
  /^(?:[一-龥]{2,6}?(?:省|自治区|自治州|特别行政区)|[一-龥]{2,6}?市|[一-龥]{1,6}?(?:新区|开发区|区|县|镇|乡|街道))/u;
const ADMIN_NAME_PATTERN = /(?:区|县|镇|乡|街道)$/u;
const QUESTION_TONE_PATTERN = /(?:吗|么|吧|呢|对不对|是不是|[？?])/u;
const MIN_MATCH_LENGTH = 2;

export function evaluateGeocodeAddressProvenance(
  input: GeocodeAddressProvenanceInput,
): GeocodeAddressProvenance {
  const variants = buildAddressVariants(input.address);
  const core = variants.core;
  const keys = variants.all;

  if (keys.length === 0) {
    return { verdict: 'unattested', matchedBy: null, core, assistantOnly: false };
  }

  const sources: Array<[GeocodeAddressProvenanceSource, readonly string[]]> = [
    ['candidate_text', input.candidateTexts],
    ['human_agent', input.humanAgentTexts],
    ['tool_result', input.toolResultTexts],
  ];
  for (const [source, texts] of sources) {
    if (texts.some((text) => textAttestsAddress(text, keys, core))) {
      return { verdict: 'attested', matchedBy: source, core, assistantOnly: false };
    }
  }

  if (isConfirmedByCandidate(keys, input.dialogueMessages)) {
    return { verdict: 'attested', matchedBy: 'dialogue_confirmation', core, assistantOnly: false };
  }

  const assistantOnly = input.assistantTexts.some((text) =>
    keys.some((key) => normalizedIncludes(text, key)),
  );
  return { verdict: 'unattested', matchedBy: null, core, assistantOnly };
}

/** 生成可接受的地址写法：原文 / 去方位词 / 去站名 / 去开头行政区的核心 / 纯行政区词干。 */
function buildAddressVariants(address: string): { core: string; all: string[] } {
  const full = normalizeCitationText(address);
  const withoutFiller = full.replace(TRAILING_FILLER_PATTERN, '');
  const withoutStation = withoutFiller.replace(TRAILING_STATION_PATTERN, '');
  const core = stripLeadingAdministrativeNames(withoutFiller);
  const coreWithoutStation = core.replace(TRAILING_STATION_PATTERN, '');
  const adminStem = ADMIN_NAME_PATTERN.test(withoutFiller)
    ? normalizeDistrictForLookup(withoutFiller)
    : '';
  const all = Array.from(
    new Set([full, withoutFiller, withoutStation, core, coreWithoutStation, adminStem]),
  ).filter((value) => value.length >= MIN_MATCH_LENGTH);
  return { core, all };
}

/**
 * 去掉开头连续的行政区写法（「北京昌平马池口」→「马池口」、「深圳地铁13号线」→「地铁13号线」）。
 * 行政区名本身是位置上下文，候选人常分开说；真正需要外生出处的是剩下的具体地点。
 * 剥完不足 2 字时保留原值（地址本身就是行政区名）。
 */
function stripLeadingAdministrativeNames(text: string): string {
  let rest = text;
  for (let i = 0; i < 4 && rest.length > MIN_MATCH_LENGTH; i += 1) {
    const scan = scanGeoSignalsFromText(rest);
    const leadingHit = [...scan.cityHits, ...scan.districtHits].find((hit) => hit.start === 0);
    let next = leadingHit ? rest.slice(leadingHit.end) : rest;
    if (next === rest) next = rest.replace(LEADING_ADMIN_PATTERN, '');
    next = next.replace(/^(?:市|区|县|镇|街道)/u, '');
    if (next === rest || next.length < MIN_MATCH_LENGTH) break;
    rest = next;
  }
  return rest;
}

function textAttestsAddress(text: string, keys: readonly string[], core: string): boolean {
  if (keys.some((key) => normalizedIncludes(text, key))) return true;
  // 模型常把候选人的说法规范成标准 POI 名（「方圆」→「方圆LIVE」、
  // 「常州大学西太湖郊」→「常州大学西太湖校区」）：核心地名的开头 2 字逐字出现即算承接。
  return (
    core.length > MIN_MATCH_LENGTH && normalizedIncludes(text, core.slice(0, MIN_MATCH_LENGTH))
  );
}

/** 「助手带求证语气提到该地点 + 候选人紧接着肯定答复」。 */
function isConfirmedByCandidate(keys: readonly string[], messages: readonly unknown[]): boolean {
  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role !== 'assistant' || !QUESTION_TONE_PATTERN.test(turn.text)) continue;
    if (!keys.some((key) => normalizedIncludes(turn.text, key))) continue;
    const answer = turns.slice(i + 1).find((next) => next.role === 'user');
    if (answer && isAffirmativeAnswer(normalizeShortAnswer(answer.text))) return true;
  }
  return false;
}
