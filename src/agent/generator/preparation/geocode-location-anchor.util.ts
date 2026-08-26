import { isHumanAgentTextMessage } from '@biz/message/utils/message-provenance.util';
import { produceTurnHints } from '@resolution/evidence/producers/rule-track';
import { projectTurnHints } from '@resolution/evidence/merge';
import type { TurnHints } from '@resolution/evidence/claim.types';
import { resolveCityFromDistrict } from '@resolution/geo';
import type { ShortTermMessage } from '@memory/short-term/short-term.types';
import type { CityFact, EntityExtractionResult } from '@memory/short-term/short-term.types';
import type { GeocodeLocationAnchor } from '@shared-types/turn.types';
import { stripTimeContext } from '@resolution/signal/markers';

const LOCATION_CONTINUATION_PATTERN =
  /(?:附近|周边|旁边|周围|这边|那边|这里|那里|近一点|近点|离这|离那)/;

interface ResolveGeocodeLocationAnchorInput {
  currentUserMessage?: string;
  shortTermMessages: ShortTermMessage[];
  currentFacts?: TurnHints | null;
  sessionFacts?: EntityExtractionResult | null;
}

function cityValue(city: CityFact | string | null | undefined): string | undefined {
  if (!city) return undefined;
  return typeof city === 'string' ? city : city.value;
}

/** 剥时间标记后 trim（标记形态见 @resolution/signal/markers）。 */
function stripTimeMarkers(content: string): string {
  return stripTimeContext(content).trim();
}

function toAnchor(
  facts: EntityExtractionResult | null | undefined,
  source: GeocodeLocationAnchor['source'],
  evidence: string,
  referenceText?: string,
): GeocodeLocationAnchor | null {
  if (!facts) return null;

  const rawDistricts = Array.from(
    new Set((facts.preferences.district ?? []).map((item) => item.trim()).filter(Boolean)),
  );
  // 多区意向不能作为单点“附近”锚点；保留城市级约束即可。
  const districts = rawDistricts.length === 1 ? rawDistricts : [];
  const city = cityValue(facts.preferences.city) ?? resolveCityFromDistrict(districts[0] ?? '');
  if (!city && districts.length === 0) return null;

  return {
    city,
    districts,
    source,
    referenceText,
    evidence: evidence.slice(0, 200),
  };
}

function anchorFromTurnHints(
  facts: TurnHints | null | undefined,
  source: GeocodeLocationAnchor['source'],
  evidence: string,
  referenceText?: string,
): GeocodeLocationAnchor | null {
  return toAnchor(
    projectTurnHints(facts, { minConfidence: 'high' }),
    source,
    evidence,
    referenceText,
  );
}

/**
 * 解析本轮 geocode 的可信位置锚点。
 *
 * 优先级：当前候选人高置信位置 > “附近/这边”回指的最近人工消息 > 高置信会话事实。
 * 非回指消息不使用历史锚点，避免候选人已经换地点却被旧区县拉回。
 */
export function resolveGeocodeLocationAnchor(
  input: ResolveGeocodeLocationAnchorInput,
): GeocodeLocationAnchor | undefined {
  const currentAnchor = anchorFromTurnHints(
    input.currentFacts,
    'current_user',
    `当前候选人消息：${input.currentUserMessage ?? ''}`,
    input.currentUserMessage,
  );
  if (currentAnchor) return currentAnchor;

  const current = input.currentUserMessage?.trim() ?? '';
  if (!LOCATION_CONTINUATION_PATTERN.test(current)) return undefined;

  // 跳过本轮末尾连续 user 块，只在紧邻的上一段 assistant turn 中寻找真人手动消息。
  let index = input.shortTermMessages.length - 1;
  while (index >= 0 && input.shortTermMessages[index].role === 'user') index -= 1;
  while (index >= 0 && input.shortTermMessages[index].role === 'assistant') {
    const message = input.shortTermMessages[index];
    // 不跨过 Agent/自动 assistant 往更早找人工锚点；当前 user 默认回指最近一轮回复。
    if (!isHumanAgentTextMessage(message)) break;
    const text = stripTimeMarkers(message.content);
    const manualAnchor = anchorFromTurnHints(
      produceTurnHints([text], []),
      'human_agent',
      `人工招募经理消息：${text}`,
      text,
    );
    if (manualAnchor) return manualAnchor;
    index -= 1;
  }

  const sessionReference = [
    cityValue(input.sessionFacts?.preferences.city),
    ...(input.sessionFacts?.preferences.district ?? []),
    ...(input.sessionFacts?.preferences.location ?? []),
  ]
    .filter(Boolean)
    .join('');
  return (
    toAnchor(
      input.sessionFacts,
      'session_memory',
      '高置信会话位置事实',
      sessionReference || undefined,
    ) ?? undefined
  );
}
