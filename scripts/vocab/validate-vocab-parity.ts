/**
 * 词表跨介质一致性校验（仿 geo:validate，挂在 ci:check 里）。
 *
 * ## 为什么需要它
 *
 * 词表收拢专项的绝大多数条目靠类型系统就能焊死（`as const` 派生 + `Record<Domain,T>`
 * 穷尽约束）。但有三类一致性**类型表达不了**：
 *
 * 1. **提示词文本**里手写的词表——`.md` 由 StaticSection 原样注入、无插值机制，
 *    抽取提示词的合法值列表顺序也与常量不同（改写它等于无声改动模型输入）；
 * 2. **前端副本**——`web/` 与 `src/` 物理隔离（web/tsconfig 的 include 只有 ['src']、
 *    paths 只有 `@/*`），无共享类型包，同一词表只能各写一份；
 * 3. **`lint:check` 的覆盖盲区**——它只 glob `"src/**\/*.ts"`，任何 ESLint 方案都
 *    管不到 `web/` 与提示词资产。
 *
 * 所以这一层只能靠"读源码文本 + 断言成员出现"来兜。
 *
 * ## 断言口径（刻意保守）
 *
 * 只断言**成员集合的出现与否**，不比整段文本、不比顺序——否则重命名/改格式就假失败，
 * 维护成本会反噬（审计结论：源码指纹断言脆、不可推广，只用于跨介质）。
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { VALID_LABOR_FORMS } from '@resolution/labor-form';
import { AGENT_TOOL_CALL_STATUSES } from '@shared-types/agent-telemetry.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const REPO_ROOT = join(__dirname, '../..');

interface Failure {
  check: string;
  detail: string;
}

const failures: Failure[] = [];
const passed: string[] = [];

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** 从一段 TS 源码里抽取某个字符串联合类型的成员。 */
function extractStringUnion(source: string, typeName: string): string[] | null {
  const re = new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`);
  const m = source.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function checkMembersPresent(check: string, relPath: string, members: readonly string[]): void {
  let source: string;
  try {
    source = read(relPath);
  } catch {
    failures.push({ check, detail: `文件读取失败：${relPath}` });
    return;
  }
  const missing = members.filter((m) => !source.includes(m));
  if (missing.length > 0) {
    failures.push({
      check,
      detail: `${relPath} 未提及词表成员：${missing.join('、')}（词表已加档但提示词/副本没跟）`,
    });
    return;
  }
  passed.push(`${check}（${relPath}）`);
}

// ── 检查 1：labor_form 合法值 ↔ 两处提示词资产 ────────────────────────────────
//
// 抽取 schema 是裸 z.string()，模型能否产出合法值**全靠提示词里那份词表**。
// 加档而漏改提示词 → 模型继续吐旧值 → isValidLaborForm 静默丢弃，候选人明确
// 表达的用工形式偏好消失，全程零信号。
//
// 刻意不改写提示词文本：其成员顺序与常量不同（"小时工"在提示词里排第 3、
// 常量里排第 5），生成式替换非逐字节等价，属改动模型可见输入。
{
  // 1a. 抽取提示词：精确锚到"仅允许以下合法值之一"那一行。
  //     不能整文件 includes——这些词在同文件的规则条目里到处出现，
  //     删掉合法值列表里的某一项也检不出来（已实测会假通过）。
  const check = 'labor_form 词表 ↔ 抽取提示词合法值行';
  const relPath = 'src/memory/services/session-extraction.prompt.ts';
  const line = read(relPath)
    .split('\n')
    .find((l) => l.includes('仅允许以下合法值之一'));
  if (!line) {
    failures.push({ check, detail: `${relPath} 找不到「仅允许以下合法值之一」那行（提示词被改写？）` });
  } else {
    const listed = [...line.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    const expected = [...VALID_LABOR_FORMS].sort();
    if (JSON.stringify(listed.slice().sort()) !== JSON.stringify(expected)) {
      failures.push({
        check,
        detail:
          `合法值行与 VALID_LABOR_FORMS 成员集合不一致：` +
          `提示词 [${listed.join(', ')}] vs 常量 [${VALID_LABOR_FORMS.join(', ')}]。` +
          `抽取 schema 是裸 z.string()，模型能否产出合法值全靠这一行。`,
      });
    } else {
      passed.push(`${check}（${listed.length} 值一致，顺序刻意不比）`);
    }
  }
}

// 1b. 候选人咨询提示词（.md）：词表散在多段散文里，无单一锚点行。
//     整文件 includes 只能检出「新加了成员却没写进提示词」这一个方向——
//     那恰好是本项要防的风险（加档漏改）；删除方向检不出，如实标注。
checkMembersPresent(
  'labor_form 词表 ↔ 咨询提示词（仅检出新增漏写）',
  'src/agent/generator/context/prompts/candidate-consultation.md',
  VALID_LABOR_FORMS,
);

// ── 检查 2：工具调用状态 后端权威 ↔ 前端副本 ──────────────────────────────────
{
  const check = 'AgentToolCallStatus ↔ web 前端副本';
  const frontendPath = 'web/src/api/types/chat.types.ts';
  const frontend = extractStringUnion(read(frontendPath), 'MessageRecordToolCallStatus');
  if (!frontend) {
    failures.push({ check, detail: `${frontendPath} 里找不到 MessageRecordToolCallStatus 定义` });
  } else {
    const backend = [...AGENT_TOOL_CALL_STATUSES].sort();
    const front = [...frontend].sort();
    if (JSON.stringify(backend) !== JSON.stringify(front)) {
      failures.push({
        check,
        detail:
          `成员集合不一致：后端 [${backend.join(', ')}] vs 前端 [${front.join(', ')}]。` +
          `前后端无共享类型包，加档必须两边都改。`,
      });
    } else {
      passed.push(`${check}（${backend.length} 档一致）`);
    }
  }
}

// ── 检查 3：转人工原因码 三份 label 表键集一致 ────────────────────────────────
//
// 同一组 reasonCode 有三份 Record<string,string> 标签表（工具侧告警卡片、
// 转化分析后端、前端饼图），键集全靠人肉同步。文案**刻意不比**——三者受众不同
// （飞书告警 vs 运营看板），文案是否统一属产品判断，这里只保证键集不漏。
{
  const check = 'handoff reasonCode 三份标签表键集';
  const sources: Array<[string, string]> = [
    ['工具侧', 'src/tools/request-handoff.tool.ts'],
    ['转化分析', 'src/biz/conversion-analytics/conversion-analytics.service.ts'],
    ['前端饼图', 'web/src/view/conversion-analysis/list/components/HandoffPieChart/index.tsx'],
  ];

  // 权威：工具入参 z.enum 的成员（模型唯一能产出的取值集）
  const toolSource = read('src/tools/request-handoff.tool.ts');
  const enumBlock = toolSource.match(/reasonCode:\s*z\s*\n?\s*\.enum\(\[([\s\S]*?)\]\)/);
  const authority = enumBlock ? [...enumBlock[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];

  if (authority.length === 0) {
    failures.push({ check, detail: '未能从 request-handoff.tool.ts 解析出 reasonCode 词表' });
  } else {
    for (const [label, relPath] of sources) {
      const source = read(relPath);
      const missing = authority.filter((code) => !source.includes(code));
      if (missing.length > 0) {
        failures.push({
          check,
          detail: `${label}（${relPath}）缺少 reasonCode：${missing.join('、')} → 该原因在此处会落到 "?? 兜底" 标签`,
        });
      }
    }
    if (!failures.some((f) => f.check === check)) {
      passed.push(`${check}（${authority.length} 个码 × 3 处一致）`);
    }
  }
}

// ── 检查 4：提示词里提到的 errorType 必须是线上真值，且不得写成常量 KEY ──────
//
// 病根：`buildToolError` 吐给模型的是**值**（`geocode.unresolved_address`），
// 而提示词里手写的是**常量 KEY**（`GEOCODE_UNRESOLVED_ADDRESS`）——模型被告知去
// 认一个它永远收不到的字符串。同一份提示词里 `booking.rejected` 又是写对的，
// 说明正确写法早有先例，只是没有任何东西拦住写错的那几处。
//
// 只查一个方向：出现了 TOOL_ERROR_TYPES 的 **KEY**（SCREAMING_SNAKE）→ 必然写错。
// 只在"该 token 恰好是某个 errorType 的 key"时才报，因此零假阳性——
// CURRENT_TIME / GUARD_SUFFIX 这类正常占位符不会被误伤。
//
// ⚠️ 刻意**不**查反方向（"dotted token 必须是合法真值"）：TOOL_ERROR_TYPES 的
// 命名规范是「namespace 与工具名对齐」，于是工具**参数路径**与 errorType **取值**
// 形状完全相同——`geocode.city`（geocode 工具的 city 入参）与
// `geocode.city_required`（errorType）无法靠形状区分。实测该方向会把前者报成
// 拼错。要修只能维护一张"已知非 errorType 的 dotted token"白名单，那种名单必然
// 腐烂，收益不抵维护成本。
{
  const check = 'errorType 提示词写法 ↔ 线上真值';
  const PROMPT_ASSETS = [
    'src/agent/generator/context/prompts/candidate-consultation.md',
    'src/tools/geocode.tool.ts',
    'src/tools/duliday-job-list.tool.ts',
    'src/tools/duliday-interview-precheck.tool.ts',
    'src/tools/duliday-interview-booking.tool.ts',
    'src/tools/invite-to-group.tool.ts',
    'src/tools/request-handoff.tool.ts',
  ];
  const entries = Object.entries(TOOL_ERROR_TYPES) as Array<[string, string]>;
  const keyToValue = new Map(entries);

  for (const relPath of PROMPT_ASSETS) {
    let source: string;
    try {
      source = read(relPath);
    } catch {
      continue; // 文件不存在（重命名/删除）不在本检查职责内
    }

    // 逐行扫 SCREAMING_SNAKE token，命中 errorType key 即写错。
    //
    // 刻意**不**要求反引号包裹：首版只匹配反引号内的，漏掉了
    // duliday-job-list.tool.ts 里裸写在 replyInstruction 字符串中的一处
    // （该串直发模型）——覆盖面缺口由 PR 评审实测指出。
    //
    // 代价是要跳过注释行：.ts 文件里在注释中提常量名是正常写法（那不进 prompt），
    // 只有进字符串的才会被模型看到。按行首形态跳过 // 与块注释续行即可，
    // 不必上 AST——本检查的目标是拦住"写进提示词"，不是做静态分析。
    for (const rawLine of source.split('\n')) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      for (const m of trimmed.matchAll(/([A-Z][A-Z0-9_]{5,})/g)) {
        const token = m[1];
        // 代码里正常引用常量（TOOL_ERROR_TYPES.XXX）不算写进提示词
        if (trimmed.includes(`TOOL_ERROR_TYPES.${token}`)) continue;
        const value = keyToValue.get(token);
        if (value) {
          failures.push({
            check,
            detail:
              `${relPath} 写的是常量 KEY \`${token}\`，但模型实收的是值 \`${value}\`` +
              `（buildToolError 吐的是值）。请改写成 \`${value}\`；.ts 资产可直接内插 TOOL_ERROR_TYPES.${token}。`,
          });
        }
      }
    }

  }

  if (!failures.some((f) => f.check === check)) {
    passed.push(`${check}（${PROMPT_ASSETS.length} 份提示词资产 × ${entries.length} 个 errorType）`);
  }
}

// ── 报告 ──────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('vocab:validate 失败：\n');
  for (const f of failures) console.error(`  ✗ [${f.check}] ${f.detail}`);
  console.error(
    '\n这类不一致靠 typecheck 与 lint 都发现不了（跨介质 / 跨前后端 / 提示词文本），' +
      '\n请把新加的词表成员同步到上述位置后重跑。',
  );
  process.exit(1);
}

console.log(`vocab:validate 通过（${passed.length} 项跨介质一致性检查全绿）`);
for (const p of passed) console.log(`  ✓ ${p}`);
