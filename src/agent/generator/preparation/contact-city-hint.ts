import { normalizeCityName, scanGeoSignalsFromText } from '@resolution/geo';

/**
 * 企微联系人名称（昵称 + 运营备注）里的城市线索。
 *
 * 运营常把城市追加在联系人备注里（「龙虾过敏   佛山」），候选人自己也可能把城市写进昵称。
 * 这不是候选人本人陈述，不能写进事实或硬约束；只在会话还没有任何城市事实时交给模型，
 * 用来向候选人求证所在城市，避免模型在零位置信息时凭空假设地点（2026-10-09 漕宝路 case）。
 */
export function resolveContactCityHint(
  contactName: string | undefined,
  knownCity: string | null,
): string | null {
  if (knownCity) return null;
  const normalized = contactName
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  const city = scanGeoSignalsFromText(normalized).city?.value ?? null;
  return city ? (normalizeCityName(city) ?? city) : null;
}
