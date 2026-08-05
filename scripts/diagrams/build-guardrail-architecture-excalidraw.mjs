import fs from "node:fs";
import path from "node:path";

const outputPath = path.resolve(
  import.meta.dirname,
  "../../docs/architecture/diagrams/guardrail-architecture.excalidraw",
);

let serial = 4000;
const elements = [];

const palette = {
  ink: "#1e293b",
  muted: "#64748b",
  line: "#94a3b8",
  canvas: "#f8fafc",
  blue: "#2563eb",
  blueFill: "#dbeafe",
  cyan: "#0891b2",
  cyanFill: "#cffafe",
  violet: "#7c3aed",
  violetFill: "#ede9fe",
  amber: "#d97706",
  amberFill: "#fef3c7",
  red: "#dc2626",
  redFill: "#fee2e2",
  green: "#16a34a",
  greenFill: "#dcfce7",
  slateFill: "#f1f5f9",
  white: "#ffffff",
};

const common = (overrides = {}) => ({
  angle: 0,
  strokeColor: palette.ink,
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: { type: 3 },
  seed: serial++,
  version: 1,
  versionNonce: serial++,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...overrides,
});

function rectangle(id, x, y, width, height, options = {}) {
  elements.push({ ...common(options), id, type: "rectangle", x, y, width, height });
}

function ellipse(id, x, y, width, height, options = {}) {
  elements.push({
    ...common({ roundness: null, ...options }),
    id,
    type: "ellipse",
    x,
    y,
    width,
    height,
  });
}

function text(id, x, y, value, options = {}) {
  const fontSize = options.fontSize ?? 16;
  const lineHeight = options.lineHeight ?? 1.25;
  const lines = value.split("\n");
  const estimatedWidth =
    options.width ??
    Math.max(
      ...lines.map((line) =>
        [...line].reduce(
          (sum, char) => sum + (char.charCodeAt(0) > 255 ? fontSize : fontSize * 0.58),
          0,
        ),
      ),
    );
  elements.push({
    ...common({
      strokeColor: options.strokeColor ?? palette.ink,
      strokeWidth: 1,
      roughness: 0,
      roundness: null,
    }),
    id,
    type: "text",
    x,
    y,
    width: estimatedWidth,
    height: options.height ?? lines.length * fontSize * lineHeight,
    text: value,
    originalText: value,
    fontSize,
    fontFamily: 2,
    textAlign: options.textAlign ?? "left",
    verticalAlign: options.verticalAlign ?? "top",
    containerId: null,
    lineHeight,
    baseline: Math.round(fontSize * 0.82),
  });
}

function arrow(id, x, y, points, options = {}) {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  elements.push({
    ...common({
      strokeColor: options.strokeColor ?? palette.line,
      backgroundColor: "transparent",
      strokeWidth: options.strokeWidth ?? 2,
      strokeStyle: options.strokeStyle ?? "solid",
      roughness: options.roughness ?? 1,
      roundness: { type: 2 },
    }),
    id,
    type: "arrow",
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: options.startArrowhead ?? null,
    endArrowhead: options.endArrowhead ?? "arrow",
    elbowed: false,
  });
}

function card(id, x, y, width, height, titleValue, bodyValue, options = {}) {
  rectangle(id, x, y, width, height, {
    strokeColor: options.strokeColor ?? palette.line,
    backgroundColor: options.backgroundColor ?? palette.white,
    strokeWidth: options.strokeWidth ?? 2,
    strokeStyle: options.strokeStyle ?? "solid",
  });
  if (options.badge) {
    rectangle(`${id}-badge`, x + 16, y + 15, options.badgeWidth ?? 84, 28, {
      strokeColor: options.strokeColor ?? palette.line,
      backgroundColor: options.badgeFill ?? options.backgroundColor ?? palette.slateFill,
      strokeWidth: 1,
    });
    text(`${id}-badge-text`, x + 28, y + 21, options.badge, {
      fontSize: 13,
      strokeColor: options.strokeColor ?? palette.ink,
    });
  }
  text(`${id}-title`, x + 18, y + (options.badge ? 54 : 18), titleValue, {
    fontSize: options.titleSize ?? 19,
    strokeColor: options.titleColor ?? options.strokeColor ?? palette.ink,
  });
  text(`${id}-body`, x + 18, y + (options.badge ? 87 : 54), bodyValue, {
    fontSize: options.bodySize ?? 14,
    lineHeight: options.lineHeight ?? 1.42,
    strokeColor: options.bodyColor ?? palette.muted,
  });
}

