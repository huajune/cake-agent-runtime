/* eslint-disable */
/**
 * 把每日 badcase 自动扫描日报（本地 md）同步为飞书 wiki 文档。
 *
 *   node scripts/sync-scan-report-to-feishu.js [YYYY-MM-DD]
 *
 * 行为：
 *   - 默认同步「今天日期」的报告（daily-auto-scan-report 任务当天产出的那份）
 *   - 文档落在「BadCase 治理进展同步」下的「每日 badcase 扫描报告存档」子目录
 *   - 幂等：同名文档已存在时清空重写，URL 保持稳定（外部链接不会失效）
 *   - markdown → 飞书块用官方 convert 接口，表格保真
 *
 * 依赖 .env.production 的 FEISHU_APP_ID / FEISHU_APP_SECRET。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR =
  '/Users/jiezhu/.claude/projects/-Users-jiezhu-workSpace-DuLiDay-cake-agent-runtime/badcase-scan-reports';
const BASE = 'https://open.feishu.cn/open-apis';
const SPACE_ID = '7501273122507669508';
const GOVERNANCE_NODE = 'WUEzwZlYOienOgkw7z1cpeOVnBB'; // BadCase 治理进展同步
const ARCHIVE_TITLE = '每日 badcase 扫描报告存档';

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.production'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

async function token() {
  const r = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`获取 token 失败: ${j.code} ${j.msg}`);
  return j.tenant_access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(t, method, url, body, attempt = 0) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 逐列设列宽会打满写接口频控，退避重试（实测 17 张表 64 列必触发若干次 429）
  if (r.status === 429 && attempt < 5) {
    await sleep(400 * 2 ** attempt);
    return call(t, method, url, body, attempt + 1);
  }

  // 部分接口（如 update_table_property）会回空体，直接 .json() 会抛 Unexpected end of JSON input
  const raw = await r.text();
  if (!raw) return { code: r.ok ? 0 : r.status, msg: r.ok ? 'empty body' : r.statusText };
  try {
    return JSON.parse(raw);
  } catch {
    return { code: -1, msg: `非 JSON 响应(${r.status}): ${raw.slice(0, 120)}` };
  }
}

/**
 * 节点索引：wiki 列表接口实测会漏掉刚建的节点（07-30 因此重复建了一次目录），
 * 不能只靠它做幂等。这里落一份本地索引，先按 token 直查，查不到再退回列表/新建。
 */
const INDEX_FILE = path.join(REPORT_DIR, '.feishu-sync-index.json');
function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}
async function nodeAlive(t, nodeToken) {
  if (!nodeToken) return null;
  const r = await call(t, 'GET', `/wiki/v2/spaces/get_node?token=${nodeToken}`);
  return r.code === 0 ? r.data.node : null;
}

/** 找到（或创建）节点：索引直查 → 列表兜底 → 新建，三级 */
async function ensureNode(t, { indexKey, parentToken, title, label }) {
  const idx = readIndex();

  const known = await nodeAlive(t, idx[indexKey]);
  if (known) return { node: known, existed: true };

  const list = await call(
    t,
    'GET',
    `/wiki/v2/spaces/${SPACE_ID}/nodes?parent_node_token=${parentToken}&page_size=50`,
  );
  if (list.code !== 0) throw new Error(`列子节点失败: ${list.code} ${list.msg}`);
  const hit = (list.data?.items || []).find((n) => n.title === title);
  if (hit) {
    idx[indexKey] = hit.node_token;
    writeIndex(idx);
    return { node: hit, existed: true };
  }

  const created = await call(t, 'POST', `/wiki/v2/spaces/${SPACE_ID}/nodes`, {
    obj_type: 'docx',
    parent_node_token: parentToken,
    node_type: 'origin',
    title,
  });
  if (created.code !== 0) throw new Error(`创建${label}失败: ${created.code} ${created.msg}`);
  idx[indexKey] = created.data.node.node_token;
  writeIndex(idx);
  console.log(`  📁 已创建${label}「${title}」`);
  return { node: created.data.node, existed: false };
}

/**
 * 列宽自适应（按各列实际内容宽度分配，CJK 计 2）。
 * 飞书默认每列恒 100px，中文表头必逐字换行，不设就是一坨。算法与周报脚本
 * ~/.claude/scheduled-tasks/weekly-handoff-analysis/publish-to-feishu.mjs 保持一致。
 */
