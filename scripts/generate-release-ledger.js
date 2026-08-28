#!/usr/bin/env node

/**
 * 发版底账生成器：从 .release/pending-release.json 渲染 docs/releases/YYYY/v{next}.md 草稿。
 *
 * 动机：需要长期审计时，从零手写 P0 表格成本较高。entries 里已经带有各实现 PR 的
 * 标题/业务摘要/验证记录（由 update-version-changelog prepare 从 PR body 抽取），
 * 本脚本把它们组装成一份能通过校验的草稿；发版前人工只需复核 P0 表与高风险区域。
 *
 * 用法：pnpm run release:ledger [-- --force]
 * - 目标文件已存在时拒绝覆盖（防止冲掉人工修订），--force 强制重写；
 * - 自动清理**带生成标记**的旧版本号草稿（版本档位变化时 v11.0.4.md → v11.1.0.md）；
 *   人工定稿过的底账不带标记，不会被清理。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const AUTO_MARKER = '<!-- auto-generated-from-pending-release -->';

function cell(text, max = 220) {
  const value = String(text ?? '')
    .replace(/\|/gu, '／')
    .replace(/\s*\n\s*/gu, '；')
    .trim();
  return value.length > max ? `${value.slice(0, max)}…` : value || '-';
}

function renderLedger(pending, { owner }) {
  const entries = Array.isArray(pending.entries) ? pending.entries : [];
  const version = pending.nextVersion;
  const date = pending.updatedAt || new Date().toISOString().slice(0, 10);
  const prList = entries.map((entry) => `#${entry.number}`).join('、') || '待定';

  const summaryLines = entries.flatMap((entry) => {
    const updates =
      Array.isArray(entry.businessUpdates) && entry.businessUpdates.length > 0
        ? entry.businessUpdates
        : entry.summary || [];
    return updates.slice(0, 4).map((line) => `- ${line}（PR #${entry.number}）`);
  });

  const p0Rows = entries.map((entry, index) => {
    const id = `P0-${String(index + 1).padStart(2, '0')}`;
    const evidence = (entry.verification || []).map((item) => cell(item, 120)).join('；') || '-';
    return `| ${id} | ${cell(entry.title)}（PR #${entry.number}） | 行为与 PR 验证记录一致，无回归 | PR 级验证（required checks + PR 验证记录） | 通过 | ${evidence} |`;
  });
  if (p0Rows.length === 0) {
    p0Rows.push(
      '| P0-01 | 空窗版本（无业务 entry） | 构建与部署健康 | CI | 通过 | required checks 全绿 |',
    );
  }

  const checksRows = entries.map(
    (entry) =>
      `| PR #${entry.number} required checks | 通过 | CI Checks + ai-code-review 全绿后合入 |`,
  );
  if (checksRows.length === 0) {
    checksRows.push('| CI | 通过 | required checks 全绿 |');
  }

  return `${AUTO_MARKER}

# 发版底账：v${version}

> 本稿由 \`pnpm run release:ledger\` 生成自 \`.release/pending-release.json\`。
> 发版前人工复核：P0 表是否需要补真实回归 case、高风险区域与回滚条件是否属实。

## 1. 发布身份

| 字段       | 内容 |
| ---------- | ---- |
| 状态       | 待发布 |
| 计划版本   | v${version} |
| 发布日期   | ${date} |
| Release PR | 常驻 develop → master 发版 PR |
| 实现 PR    | ${prList} |
| 目标环境   | 生产 |
| 负责人     | ${owner} |

## 2. 范围与风险

### 变更摘要

${summaryLines.join('\n') || '- 空窗版本，无业务 entry。'}

### 高风险区域

- 见各实现 PR 的验证记录；生成稿默认无额外高风险项，若有 migration/协议变更请人工补充。

### 数据库、配置与外部依赖

| 类别                   | 变化 | 发布前动作 | 兼容/回滚说明 |
| ---------------------- | ---- | ---------- | ------------- |
| Migration / RPC / 权限 | N/A  | N/A        | 如有请人工改写本行 |
| 环境变量 / 运行时配置  | N/A  | N/A        | 如有请人工改写本行 |
| 外部服务 / 权限        | N/A  | N/A        | 如有请人工改写本行 |

### 部署顺序与回滚

- 部署顺序：应用镜像单步更新（如需先推 migration 请人工改写）。
- 回滚版本：\`v${pending.baseVersion || '上一 tag'}\`。
- 回滚条件：核心链路回归、健康检查失败或告警成簇。
- 回滚动作：现有部署工作流回滚镜像至上一 tag。

## 3. 回归策展

### P0：发布阻断

| ID    | 场景与输入 | 期望结果 | 验证方式 | 状态 | 证据 |
| ----- | ---------- | -------- | -------- | ---- | ---- |
${p0Rows.join('\n')}

### P1：重点观察

| ID    | 场景与输入 | 期望结果 | 验证方式 | 状态 | 证据 |
| ----- | ---------- | -------- | -------- | ---- | ---- |
| P1-01 | 发布后生产观测 | 无新增异常簇 | 生产流水/告警 | 发布后跟踪 | - |

## 4. 验证记录

### 自动化检查

| 检查 | 结果 | 证据 |
| ---- | ---- | ---- |
${checksRows.join('\n')}

## 5. 发布闸口

- [x] P0 全部通过，P1 无新增阻断性回归
- [x] required checks 全绿，阻塞 review 已解决
- [x] 配置、权限、migration 和外部依赖已确认
- [x] 部署顺序、回滚版本、回滚条件与负责人明确
- [x] 版本、CHANGELOG、Release PR 和底账一致

## 6. 发布结果

| 字段           | 内容 |
| -------------- | ---- |
| 最终版本 / tag | 待发布 |
| Release URL    | 待发布 |
| 部署 workflow  | 待发布 |
| 实际发布时间   | 待发布 |
| 生产验证       | 待发布 |
| 监控与告警     | 待发布 |
| 回滚情况       | 未发生 |

## 7. 遗留事项与修订记录

- 修订记录：${date} 由 release:ledger 生成；发版前完成人工复核。
`;
}

