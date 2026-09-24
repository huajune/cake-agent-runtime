import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { JobDetail } from '@sponge/sponge.types';

/**
 * 海绵岗位真实数据样例（2026-09-20 自 ai/api/job/list 实查，六分区全开）。
 *
 * 脱敏口径：门店名→「示例门店 N」、门店地址与面试地址只留市+区、经纬度取整、
 * 面试官/联系人姓名与外链换占位；品牌名、岗位 ID、薪资数值、福利/备注自由文本保留。
 * 用途：渲染层用真实取值跑回归（PRD R4 J9）、「海绵下发但蛋糕未读」字段比对、体检规则正反例。
 */
const FIXTURE_DIR = __dirname;
const JOBS_PATH = path.join(FIXTURE_DIR, 'jobs.json');
export const UNREAD_FIELDS_ALLOWLIST_PATH = path.join(FIXTURE_DIR, 'unread-fields.allowlist.json');

let cache: string | null = null;

/** 全部样例（每次返回深拷贝，调用方可随意改）。 */
export function loadSpongeJobFixtures(): JobDetail[] {
  if (!cache) cache = fs.readFileSync(JOBS_PATH, 'utf8');
  return JSON.parse(cache) as JobDetail[];
}

/** 按 jobId 取单个样例（深拷贝）；不存在即抛错，避免测试静默跑在空数据上。 */
export function getSpongeJobFixture(jobId: number): JobDetail {
  const job = loadSpongeJobFixtures().find((item) => item.basicInfo?.jobId === jobId);
  if (!job) throw new Error(`sponge job fixture 不存在: jobId=${jobId}`);
  return job;
}

/** 取样例并就地改造（造反例用）。 */
export function buildSpongeJobFixture(jobId: number, mutate?: (job: JobDetail) => void): JobDetail {
  const job = getSpongeJobFixture(jobId);
  mutate?.(job);
  return job;
}

/** 样例里有代表性的岗位 ID（取值来自 docs/todo/job-data-gap-analysis-2026-09-20.md）。 */
export const SPONGE_JOB_FIXTURE_IDS = {
  /** 肯德基 RPO；周结每周三；结构化三档阶梯；固定节假日薪资 50 元/日 + 备注一致；周期面试。 */
  KFC_RPO_STAIR_PERIODIC_INTERVIEW: 529305,
  /** 哈根达斯 RPO；月结 5 号；多倍节假日薪资 3 倍；福利备注有文本；仅第二职业。 */
  HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY: 529161,
  /** 必胜客 BPO；阶梯只写在福利备注（月工时 0-100…），结构化标「无阶梯薪资」。 */
  PIZZA_HUT_BPO_STAIR_IN_MEMO_ONLY: 529139,
  /** 成都你六姐 BPO；阶梯只写在福利备注（月工时≤40小时…），结构化标「无阶梯薪资」。 */
  NILIUJIE_BPO_STAIR_IN_MEMO_ONLY: 529105,
  /** 必胜客 BPO；结构化与备注两边都写了阶梯；节假日薪资备注是分档描述（无单位数字）。 */
  PIZZA_HUT_BPO_STAIR_BOTH_SIDES: 528941,
  /** 必胜客 BPO；节假日结构化「无薪资」而备注写「法定单价55.5」；阶梯只在备注。 */
  PIZZA_HUT_BPO_HOLIDAY_CONFLICT: 527743,
  /** 奥乐齐 BPO；按在职天数分层时薪只在备注；结构化标「无阶梯薪资」。 */
  ALDI_BPO_TENURE_TIERS_IN_MEMO: 520459,
  /** 达美乐 BPO；综合薪资下限 0；福利备注是装备说明（无薪资）。 */
  DOMINOS_BPO_ZERO_MIN_COMPREHENSIVE: 528752,
  /** 达美乐 BPO；面试时间模式「等待通知」（无周期时段）。 */
  DOMINOS_BPO_WAIT_NOTICE: 528760,
  /** 果蔬好 BPO；周期面试；籍贯排除门槛（内部筛选）；无备注。 */
  GUOSHUHAO_BPO_HOUSEHOLD_EXCLUDE: 528136,
} as const;

/**
 * 递归收集对象里的字段路径；数组元素统一记作 `[]`，不区分下标。
 * 例：`jobSalary.salaryScenarioList[].stairSalaries[].salary`。
 */
export function collectFieldPaths(
  value: unknown,
  prefix = '',
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectFieldPaths(item, `${prefix}[]`, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${key}` : key;
      into.add(next);
      collectFieldPaths(child, next, into);
    }
  }
  return into;
}

/** zod schema 里显式声明的字段路径（catchall / passthrough 的未知键不算声明）。 */
export function collectZodDeclaredPaths(
  schema: z.ZodType,
  prefix = '',
  into = new Set<string>(),
): Set<string> {
  let current: z.ZodType = schema;
  // 剥掉 optional / nullable / default 包装
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodType;
      continue;
    }
    break;
  }
  if (current instanceof z.ZodArray) {
    collectZodDeclaredPaths(current.element as z.ZodType, `${prefix}[]`, into);
    return into;
  }
  if (current instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(current.shape as Record<string, z.ZodType>)) {
      const next = prefix ? `${prefix}.${key}` : key;
      into.add(next);
      collectZodDeclaredPaths(child, next, into);
    }
  }
  return into;
}

function listTsFiles(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listTsFiles(full, into);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      into.push(full);
    }
  }
  return into;
}

/**
 * 扫描源码目录，收集所有「以属性形态出现」的标识符：`.key`、`['key']` / `"key"`、`key:` / `key?:`。
 * 这是启发式：`salary`、`description` 这类通用键会被其它对象命中而算作「已读」，
 * 所以比对结果只能说明「确实没被任何代码提到」的字段，不能证明「被提到的就被正确读取」。
 */
export function collectSourcePropertyKeys(srcDir: string): Set<string> {
  const keys = new Set<string>();
  const patterns = [
    /\.([A-Za-z_$][\w$]*)/g,
    /['"]([A-Za-z_$][\w$]*)['"]/g,
    /\b([A-Za-z_$][\w$]*)\s*\??:/g,
  ];
  for (const file of listTsFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) keys.add(match[1]);
    }
  }
  return keys;
}

export function leafKeyOf(fieldPath: string): string {
  const withoutArrays = fieldPath.replace(/\[\]/g, '');
  return withoutArrays.slice(withoutArrays.lastIndexOf('.') + 1);
}

export interface UnreadFieldsAllowlist {
  /** 说明：为什么允许未读（人审后填写）。 */
  note: string;
  /** 已知未读的字段路径（排序后写入，便于 diff）。 */
  paths: string[];
}

export function readUnreadFieldsAllowlist(): UnreadFieldsAllowlist {
  if (!fs.existsSync(UNREAD_FIELDS_ALLOWLIST_PATH)) return { note: '', paths: [] };
  return JSON.parse(fs.readFileSync(UNREAD_FIELDS_ALLOWLIST_PATH, 'utf8')) as UnreadFieldsAllowlist;
}