// Title
text("title", 64, 42, "Cake Agent · Guardrail 双环架构", {
  fontSize: 34,
  strokeColor: "#0f172a",
});
text(
  "subtitle",
  66,
  91,
  "实时三层防线守住输入、动作与候选人可见回复；事后环用真实投递物反哺规则、生成与回归资产",
  { fontSize: 16, strokeColor: palette.muted },
);

rectangle("legend-observe", 1330, 46, 106, 34, {
  strokeColor: palette.cyan,
  backgroundColor: palette.cyanFill,
  strokeWidth: 1,
});
text("legend-observe-text", 1352, 54, "observe", {
  fontSize: 14,
  strokeColor: palette.cyan,
});
rectangle("legend-revise", 1448, 46, 106, 34, {
  strokeColor: palette.amber,
  backgroundColor: palette.amberFill,
  strokeWidth: 1,
});
text("legend-revise-text", 1473, 54, "revise", {
  fontSize: 14,
  strokeColor: palette.amber,
});
rectangle("legend-block", 1566, 46, 106, 34, {
  strokeColor: palette.red,
  backgroundColor: palette.redFill,
  strokeWidth: 1,
});
text("legend-block-text", 1592, 54, "block", {
  fontSize: 14,
  strokeColor: palette.red,
});

// Real-time loop frame
rectangle("realtime-frame", 48, 132, 1640, 800, {
  strokeColor: "#bfdbfe",
  backgroundColor: "#f8fbff",
  strokeWidth: 2,
});
rectangle("realtime-tag", 68, 150, 304, 38, {
  strokeColor: palette.blue,
  backgroundColor: palette.blueFill,
  strokeWidth: 1,
});
text("realtime-tag-text", 88, 159, "事前实时环 · 每轮 / 热路径", {
  fontSize: 17,
  strokeColor: palette.blue,
});
text("realtime-slo", 1495, 158, "只读审查 + 单轮有界修复", {
  fontSize: 14,
  strokeColor: palette.muted,
});

// Main hot path
card("candidate", 82, 226, 154, 100, "候选人消息", "文本 / 图片\n多消息批次", {
  strokeColor: palette.blue,
  backgroundColor: palette.blueFill,
  titleSize: 18,
});
card(
  "input-guard",
  290,
  204,
  254,
  154,
  "Input Guardrail",
  "Prompt injection → 加固 / 观测\n高置信风险 → pause hosting\n命中即短路，不进入 Agent",
  {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    badge: "PRE-AGENT",
    badgeWidth: 100,
  },
);
card(
  "agent-loop",
  612,
  204,
  270,
  154,
  "Chat Agent Loop",
  "Prompt 负责预防与生成\n记忆 / 岗位 / 地理证据参与决策\n工具结果成为外生 ground truth",
  {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    badge: "GENERATOR",
    badgeWidth: 104,
  },
);
card(
  "draft",
  950,
  226,
  178,
  100,
  "首版草稿",
  "候选人可见文本\n尚未允许投递",
  {
    strokeColor: palette.amber,
    backgroundColor: palette.amberFill,
    titleSize: 18,
  },
);

arrow("candidate-to-input", 236, 276, [[0, 0], [46, 0]], { strokeColor: palette.blue });
arrow("input-to-agent", 544, 276, [[0, 0], [60, 0]], { strokeColor: palette.violet });
arrow("agent-to-draft", 882, 276, [[0, 0], [60, 0]], { strokeColor: palette.blue });

// Input short circuit
card("input-blocked", 290, 396, 254, 90, "guardrail_blocked / inbound", "暂停托管 · 告警 · 不生成回复", {
  strokeColor: palette.red,
  backgroundColor: palette.redFill,
  titleSize: 16,
  bodySize: 13,
});
arrow("input-short-circuit", 417, 358, [[0, 0], [0, 30]], { strokeColor: palette.red });
text("input-short-circuit-label", 429, 366, "高风险", {
  fontSize: 13,
  strokeColor: palette.red,
});

