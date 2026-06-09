/**
 * 把岗位 workTime 数据归一化成"含语义"的班次描述文本。
 *
 * 输出包含 4 个维度（按需展示）：
 * 1) 时段标签（早班/午高峰短班/晚班/夜班...）— 由 startTime 启发式映射
 * 2) 选择关系（可选其一/必须全做/按星期排班/候选人自定义/按门店排）— 由数据形态推断
 * 3) 工时长度（约 X 小时 / 短班）— 由 endTime - startTime 计算（处理跨午夜）
 * 4) 星期约束（周一至周五 / 周末 / 全周）— 由 combinedArrangement.weekdays
 *
 * 约定：
 * - 数据完全无具体时段（仅有 monthWorkTime / dayWorkTime / 弹性 / 营业时段范围）→ 返回 null
 * - 调用方按 null 选择"不显示该字段"，不补 fallback 文案
 */

interface ShiftSlot {
  start: string; // HH:MM
  end: string; // HH:MM
  weekdays?: string; // 海绵2.0 新结构 combinedArrangement 已不带星期，保留字段供格式化层兼容
}

/**
 * 海绵2.0 岗位 workTime 结构（dayWorkTime + weekAndMonthWorkTime）。
 *
 * 旧结构（dailyShiftSchedule / weekWorkTime / monthWorkTime / fixedScheduleList）已废弃，
 * 由网关迁移后统一返回本结构。
 */
interface WorkTimeInput {
  dayWorkTime?: DayWorkTimeInput;
  weekAndMonthWorkTime?: WeekAndMonthWorkTimeInput;
}

interface DayWorkTimeInput {
  /** 排班类型描述：满足其中一个时段即可安排上岗(固定) / 满足所有时段才可安排上岗(组合) / 灵活排班 */
  arrangementType?: unknown;
  /** 固定/组合排班的多时段；灵活排班通常为 null */
  combinedArrangement?: CombinedArrangementInput[];
  /** 灵活排班的上下班区间 + 每日最少工时 + 班次名 */
  fixedTime?: FixedTimeInput;
}

interface CombinedArrangementInput {
  combinedArrangementStartTime?: unknown;
  combinedArrangementEndTime?: unknown;
}

interface FixedTimeInput {
  perDayMinWorkHours?: unknown;
  shiftCodes?: unknown;
  goToWorkStartTime?: unknown;
  goOffWorkEndTime?: unknown;
  goOffWorkTimeType?: unknown; // 当日 / 次日
}

interface WeekAndMonthWorkTimeInput {
  perMonthMinWorkTime?: unknown;
  perWeekWorkDays?: unknown;
}

/** 主入口：从 workTime 产出可对外展示的班次文案。null = 没有具体班次。 */
export function composeShiftTimeText(workTime: unknown): string | null {
  if (!isNonEmpty(workTime)) return null;
  const input = workTime as WorkTimeInput;

  const slots = collectShiftSlots(input);
  if (slots.length === 0) {
    // 灵活排班且无可用时段 → 弹性概要；其余无具体班次数据 → null（调用方不显示该字段）
    if (looksLikeFlexibleArrangement(input)) return composeFlexibleSummary(input);
    return null;
  }

  const flexible = looksLikeFlexibleArrangement(input);
  const dayMin = dayMinHours(input);

  // 单条宽跨度时段通常是"排班窗口"而非真实班次时长。用 perDayMinWorkHours 描述实际
  // 每日出勤时长，避免把窗口跨度（如 15h）输出成"全天班，约 15 小时"误导 LLM
  // （badcase：候选人问"做一整天吗"，LLM 看到 15h 后反而补"4-8 小时"，造成空头承诺）。
  // 灵活排班的 fixedTime 区间天然是窗口，跨度比最少工时大 ≥2h 即按窗口呈现。
  if (slots.length === 1) {
    const slotHours = durationMinutes(slots[0].start, slots[0].end) / 60;
    if (
      dayMin !== null &&
      dayMin > 0 &&
      dayMin < slotHours &&
      (slotHours >= 12 || (flexible && slotHours - dayMin >= 2))
    ) {
      return formatWindowSlot(slots[0], dayMin);
    }
  }

  const mode = inferSelectionMode(input, slots);
  return formatSlots(slots, mode);
}

/**
 * 排班窗口格式：API 只记了一条宽跨度时段（如 07:00-22:00），
 * 实际排班在窗口内进行，每日最少工时由 perDayMinWorkHours 决定。
 * 输出示例："07:00-22:00 排班窗口（每日至少 10 小时）"
 */
function formatWindowSlot(slot: ShiftSlot, dayMin: number): string {
  const range = formatTimeRange(slot.start, slot.end);
  return `${range} 排班窗口（每日至少 ${dayMin} 小时）`;
}

