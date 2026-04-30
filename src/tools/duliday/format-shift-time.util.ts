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
  weekdays?: string; // 来自 combinedArrangement.combinedArrangementWeekdays（如"每周一,每周二"）
}

interface WorkTimeInput {
  dailyShiftSchedule?: DailyShiftScheduleInput;
  monthWorkTime?: MonthWorkTimeInput;
  dayWorkTime?: DayWorkTimeInput;
}

interface DailyShiftScheduleInput {
  arrangementType?: unknown;
  fixedScheduleList?: FixedScheduleInput[];
  combinedArrangement?: CombinedArrangementInput[];
  fixedTime?: FixedTimeInput;
}

interface FixedScheduleInput {
  fixedShiftStartTime?: unknown;
  fixedShiftEndTime?: unknown;
}

interface CombinedArrangementInput {
  combinedArrangementStartTime?: unknown;
  combinedArrangementEndTime?: unknown;
  combinedArrangementWeekdays?: unknown;
}

interface FixedTimeInput {
  goToWorkStartTime?: unknown;
  goToWorkEndTime?: unknown;
  goOffWorkStartTime?: unknown;
  goOffWorkEndTime?: unknown;
}

interface MonthWorkTimeInput {
  perMonthMinWorkTime?: unknown;
}

interface DayWorkTimeInput {
  perDayMinWorkHours?: unknown;
}

/** 主入口：从 workTime 产出可对外展示的班次文案。null = 没有具体班次。 */
export function composeShiftTimeText(workTime: unknown): string | null {
  if (!isNonEmpty(workTime)) return null;
  const input = workTime as WorkTimeInput;

  if (looksLikeFlexibleArrangement(input)) {
    // 弹性排班 → 不强行展示具体时段，按候选人自定义/门店排返回简短描述
    return composeFlexibleSummary(input);
  }

  const slots = collectShiftSlots(input);
  if (slots.length === 0) return null;

  const mode = inferSelectionMode(input, slots);
  return formatSlots(slots, mode);
}

/** 收集所有候选 slot，按优先级：fixedScheduleList > combinedArrangement > fixedTime（窄区间）。 */
function collectShiftSlots(workTime: WorkTimeInput): ShiftSlot[] {
  const schedule = workTime?.dailyShiftSchedule;
  if (!schedule) return [];

  // 1) fixedScheduleList: 多档班次
  const fixedList = Array.isArray(schedule.fixedScheduleList) ? schedule.fixedScheduleList : [];
  const fromFixedList: ShiftSlot[] = fixedList
    .map((sh) => ({
      start: normalizeHm(sh?.fixedShiftStartTime),
      end: normalizeHm(sh?.fixedShiftEndTime),
    }))
    .filter((s: ShiftSlot) => isValidSlot(s));
  if (fromFixedList.length > 0) return fromFixedList;

  // 2) combinedArrangement: 带星期的时段
  const combined = Array.isArray(schedule.combinedArrangement) ? schedule.combinedArrangement : [];
  const fromCombined: ShiftSlot[] = combined
    .map((ca) => ({
      start: normalizeHm(ca?.combinedArrangementStartTime),
      end: normalizeHm(ca?.combinedArrangementEndTime),
      weekdays:
        typeof ca?.combinedArrangementWeekdays === 'string'
          ? ca.combinedArrangementWeekdays
          : undefined,
    }))
    .filter((s: ShiftSlot) => isValidSlot(s));
  if (fromCombined.length > 0) return fromCombined;

  // 3) fixedTime: 仅当上班区间 < 2h 时视为"班次起止"
  const ft = schedule.fixedTime;
  if (!ft) return [];
  const goUpStart = normalizeHm(ft.goToWorkStartTime);
  const goUpEnd = normalizeHm(ft.goToWorkEndTime);
  const goOffStart = normalizeHm(ft.goOffWorkStartTime);
  const goOffEnd = normalizeHm(ft.goOffWorkEndTime);
  if (goUpStart && goOffEnd) {
    const upRangeMinutes = goUpEnd ? minutesBetween(goUpStart, goUpEnd) : 0;
    if (upRangeMinutes < 120) {
      // 窄上班区间，认为是固定班次：取上班开始 + 下班结束
      return [
        {
          start: goUpStart,
          end: goOffEnd,
        },
      ];
    }
    // 上班区间 ≥ 2h（如 5:00-23:00 营业时段范围）→ 视为非具体班次
    return [];
  }
  if (goUpStart && goOffStart) {
    // 没有 endTime，但能凭起始构造单点
    return [];
  }

  return [];
}

/** 选择关系：由 workTime 形态推断。 */
type SelectionMode = 'single' | 'pick_one' | 'by_weekday';

function inferSelectionMode(workTime: WorkTimeInput, slots: ShiftSlot[]): SelectionMode {
  if (slots.length === 1) return 'single';

  // combinedArrangement 多条且每条带 weekdays → 按星期排班
  const allHaveWeekdays = slots.every((s) => Boolean(s.weekdays));
  if (allHaveWeekdays) return 'by_weekday';

  // 多档 fixedScheduleList 的标准业务语义就是"候选人选其一"。
  // arrangementType 字段实际值我们见过 '固定排班制'/'组合排班制'/'弹性' 等，
  // 含义并不能可靠推断"必须全做"，保守默认 pick_one。
  return 'pick_one';
}

/**
 * 弹性排班识别 — 收紧到只识别"弹性/灵活"两个关键词，避免误判。
 *
 * 已知 arrangementType 真实值（来自代码内 fixture）：
 * - '固定排班制' / '组合排班制' / '弹性'
 * 这里**只**当 arrangementType 含 弹性 / 灵活 时走 flexible 分支；
 * 其他值（含未来未知值）一律按数据形态判断（fixedScheduleList → combinedArrangement → fixedTime）。
 * 没具体班次数据时上层会自然返回 null，不会误显示。
 */
function looksLikeFlexibleArrangement(workTime: WorkTimeInput): boolean {
  const arrangementType = workTime?.dailyShiftSchedule?.arrangementType;
  if (typeof arrangementType === 'string' && /弹性|灵活/.test(arrangementType)) return true;
  return false;
}

function composeFlexibleSummary(workTime: WorkTimeInput): string | null {
  const month = workTime?.monthWorkTime;
  const day = workTime?.dayWorkTime;
  const monthMin = numberOf(month?.perMonthMinWorkTime);
  const dayMin = numberOf(day?.perDayMinWorkHours);
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

function minutesBetween(a: string, b: string): number {
  const pa = parseHm(a);
  const pb = parseHm(b);
  if (!pa || !pb) return 0;
  return pb.h * 60 + pb.m - (pa.h * 60 + pa.m);
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