// Tool guardrail and catalog
card(
  "tool-guard",
  612,
  410,
  516,
  166,
  "Tool Guardrail · 副作用前门禁",
  "jobId 出处 / precheck 契约 / 真名与姓名权威\n拉群城市与时机 / 筛选题 / 岗位硬要求\n拒绝动作时返回结构化 collect / reject / handoff 结果",
  {
    strokeColor: palette.cyan,
    backgroundColor: palette.cyanFill,
    badge: "TOOL RUNTIME",
    badgeWidth: 120,
  },
);
arrow("agent-to-tool", 720, 358, [[0, 0], [0, 44]], { strokeColor: palette.cyan });
arrow("tool-to-agent", 790, 410, [[0, 0], [0, -44]], {
  strokeColor: palette.cyan,
  strokeStyle: "dashed",
});
text("tool-call-label", 668, 374, "tool call", { fontSize: 12, strokeColor: palette.cyan });
text("tool-result-label", 804, 374, "result / side effect", {
  fontSize: 12,
  strokeColor: palette.cyan,
});

// Output guardrail composite
rectangle("output-frame", 1172, 204, 478, 528, {
  strokeColor: palette.amber,
  backgroundColor: "#fffbeb",
  strokeWidth: 3,
});
rectangle("output-tag", 1192, 222, 224, 36, {
  strokeColor: palette.amber,
  backgroundColor: palette.amberFill,
  strokeWidth: 1,
});
text("output-tag-text", 1210, 230, "Output Guardrail · Veto", {
  fontSize: 16,
  strokeColor: palette.amber,
});
text("output-flags", 1455, 232, "runtime flags", {
  fontSize: 13,
  strokeColor: palette.muted,
});

card("pre-sanitize", 1200, 280, 196, 82, "审查前净化", "仅剥时间标记\n保留泄漏证据", {
  strokeColor: palette.line,
  backgroundColor: palette.slateFill,
  titleSize: 16,
  bodySize: 12,
});
card("packet", 1420, 280, 204, 82, "Evidence Packet", "裁剪 toolCalls / 用户消息\nredLines / rule hits", {
  strokeColor: palette.cyan,
  backgroundColor: palette.cyanFill,
  titleSize: 16,
  bodySize: 12,
});
card("hard-rules", 1200, 386, 196, 112, "① Hard Rules", "确定性优先\n缺省 observe\n发牌后才可 revise / block", {
  strokeColor: palette.violet,
  backgroundColor: palette.violetFill,
  titleSize: 16,
  bodySize: 12,
});
card("semantic", 1420, 386, 204, 112, "② Semantic Reviewer", "trigger + shadow / enforce\n只凭 evidence 裁决\n低置信强制降 observe", {
  strokeColor: palette.blue,
  backgroundColor: palette.blueFill,
  titleSize: 16,
  bodySize: 12,
});
card("merge", 1268, 532, 288, 86, "③ 合并裁决", "block > revise > observe > pass\n高风险故障 fail-close；普通语义 fail-open", {
  strokeColor: palette.amber,
  backgroundColor: palette.amberFill,
  titleSize: 17,
  bodySize: 12,
});
arrow("draft-to-output", 1128, 276, [[0, 0], [36, 0]], { strokeColor: palette.amber });
arrow("tool-to-packet", 1128, 494, [[0, 0], [34, 0], [34, -170], [284, -170]], {
  strokeColor: palette.cyan,
  strokeStyle: "dashed",
});
arrow("sanitize-to-rules", 1298, 362, [[0, 0], [0, 16]], { strokeColor: palette.line });
arrow("packet-to-semantic", 1522, 362, [[0, 0], [0, 16]], { strokeColor: palette.cyan });
arrow("rules-to-merge", 1298, 498, [[0, 0], [0, 22], [70, 22]], {
  strokeColor: palette.violet,
});
arrow("semantic-to-merge", 1522, 498, [[0, 0], [0, 22], [-68, 22]], {
  strokeColor: palette.blue,
});