const TOTAL = 920;
const MINW = 82;
const PXU = 7.4;
const PAD = 24;
const CAP = 46;
function widths(rows) {
  const dw = (s) => [...s].reduce((n, c) => n + (/[⺀-￿]/.test(c) ? 2 : 1), 0);
  const cols = rows[0].length;
  const score = [];
  for (let c = 0; c < cols; c++) {
    const lens = rows.map((r) => Math.min(dw(r[c] ?? ''), CAP));
    const body = lens.slice(1).sort((a, b) => a - b);
    const p80 = body.length ? body[Math.min(body.length - 1, Math.floor(body.length * 0.8))] : 0;
    score.push(Math.max(lens[0] + 2, p80, 4)); // 表头不换行优先
  }
  let w = score.map((s) => Math.max(MINW, Math.round(s * PXU) + PAD));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum > TOTAL) {
    const fixed = w.map((x) => x === MINW);
    const freeSum = w.filter((_, i) => !fixed[i]).reduce((a, b) => a + b, 0);
    const budget = TOTAL - MINW * fixed.filter(Boolean).length;
    w = w.map((x, i) => (fixed[i] ? MINW : Math.max(MINW, Math.round((x * budget) / freeSum))));
  } else if (sum < TOTAL * 0.75) {
    w = w.map((x) => Math.round((x * (TOTAL * 0.85)) / sum));
  }
  return w;
}

/** 读全量块（分页，报告动辄 1000+ 块） */
async function getAllBlocks(t, docId) {
  const out = [];
  let pageToken = null;
  do {
    const q = `page_size=500&document_revision_id=-1${pageToken ? `&page_token=${pageToken}` : ''}`;
    const r = await call(t, 'GET', `/docx/v1/documents/${docId}/blocks?${q}`);
    if (r.code !== 0) throw new Error(`读块失败: ${r.code} ${r.msg}`);
    out.push(...(r.data?.items || []));
    pageToken = r.data?.has_more ? r.data.page_token : null;
  } while (pageToken);
  return out;
}

/**
 * 写完正文后统一设列宽。表格 id 只能回读文档拿（descendant 响应不带 block_type），
 * 单元格内容顺着 table.children → table_cell.children → text 取。
 */
async function autosizeTables(t, docId) {
  const all = await getAllBlocks(t, docId);
  const byId = new Map(all.map((b) => [b.block_id, b]));
  const textOf = (b) => {
    if (!b) return '';
    const k = Object.keys(b).find((x) => b[x] && Array.isArray(b[x].elements));
    return k ? (b[k].elements || []).map((e) => e.text_run?.content || '').join('') : '';
  };

  const tables = all.filter((b) => b.block_type === 31);
  let patched = 0;
  for (const tb of tables) {
    const cols = tb.table?.property?.column_size;
    const cellIds = tb.children || [];
    if (!cols || cellIds.length === 0) continue;

    const rows = [];
    for (let i = 0; i < cellIds.length; i += cols) {
      rows.push(
        cellIds
          .slice(i, i + cols)
          .map((cid) => (byId.get(cid)?.children || []).map((x) => textOf(byId.get(x))).join(' ')),
      );
    }
    if (!rows.length) continue;

    // 只能单列单发：batch_update 不吃 update_table_property，会 1770001
    for (const [column_index, column_width] of widths(rows).entries()) {
      const r = await call(t, 'PATCH', `/docx/v1/documents/${docId}/blocks/${tb.block_id}?document_revision_id=-1`, {
        update_table_property: { column_width, column_index },
      });
      if (r.code === 0) patched++;
      else console.warn(`  ⚠️ 列宽设置失败 table=${tb.block_id} col=${column_index}: ${r.code} ${r.msg}`);
    }
  }
  return { tables: tables.length, patched };
}

/** 清空文档正文（幂等重写用） */
async function clearDocument(t, docId) {
  const b = await call(t, 'GET', `/docx/v1/documents/${docId}/blocks?page_size=500&document_revision_id=-1`);
  const root = (b.data?.items || []).find((x) => x.block_id === docId);
  const n = root?.children?.length || 0;
  if (n === 0) return 0;
  const r = await call(
    t,
    'DELETE',
    `/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete?document_revision_id=-1`,
    { start_index: 0, end_index: n },
  );
  if (r.code !== 0) throw new Error(`清空文档失败: ${r.code} ${r.msg}`);
  return n;
}

