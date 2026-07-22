/**
 * 跨城同名"通用后缀"歧义策略（自 memory/facts/geo-mappings.ts 行为等价迁移，Phase 1）。
 *
 * 这类地名（万达广场、火车站、人民公园 …）在多个城市都有同名 POI，
 * 仅凭 LLM 通识根本无法唯一对应某城市。geocode 工具命中这条黑名单时
 * 强制 Agent 先反问候选人城市，禁止凭通识补 city。
 *
 * 与"白名单 + 通识"的分工：白名单（DISTRICT_TO_CITY / LOCATION_TO_CITY）
 * 是高置信唯一对应；本黑名单是高置信非唯一。两者之间的灰区交给
 * LLM 通识 + geocode 多候选验证。
 *
 * 维护原则：
 * - 严格的"以此结尾或完整等于"匹配，避免误伤"川沙百联购物中心"这种实际唯一的 POI
 * - 仅收录确实跨城同名 ≥3 个城市的后缀
 * - 交通站点后缀（火车站/地铁站 等）带 ≥2 字专名前缀时不视为歧义（"漕宝路地铁站"
 *   "上海火车站"的前缀本身就是专名），交给 geocode 全国搜索 + 多城三态收敛兜真歧义；
 *   连锁商业体（万达广场/天街 等）的前缀多为跨城重复的区片名，维持整体命中
 */
export const GENERIC_AMBIGUOUS_SUFFIXES = [
  // 连锁商业地产（跨城同名重灾区）
  '万达广场',
  '万象城',
  '吾悦广场',
  '银泰',
  '天街',
  '印象城',
  '砂之船',
  '大悦城',
  // 通用商业类型词
  '购物中心',
  '商场',
  '广场',
  '步行街',
  '商业街',
  '美食街',
  // 交通枢纽（带专名前缀时由 hasGenericAmbiguousSuffix 放行）
  '火车站',
  '高铁站',
  '汽车站',
  '客运站',
  '地铁站',
  // 公共设施
  '大学',
  '学院',
  '医院',
  '人民公园',
  '人民广场',
  '中心医院',
] as const;

/**
 * 交通站点类后缀。"X地铁站/X火车站"的前缀 X 是站点专名（漕宝路/虹桥），
 * 与连锁商业体的"区片名前缀"不同，专名前缀足以让高德唯一定位或暴露真歧义。
 */
const TRANSPORT_STATION_SUFFIXES: ReadonlySet<string> = new Set([
  '火车站',
  '高铁站',
  '汽车站',
  '客运站',
  '地铁站',
]);

/** 交通站点后缀放行所需的最短专名前缀字数（"南地铁站"仍视为歧义，"漕宝路地铁站"放行）。 */
const MIN_STATION_PREFIX_LENGTH = 2;

/** 站点前缀本身仍是通名的情况（"长途汽车站""中心客运站"），照旧按跨城歧义处理。 */
const GENERIC_STATION_PREFIXES: ReadonlySet<string> = new Set([
  '长途',
  '公交',
  '旅游',
  '中心',
  '汽车',
  '客运',
  '城际',
  '轨道',
  '高速',
]);

/**
 * 判定地名是否命中"通用后缀黑名单"。
 *
 * 匹配规则：完整等于 / 以后缀结尾。不做"包含"匹配，防止误伤
 * "万达广场店"" 万达广场南门" 这类本地化别称（这些通常是单点 POI）。
 *
 * 例外：交通站点后缀带 ≥2 字专名前缀（"漕宝路地铁站"）不算命中——
 * 这类名字不是跨城通名，强制反问城市会闹出"候选人报了地标还被问在哪个城市"
 * 的倒退体验；放给 geocode 全国搜索，真撞名（如"体育中心地铁站"）由
 * 多城 ambiguous 路径列清单反问。
 */
export function hasGenericAmbiguousSuffix(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return GENERIC_AMBIGUOUS_SUFFIXES.some((suffix) => {
    if (trimmed !== suffix && !trimmed.endsWith(suffix)) return false;
    if (TRANSPORT_STATION_SUFFIXES.has(suffix)) {
      const prefix = trimmed.slice(0, trimmed.length - suffix.length);
      return prefix.length < MIN_STATION_PREFIX_LENGTH || GENERIC_STATION_PREFIXES.has(prefix);
    }
    return true;
  });
}