// Decision split and repair
card("sendable", 1180, 776, 224, 112, "PASS / OBSERVE", "最终 sanitizer\n→ delivery 投递候选人", {
  strokeColor: palette.green,
  backgroundColor: palette.greenFill,
  titleSize: 17,
});
card("repair-entry", 1430, 776, 224, 112, "REVISE / BLOCK", "进入一次受控修复\n或封闭形态直达静默", {
  strokeColor: palette.red,
  backgroundColor: palette.redFill,
  titleSize: 17,
});
arrow("merge-to-sendable", 1370, 618, [[0, 0], [0, 84], [-78, 84], [-78, 150]], {
  strokeColor: palette.green,
});
arrow("merge-to-repair", 1450, 618, [[0, 0], [0, 84], [92, 84], [92, 150]], {
  strokeColor: palette.red,
});

// Repair lane within realtime frame
rectangle("repair-lane", 80, 636, 1018, 252, {
  strokeColor: "#fed7aa",
  backgroundColor: "#fff7ed",
  strokeWidth: 2,
});
text("repair-lane-title", 102, 654, "受控 Repair · hard cap = 1", {
  fontSize: 18,
  strokeColor: palette.amber,
});
card("direct-silence", 104, 702, 206, 146, "封闭形态", "元旁白 / 工具残文\n→ 直达静默\n不让 LLM 再写一遍", {
  strokeColor: palette.red,
  backgroundColor: palette.redFill,
  titleSize: 16,
  bodySize: 13,
});
card("fence-fast", 330, 702, 206, 146, "确定性快通道", "仅围栏泄漏\n→ 机械剥离\n正文逐字保留", {
  strokeColor: palette.cyan,
  backgroundColor: palette.cyanFill,
  titleSize: 16,
  bodySize: 13,
});
card("repair-agent", 556, 702, 240, 146, "ReplyRepairAgent", "独立 Repair 模型 · 无工具\n只做最小必要改写\n注入时间锚 / 证据 / 已提交副作用", {
  strokeColor: palette.amber,
  backgroundColor: palette.amberFill,
  titleSize: 16,
  bodySize: 13,
});
card("second-review", 816, 702, 258, 146, "二审 + 回归闸 + 收敛", "再跑 output guardrail\n比较首版与修复版是否退步\nP1/P2 fail-open；P0 失败 block", {
  strokeColor: palette.violet,
  backgroundColor: palette.violetFill,
  titleSize: 16,
  bodySize: 13,
});
arrow("repair-entry-to-lane", 1542, 888, [[0, 0], [0, 22], [-1244, 22], [-1244, -54]], {
  strokeColor: palette.red,
});
arrow("direct-to-second", 310, 775, [[0, 0], [498, 0]], {
  strokeColor: palette.red,
  strokeStyle: "dashed",
});
arrow("fence-to-second", 536, 775, [[0, 0], [272, 0]], { strokeColor: palette.cyan });
arrow("repair-agent-to-second", 796, 775, [[0, 0], [12, 0]], { strokeColor: palette.amber });
arrow("second-to-sendable", 945, 702, [[0, 0], [0, -30], [347, -30], [347, 96]], {
  strokeColor: palette.green,
  strokeStyle: "dashed",
});
text("second-to-sendable-label", 1005, 650, "采纳修复版 / 回退首版 / 两版都不投", {
  fontSize: 12,
  strokeColor: palette.muted,
});