/** 海绵2.0 排班类型字符串（满足其中一个.../满足所有.../灵活排班）。 */
function arrangementTypeOf(workTime: WorkTimeInput): string {
  const t = workTime?.dayWorkTime?.arrangementType;
  return typeof t === 'string' ? t : '';
}

/** 每日最少工时（海绵2.0 落在 dayWorkTime.fixedTime.perDayMinWorkHours，可能为字符串）。 */
function dayMinHours(workTime: WorkTimeInput): number | null {
  return numberOf(workTime?.dayWorkTime?.fixedTime?.perDayMinWorkHours);
}

/**
 * 收集候选 slot：
 * - 固定/组合排班 → dayWorkTime.combinedArrangement[] 多时段
 * - 灵活排班 → dayWorkTime.fixedTime 的上下班区间（单时段，含跨次日）
 */
function collectShiftSlots(workTime: WorkTimeInput): ShiftSlot[] {
  const day = workTime?.dayWorkTime;
  if (!day) return [];

  // 1) combinedArrangement: 固定/组合排班的多时段（新结构不再带星期）
  const combined = Array.isArray(day.combinedArrangement) ? day.combinedArrangement : [];
  const fromCombined: ShiftSlot[] = combined
    .map((ca) => ({
      start: normalizeHm(ca?.combinedArrangementStartTime),
      end: normalizeHm(ca?.combinedArrangementEndTime),
    }))
    .filter((s: ShiftSlot) => isValidSlot(s));
  if (fromCombined.length > 0) return fromCombined;

  // 2) fixedTime: 灵活排班的上下班区间 → 单时段（goToWorkStartTime~goOffWorkEndTime）
  const ft = day.fixedTime;
  if (!ft) return [];
  const slot: ShiftSlot = {
    start: normalizeHm(ft.goToWorkStartTime),
    end: normalizeHm(ft.goOffWorkEndTime),
  };
  return isValidSlot(slot) ? [slot] : [];
}

/** 选择关系：由 arrangementType + perDayMinWorkHours 推断。 */
type SelectionMode = 'single' | 'pick_one' | 'by_weekday' | 'all_required';

function inferSelectionMode(workTime: WorkTimeInput, slots: ShiftSlot[]): SelectionMode {
  if (slots.length === 1) return 'single';

  // arrangementType="满足所有时段才可安排上岗"（组合排班制）→ 全部需出勤
  if (/所有/.test(arrangementTypeOf(workTime))) return 'all_required';

  // 兜底：perDayMinWorkHours 超过任意单段时长，说明单选一段不足以满足最低工时，
  // 所有班次都必须出勤（典型：两段各 2h + perDayMinWorkHours=4 → 全部都要做）。
  const dayMin = dayMinHours(workTime);
  if (dayMin !== null && dayMin > 0) {
    const maxSingleSlotHours = Math.max(...slots.map((s) => durationMinutes(s.start, s.end))) / 60;
    if (dayMin > maxSingleSlotHours) return 'all_required';
  }

  // "满足其中一个时段即可安排上岗"（固定排班制）默认语义=候选人选其一。
  return 'pick_one';
}

/**
 * 灵活排班识别 — arrangementType 含"灵活/弹性"。
 *
 * 海绵2.0 已知 arrangementType 取值：
 * - '满足其中一个时段即可安排上岗'（固定排班制）
 * - '满足所有时段才可安排上岗'（组合排班制）
 * - '灵活排班'
 * 只有"灵活排班"在缺少具体 fixedTime 时段时才回退到弹性概要。
 */
function looksLikeFlexibleArrangement(workTime: WorkTimeInput): boolean {
  return /弹性|灵活/.test(arrangementTypeOf(workTime));
}

function composeFlexibleSummary(workTime: WorkTimeInput): string | null {
  const wm = workTime?.weekAndMonthWorkTime;
  const monthMin = numberOf(wm?.perMonthMinWorkTime);
  const dayMin = dayMinHours(workTime);
  const parts: string[] = ['弹性排班，按门店实际安排'];
  if (monthMin) parts.push(`每月最少 ${monthMin} 小时`);
  if (dayMin) parts.push(`每天最少 ${dayMin} 小时`);
  return parts.join('；');
}

// ==================== 输出组装 ====================

function formatSlots(slots: ShiftSlot[], mode: SelectionMode): string {
  if (mode === 'single') {
    const s = slots[0];
    return formatSingleSlotLine(s);
  }

  const lines = slots.map((s) => `- ${formatSingleSlotLine(s)}`);

  if (mode === 'by_weekday') {
    // weekdays 已包含在每行里，不需要选择关系前缀
    if (slots.length === 1) return lines[0].replace(/^-\s*/, '');
    return lines.join('\n');
  }

  if (mode === 'all_required') {
    return `组合班次，全部需出勤：\n${lines.join('\n')}`;
  }

  return `班次可选其一：\n${lines.join('\n')}`;
}

