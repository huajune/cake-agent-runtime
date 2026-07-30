import fs from "node:fs";
import path from "node:path";

// 输出直接落 docs 图库（与 booking-handoff-state-machine 等同目录），不依赖调用时的 cwd。
const outputPath = path.resolve(
  import.meta.dirname,
  "../../docs/architecture/diagrams/agent-quality-assurance.excalidraw",
);
let serial = 2000;
const elements = [];

const common = (overrides = {}) => ({
  angle: 0,
  strokeColor: "#1e1e1e",
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
  elements.push({
    ...common(options),
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
  });
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
  const fontSize = options.fontSize ?? 18;
  const lineHeight = options.lineHeight ?? 1.25;
  const lines = value.split("\n");
  const estimatedWidth =
    options.width ??
    Math.max(...lines.map((line) => [...line].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? fontSize : fontSize * 0.58), 0)));
  const height = options.height ?? lines.length * fontSize * lineHeight;
  elements.push({
    ...common({
      strokeColor: options.strokeColor ?? "#1e1e1e",
      strokeWidth: 1,
      roughness: 0,
      roundness: null,
    }),
    id,
    type: "text",
    x,
    y,
    width: estimatedWidth,
    height,
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
      strokeColor: options.strokeColor ?? "#495057",
      backgroundColor: "transparent",
      strokeWidth: options.strokeWidth ?? 2,
      strokeStyle: options.strokeStyle ?? "solid",
      roughness: 1,
      roundness: options.roundness ?? { type: 2 },
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

// Title and context
text("title", 82, 48, "蛋糕agent", {
  fontSize: 34,
  strokeColor: "#183153",
});
text("subtitle", 84, 96, "每一轮对话都经过实时防护、全量巡检与自动修复闭环", {
  fontSize: 16,
  strokeColor: "#5c677d",
});
rectangle("daily-volume", 1130, 48, 230, 54, {
  strokeColor: "#1971c2",
  backgroundColor: "#e7f5ff",
  strokeWidth: 1,
});
text("daily-volume-text", 1155, 63, "≈ 1,200 轮 / 天", {
  fontSize: 19,
  strokeColor: "#1864ab",
});

// Stage 1
rectangle("stage-1-frame", 60, 145, 1320, 260, {
  strokeColor: "#a5d8ff",
  backgroundColor: "#f1f8ff",
  strokeWidth: 1,
});
rectangle("stage-1-tag", 82, 163, 236, 40, {
  strokeColor: "#1971c2",
  backgroundColor: "#d0ebff",
  strokeWidth: 1,
});
text("stage-1-title", 102, 173, "第一道 · 回复发出前", {
  fontSize: 17,
  strokeColor: "#1864ab",
});
text("stage-1-time", 1160, 174, "实时 · 每条回复", {
  fontSize: 15,
  strokeColor: "#5c7cfa",
});

const cards = [
  {
    id: "question",
    x: 96,
    color: "#1971c2",
    fill: "#d0ebff",
    numFill: "#1971c2",
    title: "候选人提问",
    body: "进入 Agent 对话上下文",
  },
  {
    id: "generate",
    x: 390,
    color: "#4263eb",
    fill: "#e5dbff",
    numFill: "#7048e8",
    title: "Agent 生成回复",
    body: "结合岗位库与会话信息",
  },
  {
    id: "guard",
    x: 684,
    color: "#e67700",
    fill: "#fff3bf",
    numFill: "#f08c00",
    title: "守卫检查",
    body: "事实对账 · 承诺校验 · 风险拦截",
  },
  {
    id: "send",
    x: 978,
    color: "#2b8a3e",
    fill: "#d3f9d8",
    numFill: "#37b24d",
    title: "发给候选人",
    body: "只发送检查通过的版本",
  },
];

cards.forEach((card, index) => {
  rectangle(`${card.id}-card`, card.x, 220, 230, 112, {
    strokeColor: card.color,
    backgroundColor: card.fill,
    strokeWidth: card.id === "guard" ? 3 : 2,
  });
  ellipse(`${card.id}-number`, card.x + 16, 236, 34, 34, {
    strokeColor: card.numFill,
    backgroundColor: card.numFill,
    strokeWidth: 1,
  });
  text(`${card.id}-number-text`, card.x + 28, 243, String(index + 1), {
    fontSize: 16,
    strokeColor: "#ffffff",
    width: 10,
  });
  text(`${card.id}-title`, card.x + 64, 237, card.title, {
    fontSize: 19,
    strokeColor: card.color,
  });
  text(`${card.id}-body`, card.x + 20, 286, card.body, {
    fontSize: 14,
    strokeColor: "#495057",
  });
});

arrow("flow-1", 330, 276, [[0, 0], [52, 0]], { strokeColor: "#748ffc" });
arrow("flow-2", 624, 276, [[0, 0], [52, 0]], { strokeColor: "#748ffc" });
arrow("flow-3", 918, 276, [[0, 0], [52, 0]], { strokeColor: "#51cf66" });
text("pass-label", 928, 249, "通过", { fontSize: 13, strokeColor: "#2b8a3e" });

rectangle("guard-note", 498, 348, 640, 38, {
  strokeColor: "#fcc419",
  backgroundColor: "#fff9db",
  strokeWidth: 1,
});
text(
  "guard-note-text",
  518,
  358,
  "编造薪资/门店、假称“已报名”“已发邀请”等内容，会在发出前被拦截或改写",
  { fontSize: 14, strokeColor: "#7c4a03" },
);

// Observability foundation
rectangle("observability", 60, 435, 1320, 108, {
  strokeColor: "#364fc7",
  backgroundColor: "#edf2ff",
  strokeWidth: 2,
});
rectangle("observability-mark", 60, 435, 14, 108, {
  strokeColor: "#364fc7",
  backgroundColor: "#4c6ef5",
  strokeWidth: 0,
});
text("observability-title", 100, 457, "观测底座 · 全程留档", {
  fontSize: 21,
  strokeColor: "#364fc7",
});
text(
  "observability-body",
  100,
  493,
  "每轮对话内容、岗位查询、检查结果与最终回复均可逐条回溯，为巡检和修复提供证据链",
  { fontSize: 15, strokeColor: "#495057" },
);
text("observability-chip", 1188, 471, "完整可追溯", {
  fontSize: 16,
  strokeColor: "#364fc7",
});

// Stage 2
text("stage-2-title", 80, 590, "第二道 · 每日全量巡检", {
  fontSize: 22,
  strokeColor: "#2b8a3e",
});
text("stage-2-subtitle", 1115, 595, "每天 06:00", {
  fontSize: 16,
  strokeColor: "#2f9e44",
});

rectangle("auto-audit", 80, 632, 620, 164, {
  strokeColor: "#2f9e44",
  backgroundColor: "#ebfbee",
  strokeWidth: 2,
});
rectangle("auto-audit-label", 102, 652, 176, 36, {
  strokeColor: "#2f9e44",
  backgroundColor: "#d3f9d8",
  strokeWidth: 1,
});
text("auto-audit-label-text", 122, 661, "自动巡检 · 主通道", {
  fontSize: 16,
  strokeColor: "#2b8a3e",
});
text(
  "auto-audit-body",
  108,
  710,
  "9 个维度扫描前一天全部对话\n输出问题清单并与前一天环比\n连续出问题的会话自动提高优先级",
  { fontSize: 16, strokeColor: "#343a40", lineHeight: 1.45 },
);

rectangle("ops-feedback", 740, 632, 620, 164, {
  strokeColor: "#6741d9",
  backgroundColor: "#f3f0ff",
  strokeWidth: 2,
});
rectangle("ops-feedback-label", 762, 652, 162, 36, {
  strokeColor: "#6741d9",
  backgroundColor: "#e5dbff",
  strokeWidth: 1,
});
text("ops-feedback-label-text", 782, 661, "运营反馈 · 补充", {
  fontSize: 16,
  strokeColor: "#5f3dc4",
});
text(
  "ops-feedback-body",
  768,
  710,
  "补充系统尚未识别的问题\n统一填入 BadCase 表\n无需在群里 @，修复环会自动领取",
  { fontSize: 16, strokeColor: "#343a40", lineHeight: 1.45 },
);

arrow("audit-to-repair", 390, 800, [[0, 0], [0, 56], [220, 56]], {
  strokeColor: "#2f9e44",
});
arrow("feedback-to-repair", 1050, 800, [[0, 0], [0, 56], [-220, 56]], {
  strokeColor: "#6741d9",
});

// Stage 3
rectangle("repair-loop", 270, 872, 900, 184, {
  strokeColor: "#e8590c",
  backgroundColor: "#fff4e6",
  strokeWidth: 3,
});
rectangle("repair-tag", 298, 894, 252, 40, {
  strokeColor: "#e8590c",
  backgroundColor: "#ffe8cc",
  strokeWidth: 1,
});
text("repair-tag-text", 318, 904, "第三道 · 每日自动修复环", {
  fontSize: 18,
  strokeColor: "#d9480f",
});
text("repair-time", 1006, 906, "每天 07:00", {
  fontSize: 16,
  strokeColor: "#e8590c",
});
text(
  "repair-body",
  310,
  958,
  "汇总巡检清单 + BadCase 未解决项  →  逐条根因分析  →  按风险分流  →  自动回写处理状态",
  { fontSize: 17, strokeColor: "#343a40" },
);
rectangle("low-risk", 314, 1004, 332, 34, {
  strokeColor: "#2f9e44",
  backgroundColor: "#d3f9d8",
  strokeWidth: 1,
});
text("low-risk-text", 336, 1012, "低风险：直接改代码并验证", {
  fontSize: 14,
  strokeColor: "#2b8a3e",
});
rectangle("high-risk", 792, 1004, 332, 34, {
  strokeColor: "#e67700",
  backgroundColor: "#fff3bf",
  strokeWidth: 1,
});
text("high-risk-text", 814, 1012, "高风险：先产出决策报告", {
  fontSize: 14,
  strokeColor: "#d9480f",
});

// Outputs
arrow("repair-to-checks", 482, 1058, [[0, 0], [0, 58]], { strokeColor: "#2f9e44" });
arrow("repair-to-docs", 958, 1058, [[0, 0], [0, 58]], { strokeColor: "#6741d9" });

rectangle("new-checks", 80, 1124, 620, 124, {
  strokeColor: "#2f9e44",
  backgroundColor: "#ebfbee",
  strokeWidth: 2,
});
text("new-checks-title", 108, 1146, "修复沉淀为新的检查项", {
  fontSize: 20,
  strokeColor: "#2b8a3e",
});
text("new-checks-body", 108, 1184, "下次巡检自动带上（现有 ⑥⑦⑨ 即由此沉淀）", {
  fontSize: 15,
  strokeColor: "#495057",
});

rectangle("governance-doc", 740, 1124, 620, 124, {
  strokeColor: "#6741d9",
  backgroundColor: "#f3f0ff",
  strokeWidth: 2,
});
text("governance-doc-title", 768, 1146, "治理文档自动更新", {
  fontSize: 20,
  strokeColor: "#5f3dc4",
});
text("governance-doc-body", 768, 1184, "修复进展自动写入；运营订阅后可及时收到更新", {
  fontSize: 15,
  strokeColor: "#495057",
});

arrow(
  "closed-loop",
  80,
  1188,
  [
    [0, 0],
    [-38, 0],
    [-38, -506],
    [30, -506],
  ],
  {
    strokeColor: "#2f9e44",
    strokeStyle: "dashed",
    strokeWidth: 3,
  },
);
text("closed-loop-label", 8, 862, "闭\n环", {
  fontSize: 18,
  strokeColor: "#2b8a3e",
  width: 18,
  lineHeight: 1.35,
});

// Scope note
rectangle("scope-note", 60, 1280, 1320, 72, {
  strokeColor: "#adb5bd",
  backgroundColor: "#f8f9fa",
  strokeWidth: 1,
  strokeStyle: "dashed",
});
text(
  "scope-note-text",
  84,
  1302,
  "边界：守卫检查负责“能否与岗位库对账”；候选人体感、业务口径、岗位数据源问题由运营反馈补齐。",
  { fontSize: 14, strokeColor: "#5c677d" },
);

const scene = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: "#f8fafc",
  },
  files: {},
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(scene, null, 2)}\n`);
console.log(outputPath);