// Persistence strip
rectangle("evidence-strip", 48, 956, 1640, 178, {
  strokeColor: "#cbd5e1",
  backgroundColor: palette.slateFill,
  strokeWidth: 2,
});
rectangle("evidence-tag", 68, 974, 286, 36, {
  strokeColor: palette.violet,
  backgroundColor: palette.violetFill,
  strokeWidth: 1,
});
text("evidence-tag-text", 88, 982, "可观测证据面 · trace_id 贯通", {
  fontSize: 16,
  strokeColor: palette.violet,
});
card("review-records", 82, 1026, 410, 82, "guardrail_review_records", "首版 / 修复版 / violation / semantic review / 最终裁决", {
  strokeColor: palette.violet,
  backgroundColor: palette.white,
  titleSize: 16,
  bodySize: 12,
});
card("processing-records", 526, 1026, 410, 82, "message_processing_records", "guardrail_input / output 紧凑 trace + reply_preview 投递物", {
  strokeColor: palette.blue,
  backgroundColor: palette.white,
  titleSize: 16,
  bodySize: 12,
});
card("execution-events", 970, 1026, 330, 82, "agent_execution_events", "工具调用轨迹 / 真实副作用 / 错误", {
  strokeColor: palette.cyan,
  backgroundColor: palette.white,
  titleSize: 16,
  bodySize: 12,
});
card("alerts", 1334, 1026, 320, 82, "告警与调试视图", "reviewer 故障 / 守卫命中 / 完整时间线", {
  strokeColor: palette.red,
  backgroundColor: palette.white,
  titleSize: 16,
  bodySize: 12,
});
arrow("hotpath-to-evidence", 1610, 888, [[0, 0], [0, 60]], {
  strokeColor: palette.line,
  strokeStyle: "dashed",
});

// Offline loop
rectangle("offline-frame", 48, 1160, 1640, 300, {
  strokeColor: "#bbf7d0",
  backgroundColor: "#f7fff9",
  strokeWidth: 2,
});
rectangle("offline-tag", 68, 1178, 318, 38, {
  strokeColor: palette.green,
  backgroundColor: palette.greenFill,
  strokeWidth: 1,
});
text("offline-tag-text", 88, 1187, "事后离线环 · T+1 / 真实投递物", {
  fontSize: 17,
  strokeColor: palette.green,
});
text("offline-note", 1325, 1187, "离线失败不影响消息热路径", {
  fontSize: 14,
  strokeColor: palette.muted,
});

card(
  "daily-scan",
  82,
  1240,
  374,
  162,
  "L0 / L1 / L2 每日扫描",
  "消费 shadow findings\n确定性全量回扫 reply_preview\n高危切片 LLM 定向抽扫\n跨轮承诺 / 静默 / 重复追问可见",
  {
    strokeColor: palette.green,
    backgroundColor: palette.greenFill,
    titleSize: 18,
  },
);
card(
  "findings",
  500,
  1240,
  330,
  162,
  "BadCase Findings",
  "按 trace 复核与归因\n本地 md 日报 / 审计样本\n高置信案例进入回归资产",
  {
    strokeColor: palette.amber,
    backgroundColor: palette.amberFill,
    titleSize: 18,
  },
);
card(
  "feedback",
  874,
  1240,
  444,
  162,
  "反馈流 · 刻意走 PR / 发布",
  "① 生成侧根修：prompt / memory / tool 描述\n② 新检查先 shadow / observe，精度达标再 enforce\n③ 两期战绩决定发牌 / 收牌，长期无效则退役",
  {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    titleSize: 18,
  },
);
card(
  "catalog",
  1362,
  1240,
  292,
  162,
  "统一 Catalog",
  "input / tool / output\n外生信号 · action · owner\n验证证据 · residual risk",
  {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    titleSize: 18,
  },
);
arrow("evidence-to-daily", 286, 1134, [[0, 0], [0, 98]], {
  strokeColor: palette.green,
  strokeStyle: "dashed",
});
arrow("daily-to-findings", 456, 1321, [[0, 0], [36, 0]], { strokeColor: palette.green });
arrow("findings-to-feedback", 830, 1321, [[0, 0], [36, 0]], { strokeColor: palette.amber });
arrow("feedback-to-catalog", 1318, 1321, [[0, 0], [36, 0]], { strokeColor: palette.violet });
arrow(
  "closed-loop",
  1508,
  1240,
  [
    [0, 0],
    [0, -72],
    [-1060, -72],
    [-1060, -224],
  ],
  {
    strokeColor: palette.green,
    strokeStyle: "dashed",
    strokeWidth: 3,
  },
);
text("closed-loop-text", 854, 1142, "新规则 / 新回归形态 / action 发牌调整", {
  fontSize: 13,
  strokeColor: palette.green,
});

const scene = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: palette.canvas,
  },
  files: {},
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(scene, null, 2)}\n`);
console.log(outputPath);