function formatSingleSlotLine(slot: ShiftSlot): string {
  const label = classifyShiftLabel(slot.start, slot.end);
  const range = formatTimeRange(slot.start, slot.end);
  const hours = formatDurationHint(slot.start, slot.end);
  const weekdayPrefix = slot.weekdays ? `${formatWeekdays(slot.weekdays)} ` : '';
  const labelSuffix = label
    ? `（${label}${hours ? '，' + hours : ''}）`
    : hours
      ? `（${hours}）`
      : '';
  return `${weekdayPrefix}${range}${labelSuffix}`;
}

function formatTimeRange(start: string, end: string): string {
  if (crossesMidnight(start, end)) return `${start}-次日 ${end}`;
  return `${start}-${end}`;
}

function formatDurationHint(start: string, end: string): string {
  const minutes = durationMinutes(start, end);
  if (minutes <= 0) return '';
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (hours <= 3) return `短班，约 ${hours} 小时`;
  // 跨度 ≥12h 不可能是连续工时（人一天上不了 16-19 小时），必是营业/排班窗口。
  // 此前误输出"全天班约19小时"，候选人以为要连上一整天而流失
  // （badcase recvkHHRbA0toe 05:00-次日00:00、recvkjGiU7oSL9 05:00-23:00）。
  if (hours >= 12) return `排班窗口，实际每日工时按门店排班`;
  if (hours >= 9) return `全天班，约 ${hours} 小时`;
  return `约 ${hours} 小时`;
}

// ==================== 时段标签启发式 ====================

/** 由 startTime + 时长推断时段标签。 */
function classifyShiftLabel(start: string, end: string): string | null {
  const sh = parseHm(start);
  if (!sh) return null;
  const minutes = durationMinutes(start, end);
  const isShort = minutes > 0 && minutes <= 180;
  const startHour = sh.h + sh.m / 60;

  if (startHour >= 22 || startHour < 4) return '夜班';
  if (startHour >= 4 && startHour < 8) return '早班';
  if (startHour >= 8 && startHour < 11) return '上午班';
  if (startHour >= 11 && startHour < 13.5) {
    if (isShort) return '午高峰短班';
    return '中班';
  }
  if (startHour >= 13.5 && startHour < 17) return '下午班';
  if (startHour >= 17 && startHour < 22) return '晚班';
  return null;
}

// ==================== 星期格式化 ====================

const WEEKDAY_ORDER = ['每周一', '每周二', '每周三', '每周四', '每周五', '每周六', '每周日'];
const WEEKDAY_LABEL: Record<string, string> = {
  每周一: '周一',
  每周二: '周二',
  每周三: '周三',
  每周四: '周四',
  每周五: '周五',
  每周六: '周六',
  每周日: '周日',
};

function formatWeekdays(raw: string): string {
  const tokens = raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return '';
  if (tokens.length === 7 && WEEKDAY_ORDER.every((d) => tokens.includes(d))) return '每天';

  // 周一至周五
  const weekdays = ['每周一', '每周二', '每周三', '每周四', '每周五'];
  const weekend = ['每周六', '每周日'];
  if (weekdays.every((d) => tokens.includes(d)) && !weekend.some((d) => tokens.includes(d))) {
    return '周一至周五';
  }
  if (weekend.every((d) => tokens.includes(d)) && !weekdays.some((d) => tokens.includes(d))) {
    return '周末';
  }

  // 排序后展示
  const sorted = [...tokens].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
  return sorted.map((t) => WEEKDAY_LABEL[t] || t).join('、');
}

// ==================== 时间工具 ====================

function normalizeHm(value: unknown): string {
  if (value == null) return '';
  const match = String(value).match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return '';
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return '';
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseHm(value: string): { h: number; m: number } | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return { h: Number(match[1]), m: Number(match[2]) };
}

function isValidSlot(slot: ShiftSlot): boolean {
  if (!slot.start || !slot.end) return false;
  if (slot.start === slot.end) return false;
  if (slot.start === '00:00' && slot.end === '00:00') return false;
  return true;
}

function crossesMidnight(start: string, end: string): boolean {
  const ps = parseHm(start);
  const pe = parseHm(end);
  if (!ps || !pe) return false;
  return ps.h * 60 + ps.m > pe.h * 60 + pe.m;
}

function durationMinutes(start: string, end: string): number {
  const ps = parseHm(start);
  const pe = parseHm(end);
  if (!ps || !pe) return 0;
  const startMins = ps.h * 60 + ps.m;
  const endMins = pe.h * 60 + pe.m;
  if (endMins >= startMins) return endMins - startMins;
  // 跨午夜：补 24h
  return endMins + 24 * 60 - startMins;
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(isNonEmpty);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(isNonEmpty);
  }
  return true;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
