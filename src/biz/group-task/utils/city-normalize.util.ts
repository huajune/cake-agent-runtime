/**
 * 城市字符串标准化。
 *
 * 调用方（Agent 工具入参、sessionFacts、企业级群 labels）写入的城市字符串
 * 不一致——可能是 "北京" / "北京市" / "重庆" / "重庆市" / "上海市浦东新区"
 * 等任意写法。`group_resolver` 拉到的 labels 里的城市值由运营手工打的标签
 * 决定，通常是裸名（"北京" / "上海"）。
 *
 * 历史 badcase 2k2km06k / cawp805w：Agent 调 invite_to_group({city: "北京市"})
 * 与 labels 里的 "北京" 做严格相等匹配挂掉，整轮回 no_group_in_city。
 *
 * 这里只做最朴素的去后缀，不引入完整城市字典（避免维护成本）：
 * - 去除末尾 "市" / "省"
 * - 去除空白
 *
 * 跨城市的更复杂处理（如 "浦东新区" → "上海"）不在本函数范围；保持单一职责。
 */
export function normalizeCity(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input).trim();
  while (s.endsWith('市') || s.endsWith('省')) {
    s = s.slice(0, -1).trim();
  }
  return s;
}