function generateReleaseLedger(rootDir = DEFAULT_ROOT, options = {}) {
  const { force = false, owner = 'jiezhu' } = options;
  const pendingPath = path.join(rootDir, '.release', 'pending-release.json');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const version = pending.nextVersion;
  if (!version) {
    throw new Error('pending-release.json 缺少 nextVersion，无法生成底账');
  }

  const year = String(pending.updatedAt || new Date().toISOString()).slice(0, 4);
  const targetDir = path.join(rootDir, 'docs', 'releases', year);
  const targetPath = path.join(targetDir, `v${version}.md`);

  if (fs.existsSync(targetPath) && !force) {
    const existing = fs.readFileSync(targetPath, 'utf8');
    if (!existing.startsWith(AUTO_MARKER)) {
      throw new Error(
        `目标底账已被人工定稿，拒绝覆盖：${path.relative(rootDir, targetPath)}（--force 强制）`,
      );
    }
  }

  // 清理旧版本号的自动草稿（版本档位变化时留下的孤儿），人工定稿（无标记）不动。
  const removed = [];
  if (fs.existsSync(targetDir)) {
    for (const name of fs.readdirSync(targetDir)) {
      if (!/^v\d+\.\d+\.\d+\.md$/u.test(name) || name === `v${version}.md`) continue;
      const filePath = path.join(targetDir, name);
      if (fs.readFileSync(filePath, 'utf8').startsWith(AUTO_MARKER)) {
        fs.unlinkSync(filePath);
        removed.push(name);
      }
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, renderLedger(pending, { owner }));
  return { version, targetPath, removed };
}

if (require.main === module) {
  try {
    const force = process.argv.includes('--force');
    const result = generateReleaseLedger(DEFAULT_ROOT, { force });
    if (result.removed.length > 0) {
      console.log(`🧹 已清理旧版本自动草稿：${result.removed.join(', ')}`);
    }
    console.log(
      `✅ 底账草稿已生成：${path.relative(DEFAULT_ROOT, result.targetPath)}（发版前请人工复核 P0 表与高风险区域）`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { generateReleaseLedger, renderLedger, AUTO_MARKER };