/**
 * convert 的输出不能原样喂给 descendant 接口：
 *   - parent_id 为空串会被拒
 *   - 表格块的 table.cells / property.column_width / property.merge_info 是只读字段，
 *     创建时带上一律 1770001 invalid param，只能留 row_size + column_size
 */
function sanitize(block) {
  const { parent_id, ...rest } = block;
  if (rest.block_type === 31 && rest.table?.property) {
    const { row_size, column_size } = rest.table.property;
    return { ...rest, table: { property: { row_size, column_size } } };
  }
  // markdown 里从「0.」起编的有序列表会转出 sequence:"0"，飞书要求序号 ≥ 1，会整段 400
  if (rest.block_type === 13 && rest.ordered?.style?.sequence !== undefined) {
    const seq = Number(rest.ordered.style.sequence);
    if (!Number.isInteger(seq) || seq < 1) {
      const { sequence, ...style } = rest.ordered.style;
      return { ...rest, ordered: { ...rest.ordered, style } };
    }
  }
  return rest;
}

/** markdown → 飞书块 */
async function convert(t, markdown) {
  const r = await call(t, 'POST', `/docx/v1/documents/blocks/convert`, {
    content_type: 'markdown',
    content: markdown,
  });
  if (r.code !== 0) throw new Error(`markdown 转换失败: ${r.code} ${r.msg}`);
  return {
    blocks: (r.data.blocks || []).map(sanitize),
    firstLevel: r.data.first_level_block_ids || [],
  };
}

/**
 * 按二级标题切段，避免单次 descendant 请求过大（表格多时块数会爆）。
 * 每段自成一次转换 + 写入，表格不会被拆断。
 */
function splitMarkdown(md, maxChars = 3500) {
  const lines = md.split('\n');
  const chunks = [];
  let cur = [];
  let size = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur.join('\n'));
    cur = [];
    size = 0;
  };
  for (const line of lines) {
    const isSection = /^#{2,3} /.test(line);
    if (isSection && size > maxChars) flush();
    cur.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks.filter((c) => c.trim().length > 0);
}

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const file = path.join(REPORT_DIR, `${date}.md`);
  if (!fs.existsSync(file)) {
    console.error(`❌ 报告不存在: ${file}`);
    process.exit(1);
  }

  let md = fs.readFileSync(file, 'utf8');
  // 首行 H1 作为文档标题，正文里去掉避免重复
  const h1 = md.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : `每日 badcase 自动扫描 — ${date}`;
  if (h1) md = md.replace(/^#\s+.+$/m, '').trimStart();

  const t = await token();
  const { node: archive } = await ensureNode(t, {
    indexKey: '_archive',
    parentToken: GOVERNANCE_NODE,
    title: ARCHIVE_TITLE,
    label: '存档目录',
  });
  const { node, existed } = await ensureNode(t, {
    indexKey: date,
    parentToken: archive.node_token,
    title,
    label: '报告文档',
  });
  const docId = node.obj_token;

  if (existed) {
    const removed = await clearDocument(t, docId);
    console.log(`  ♻️  已存在同名文档，清空 ${removed} 个顶层块后重写`);
  }

  const chunks = splitMarkdown(md);
  let index = 0;
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { blocks, firstLevel } = await convert(t, chunks[i]);
    if (firstLevel.length === 0) continue;
    const r = await call(
      t,
      'POST',
      `/docx/v1/documents/${docId}/blocks/${docId}/descendant?document_revision_id=-1`,
      { children_id: firstLevel, index, descendants: blocks },
    );
    if (r.code !== 0) throw new Error(`写入第 ${i + 1}/${chunks.length} 段失败: ${r.code} ${r.msg}`);
    index += firstLevel.length;
    total += blocks.length;
    console.log(`  ✏️  第 ${i + 1}/${chunks.length} 段：顶层 ${firstLevel.length} 块（含子块共 ${blocks.length}）`);
  }

  const { tables, patched } = await autosizeTables(t, docId);
  console.log(`  📐 列宽自适应：${tables} 张表 / ${patched} 列已设置`);

  console.log(`\n✅ 同步完成：${title}`);
  console.log(`   顶层块 ${index} 个 / 总块 ${total} 个`);
  console.log(`   🔗 https://gingjqcjzc.feishu.cn/wiki/${node.node_token}`);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
