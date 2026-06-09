/**
 * duliday_job_list 工具内部的单字段格式化 / 文本清洗 / 空值判断辅助。
 *
 * 从 duliday-job-list.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑变更）。
 * 这一层不涉及业务语义，只做字段级文本/数值/区间格式化，render 层依赖此模块。
 */

/** 浅空值判断：null/undefined/空字符串/空数组 → false */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 更严格的空值判断：递归看对象/数组里是否有任何有效字段 */
export function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(isNonEmpty);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(isNonEmpty);
  }
  return true;
}

// ==================== 文本清洗 ====================

/** 单行文本清洗：保留原行内容，仅做噪音短语剔除（不替换换行） */
export function cleanSingleLineText(text: string): string {
  if (!text) return '';
  return text
    .replace(/辛苦跟.*?[。！？]/g, '')
    .replace(/务必.*?[。！？]/g, '')
    .replace(/手动输入/g, '')
    .replace(/！{2,}/g, '！')
    .trim();
}

/** 多行文本清洗：保留换行结构，逐行 trim，剔除首尾空行 */
export function cleanMultilineText(text: string): string {
  if (!text) return '';
  const cleaned = text
    .replace(/辛苦跟.*?[。！？]/g, '')
    .replace(/务必.*?[。！？]/g, '')
    .replace(/手动输入/g, '')
    .replace(/！{2,}/g, '！')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  const lines = cleaned.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// ==================== 投影渲染 helpers ====================

/** 把 `- **label**: value` 推入行数组；value 为空时跳过 */
export function pushField(lines: string[], label: string, value: unknown): void {
  if (value === null || value === undefined) return;
  let text: string;
  if (typeof value === 'number') {
    text = String(value);
  } else if (typeof value === 'string') {
    const cleaned = cleanSingleLineText(value);
    if (!cleaned) return;
    text = cleaned;
  } else {
    return;
  }
  lines.push(`- **${label}**: ${text}`);
}

/** 推入长文本字段，保留原始换行，多行时换行后缩进 2 格 */
export function pushLongText(lines: string[], label: string, text: unknown): void {
  if (!text || typeof text !== 'string') return;
  const cleaned = cleanMultilineText(text);
  if (!cleaned) return;
  const rawLines = cleaned.split(/\r?\n/);
  if (rawLines.length === 1) {
    lines.push(`- **${label}**: ${rawLines[0]}`);
    return;
  }
  lines.push(`- **${label}**:`);
  for (const line of rawLines) {
    lines.push(`  ${line}`);
  }
}

/** 数值整形：去掉无意义的 .0 小数 */
export function cleanNumber(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    return Number.isInteger(value) ? value : Number(value.toFixed(2));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isNaN(n)) {
      return Number.isInteger(n) ? n : Number(n.toFixed(2));
    }
    return trimmed;
  }
  return null;
}

/** 合并 value + unit：24 + 元/时 → "24 元/时" */
export function formatValueWithUnit(value: unknown, unit: unknown): string | null {
  const cleaned = cleanNumber(value);
  if (cleaned === null) return null;
  const u = hasValue(unit) ? ` ${String(unit).trim()}` : '';
  return `${cleaned}${u}`;
}

/** 合并 min/max/unit 区间：150,200,元/天 → "150-200 元/天" */
export function formatRange(min: unknown, max: unknown, unit: unknown): string | null {
  const minVal = cleanNumber(min);
  const maxVal = cleanNumber(max);
  if (minVal === null && maxVal === null) return null;
  const minStr = minVal === null ? '?' : String(minVal);
  const maxStr = maxVal === null ? '?' : String(maxVal);
  const u = hasValue(unit) ? ` ${String(unit).trim()}` : '';
  if (minStr === maxStr) return `${minStr}${u}`;
  return `${minStr}-${maxStr}${u}`;
}

/** 合并名称+ID：品牌=肯德基 + id=10005 → "肯德基 (ID: 10005)" */
export function formatNameWithId(name: unknown, id: unknown): string | null {
  if (!hasValue(name)) return null;
  if (!hasValue(id)) return String(name);
  return `${String(name).trim()} (ID: ${id})`;
}

/**
 * 剥离门店名开头的城市/省份前缀，避免向候选人展示"成都你六姐（上海莘庄龙之梦店）"
 * 这类品牌带地名 × 门店带城市的双层冗余（候选人会困惑"这家到底是成都的还是上海的"）。
 *
 * historical badcase 56tkx51y：候选人在上海，Agent 推荐"成都你六姐（上海莘庄龙之梦店）"，
 * "成都"是品牌名一部分（全国连锁），"上海"是门店所在城市前缀；同时出现让候选人困惑。
 *
 * 行为：当 storeName 以 storeCityName 或常见省/直辖市前缀开头，且去掉前缀后仍非空时，
 * 返回去前缀版本；否则原样返回。城市信息已在「城市」字段独立呈现，无需在门店名里重复。
 */
const CITY_PREFIX_STRIP_LIST = [
  '上海',
  '北京',
  '广州',
  '深圳',
  '天津',
  '重庆',
  '杭州',
  '苏州',
  '成都',
  '武汉',
  '南京',
  '西安',
  '青岛',
  '长沙',
  '合肥',
  '宁波',
  '无锡',
];

export function stripCityPrefixFromStoreName(
  storeName: string | null | undefined,
  storeCityName: string | null | undefined,
): string | null {
  if (!storeName) return storeName ?? null;
  const trimmed = String(storeName).trim();
  if (!trimmed) return trimmed;
  const candidates = new Set<string>();
  if (storeCityName) {
    const city = String(storeCityName)
      .trim()
      .replace(/[市省]$/u, '');
    if (city) candidates.add(city);
  }
  for (const c of CITY_PREFIX_STRIP_LIST) candidates.add(c);
  for (const prefix of candidates) {
    if (!prefix) continue;
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      return trimmed.slice(prefix.length).replace(/^[-·\s]+/u, '');
    }
  }
  return trimmed;
}

/** 合并时间段：两端都有 → "22:00 - 23:00"；只有一端 → "22:00 起" / "至 23:00" */
export function formatTimeRange(start: unknown, end: unknown): string {
  const s = hasValue(start) ? String(start).trim() : null;
  const e = hasValue(end) ? String(end).trim() : null;
  if (s && e) return `${s} - ${e}`;
  if (s) return `${s} 起`;
  if (e) return `至 ${e}`;
  return '';
}

/** 压缩星期列表：每周一至每周日全齐 → "每天"；否则原样以逗号分隔 */
export function compressWeekdays(days: string): string {
  if (!days) return '';
  const tokens = days
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 7) {
    const full = ['每周一', '每周二', '每周三', '每周四', '每周五', '每周六', '每周日'];
    if (full.every((d) => tokens.includes(d))) return '每天';
  }
  return tokens.join(', ');
}

/** 检测 lines 中是否含"全周强排班"信号（每天/做六休一/固定排班 等） */
export function hasFullWeekOrRigidSchedule(lines: string[]): boolean {
  const text = lines.join('\n');
  return /每天|周一至周日|做六休一|固定排班|05:00\s*-\s*23:00|早开晚结/.test(text);
}
