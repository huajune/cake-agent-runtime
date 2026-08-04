import fs from "node:fs";
import path from "node:path";

const diagramDir = path.resolve(import.meta.dirname, "../../docs/architecture/diagrams");

const palette = {
  ink: "#172033",
  muted: "#64748b",
  line: "#94a3b8",
  canvas: "#f8fafc",
  white: "#ffffff",
  slateFill: "#f1f5f9",
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
  pink: "#db2777",
  pinkFill: "#fce7f3",
};

function createCanvas(seedStart = 6000) {
  let serial = seedStart;
  const elements = [];
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

  const rectangle = (id, x, y, width, height, options = {}) => {
    elements.push({ ...common(options), id, type: "rectangle", x, y, width, height });
  };

  const ellipse = (id, x, y, width, height, options = {}) => {
    elements.push({
      ...common({ roundness: null, ...options }),
      id,
      type: "ellipse",
      x,
      y,
      width,
      height,
    });
  };

  const text = (id, x, y, value, options = {}) => {
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
  };

  const arrow = (id, x, y, points, options = {}) => {
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
  };

  const card = (id, x, y, width, height, titleValue, bodyValue, options = {}) => {
    rectangle(id, x, y, width, height, {
      strokeColor: options.strokeColor ?? palette.line,
      backgroundColor: options.backgroundColor ?? palette.white,
      strokeWidth: options.strokeWidth ?? 2,
      strokeStyle: options.strokeStyle ?? "solid",
    });
    if (options.badge) {
      rectangle(`${id}-badge`, x + 16, y + 15, options.badgeWidth ?? 90, 28, {
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
  };

  return { elements, rectangle, ellipse, text, arrow, card };
}

function scene(elements) {
  return {
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
}

function buildRelationshipScene() {
  const { elements, rectangle, ellipse, text, arrow, card } = createCanvas(6000);

  text("rel-title", 64, 42, "Cake Agent · 候选人记忆关系系统", {
    fontSize: 34,
    strokeColor: "#0f172a",
  });
  text(
    "rel-subtitle",
    82,
    91,
    "一个候选人可对应多个 Bot 会话；会话态按 session 隔离，长期画像按用户共享，并用字段级血缘连接回来",
    { fontSize: 16, strokeColor: palette.muted },
  );

  rectangle("identity-frame", 48, 132, 1640, 190, {
    strokeColor: "#bfdbfe",
    backgroundColor: "#f8fbff",
    strokeWidth: 2,
  });
  rectangle("identity-tag", 68, 150, 236, 36, {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    strokeWidth: 1,
  });
  text("identity-tag-text", 88, 158, "身份与会话基数关系", {
    fontSize: 16,
    strokeColor: palette.blue,
  });

  ellipse("candidate-node", 92, 202, 200, 86, {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    strokeWidth: 3,
  });
  text("candidate-node-title", 132, 220, "Candidate", {
    fontSize: 21,
    strokeColor: palette.blue,
  });
  text("candidate-node-key", 119, 252, "(corpId, userId)", {
    fontSize: 14,
    strokeColor: palette.muted,
  });

  card("bot-a", 424, 196, 250, 100, "招募经理 / Bot A", "imBotId = A\n拥有独立 chatId", {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    titleSize: 17,
    bodySize: 13,
  });
  card("session-a", 724, 196, 250, 100, "Session A", "sessionId = chatId A\n当前求职 episode", {
    strokeColor: palette.cyan,
    backgroundColor: palette.cyanFill,
    titleSize: 17,
    bodySize: 13,
  });
  card("bot-b", 1070, 196, 250, 100, "招募经理 / Bot B", "imBotId = B\n同一候选人的另一入口", {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    titleSize: 17,
    bodySize: 13,
  });
  card("session-b", 1370, 196, 250, 100, "Session B", "sessionId = chatId B\n与 Session A 隔离", {
    strokeColor: palette.cyan,
    backgroundColor: palette.cyanFill,
    titleSize: 17,
    bodySize: 13,
  });

  arrow("candidate-bot-a", 292, 231, [[0, 0], [124, 0]], { strokeColor: palette.blue });
  arrow("bot-a-session-a", 674, 246, [[0, 0], [42, 0]], { strokeColor: palette.violet });
  arrow("candidate-bot-b", 292, 264, [[0, 0], [170, 0], [170, 78], [890, 78], [890, 40]], {
    strokeColor: palette.blue,
    strokeStyle: "dashed",
  });
  arrow("bot-b-session-b", 1320, 246, [[0, 0], [42, 0]], { strokeColor: palette.violet });
  text("candidate-many-label", 318, 207, "1 : N", {
    fontSize: 13,
    strokeColor: palette.muted,
  });
  text("session-isolation-label", 995, 252, "按 session 隔离", {
    fontSize: 13,
    strokeColor: palette.muted,
  });

  // Session-owned state
  rectangle("session-state-frame", 48, 350, 1020, 510, {
    strokeColor: "#a5f3fc",
    backgroundColor: "#f5feff",
    strokeWidth: 2,
  });
  rectangle("session-state-tag", 68, 368, 324, 36, {
    strokeColor: palette.cyan,
    backgroundColor: palette.cyanFill,
    strokeWidth: 1,
  });
  text("session-state-tag-text", 88, 376, "Session 级关系 · Redis / 当前 episode", {
    fontSize: 16,
    strokeColor: palette.cyan,
  });
  text("session-state-ttl", 872, 378, "TTL · 不跨 session", {
    fontSize: 13,
    strokeColor: palette.muted,
  });

  card(
    "messages",
    78,
    432,
    286,
    152,
    "chat_messages",
    "候选人与助手消息时间线\nDB 是最终真相源\nRedis 窗口是短期热缓存",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.blueFill,
      badge: "SHORT-TERM",
      badgeWidth: 110,
      bodySize: 13,
    },
  );
  card(
    "session-facts",
    394,
    432,
    300,
    190,
    "sessionFacts",
    "interview_info + preferences\n字段级 confidence / source / evidence\n低置信不覆盖高置信\n当前轮工具可读 high 值",
    {
      strokeColor: palette.cyan,
      backgroundColor: palette.cyanFill,
      badge: "STRUCTURED",
      badgeWidth: 108,
      bodySize: 13,
    },
  );
  card(
    "episode-state",
    724,
    432,
    310,
    190,
    "岗位与品牌关系态",
    "lastCandidatePool / presentedJobs\ncurrentFocusJob / invalidatedJobIds\nbrand_state / lastJobListQuery\ninvitedGroups",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      badge: "EPISODE",
      badgeWidth: 88,
      bodySize: 13,
    },
  );
  card(
    "procedural",
    78,
    654,
    286,
    150,
    "Procedural State",
    "currentStage / fromStage\nadvancedAt / reason\n合法迁移由 advance_stage 校验",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.violetFill,
      badge: "PROCESS",
      badgeWidth: 88,
      bodySize: 13,
    },
  );
  card(
    "sidecar",
    394,
    654,
    300,
    150,
    "highConfidenceFacts",
    "只看当前轮新消息\n规则 / 城市 / 品牌 / 明确字段\n本对象不直接持久化",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      badge: "TURN SIDECAR",
      badgeWidth: 118,
      bodySize: 13,
    },
  );
  card(
    "active-recruitment",
    724,
    654,
    310,
    150,
    "Active Recruitment Case",
    "当前焦点岗位 + 预约上下文\n连接岗位、群、工单与候选人\n事务事实仍以业务系统为准",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      badge: "BUSINESS VIEW",
      badgeWidth: 122,
      bodySize: 13,
    },
  );
  arrow("messages-to-facts", 364, 506, [[0, 0], [22, 0]], { strokeColor: palette.blue });
  arrow("facts-to-episode", 694, 522, [[0, 0], [22, 0]], { strokeColor: palette.cyan });
  arrow("sidecar-to-facts", 544, 654, [[0, 0], [0, -24]], {
    strokeColor: palette.green,
    strokeStyle: "dashed",
  });
  text("sidecar-persist-label", 560, 626, "onTurnEnd 重新提取后写回", {
    fontSize: 12,
    strokeColor: palette.green,
  });

  // Long-term shared row
  rectangle("long-term-frame", 1100, 350, 588, 510, {
    strokeColor: "#c4b5fd",
    backgroundColor: "#fbfaff",
    strokeWidth: 2,
  });
  rectangle("long-term-tag", 1120, 368, 322, 36, {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    strokeWidth: 1,
  });
  text("long-term-tag-text", 1140, 376, "User 级关系 · Supabase / 跨 session", {
    fontSize: 16,
    strokeColor: palette.violet,
  });
  text("long-term-key", 1488, 378, "每用户一行", {
    fontSize: 13,
    strokeColor: palette.muted,
  });

  card(
    "profile-facts",
    1130,
    432,
    250,
    170,
    "profile_facts",
    "姓名 / 电话 / 性别 / 年龄\n学生 / 学历 / 健康证\n稳定与半稳定身份画像",
    {
      strokeColor: palette.pink,
      backgroundColor: palette.pinkFill,
      badge: "IDENTITY",
      badgeWidth: 86,
      bodySize: 13,
    },
  );
  card(
    "preference-facts",
    1410,
    432,
    248,
    170,
    "preference_facts",
    "城市 / 地点 / 品牌 / 岗位\n班次 / 薪资 / 用工形式\n最新会话快照式整组覆盖",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      badge: "PREFERENCE",
      badgeWidth: 104,
      bodySize: 13,
    },
  );
  card(
    "summary-data",
    1130,
    632,
    250,
    170,
    "summary_data",
    "recent[] + archive\nlastSettledBySession\n历史叙事，不参与硬判断",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.blueFill,
      badge: "HISTORY",
      badgeWidth: 84,
      bodySize: 13,
    },
  );
  card(
    "active-booking",
    1410,
    632,
    248,
    170,
    "active_booking",
    "work_order_id / job_id\n可保留多笔 bookings\n实时状态仍回查业务系统",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      badge: "POINTER",
      badgeWidth: 78,
      bodySize: 13,
    },
  );

  arrow("settlement-to-profile", 1034, 541, [[0, 0], [88, 0]], {
    strokeColor: palette.violet,
    strokeStyle: "dashed",
  });
  arrow("settlement-to-summary", 1034, 705, [[0, 0], [88, 0]], {
    strokeColor: palette.blue,
    strokeStyle: "dashed",
  });
  text("settlement-label", 1038, 512, "Settlement", {
    fontSize: 12,
    strokeColor: palette.violet,
  });

  // Provenance
  rectangle("provenance-strip", 48, 888, 1640, 146, {
    strokeColor: "#fbcfe8",
    backgroundColor: "#fff8fc",
    strokeWidth: 2,
  });
  text("provenance-title", 76, 910, "字段级 Fact Wrapper 与血缘", {
    fontSize: 19,
    strokeColor: palette.pink,
  });
  card("fact-wrapper", 76, 948, 390, 82, "value · confidence · source · evidence", "extractedAt / updatedAt", {
    strokeColor: palette.pink,
    backgroundColor: palette.pinkFill,
    titleSize: 15,
    bodySize: 12,
  });
  card("origin-wrapper", 498, 948, 370, 82, "originSessionId · originBotId", "追溯到哪段会话、哪位招募经理", {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    titleSize: 15,
    bodySize: 12,
  });
  card("confidence-policy", 900, 948, 350, 82, "confidence 决定消费权", "high 可进工具；medium / low 仅供参考", {
    strokeColor: palette.green,
    backgroundColor: palette.greenFill,
    titleSize: 15,
    bodySize: 12,
  });
  card("cross-session-policy", 1282, 948, 374, 82, "跨会话来源口径", "新 chat 发现他会话血缘 → 明示“此前咨询”", {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    titleSize: 15,
    bodySize: 12,
  });

  // Runtime recall
  rectangle("runtime-frame", 48, 1062, 1640, 300, {
    strokeColor: "#bbf7d0",
    backgroundColor: "#f7fff9",
    strokeWidth: 2,
  });
  rectangle("runtime-tag", 68, 1080, 290, 36, {
    strokeColor: palette.green,
    backgroundColor: palette.greenFill,
    strokeWidth: 1,
  });
  text("runtime-tag-text", 88, 1088, "运行时统一召回与差异化消费", {
    fontSize: 16,
    strokeColor: palette.green,
  });
  card(
    "memory-facade",
    82,
    1150,
    264,
    150,
    "MemoryService",
    "onTurnStart 并行召回\nonTurnEnd 一致写回\n外部不直接操作 Redis key",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.blueFill,
      badge: "FACADE",
      badgeWidth: 76,
      bodySize: 13,
    },
  );
  card(
    "recall-context",
    390,
    1150,
    360,
    150,
    "MemoryRecallContext",
    "shortTerm + sessionMemory + procedural\nlongTerm.profile / preferences / origin\n+ 当前轮 highConfidenceFacts",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.violetFill,
      badge: "SNAPSHOT",
      badgeWidth: 88,
      bodySize: 13,
    },
  );
  card(
    "prompt-consumer",
    794,
    1150,
    366,
    150,
    "Prompt / Generator",
    "展示多层事实与 metadata\n历史画像需披露来源并允许纠正\n本次表达优先于历史偏好",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      badge: "REFERENCE",
      badgeWidth: 98,
      bodySize: 13,
    },
  );
  card(
    "tool-consumer",
    1204,
    1150,
    438,
    150,
    "ToolBuildContext",
    "profile：只 unwrap high\nsessionFacts：high + 本轮 high 覆盖旧值\nprecheck：显式入参 > 本轮 > session / profile",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      badge: "PROGRAMMATIC",
      badgeWidth: 126,
      bodySize: 13,
    },
  );
  arrow("facade-to-context", 346, 1225, [[0, 0], [36, 0]], { strokeColor: palette.blue });
  arrow("context-to-prompt", 750, 1204, [[0, 0], [36, 0]], { strokeColor: palette.amber });
  arrow("context-to-tools", 750, 1250, [[0, 0], [100, 0], [100, 50], [446, 50], [446, 0]], {
    strokeColor: palette.green,
  });
  arrow("stores-to-facade", 846, 1034, [[0, 0], [0, 40], [-632, 40], [-632, 108]], {
    strokeColor: palette.line,
    strokeStyle: "dashed",
  });

  // Evidence-first design constitution (partially delivered target design)
  rectangle("constitution-frame", 48, 1392, 1640, 492, {
    strokeColor: "#fcd34d",
    backgroundColor: "#fffdf5",
    strokeWidth: 2,
  });
  rectangle("constitution-tag", 68, 1410, 426, 38, {
    strokeColor: palette.amber,
    backgroundColor: palette.amberFill,
    strokeWidth: 1,
  });
  text("constitution-tag-text", 88, 1419, "证据化设计宪法 · 目标态（当前部分交付）", {
    fontSize: 17,
    strokeColor: palette.amber,
  });

  card(
    "constitution-claim",
    82,
    1470,
    370,
    100,
    "记忆不是“值”",
    "每个字段是一条有出处的主张\n值、来源、证据、时间与血缘不可拆",
    {
      strokeColor: palette.pink,
      backgroundColor: palette.pinkFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "constitution-no-self-proof",
    480,
    1470,
    370,
    100,
    "LLM 有解释权，没有自证权",
    "模型可归一化、纠错、提交 Claim\nmodel_assertion 无外证不得放权",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "constitution-single-adjudication",
    878,
    1470,
    370,
    100,
    "一套规则，一个裁决点",
    "写入算几分、冲突谁赢、动作能否消费\n不能由每个工具各写一套 if",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.violetFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "constitution-deterministic-gate",
    1276,
    1470,
    378,
    100,
    "确定性守门，LLM 只降级不放权",
    "不可逆动作最终闸门必须确定性\n失败或争议回到确认 / 拒绝",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      titleSize: 16,
      bodySize: 12,
    },
  );

  card(
    "source-event",
    82,
    1606,
    270,
    112,
    "① 来源事件",
    "candidate messageId + quote\nlocation / tool result\nhuman_oob / booking event",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.blueFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "candidate-claim",
    392,
    1606,
    270,
    112,
    "② CandidateFactClaim",
    "field / value / operation\nproducer / interpretation\nassertedAt",
    {
      strokeColor: palette.cyan,
      backgroundColor: palette.cyanFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "fact-adjudicator",
    702,
    1606,
    270,
    112,
    "③ 统一裁决",
    "证据等级 + 新旧 + 明确程度\n冲突、否定、纠正、清除\n输出唯一当前有效状态",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.violetFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "effective-profile",
    1012,
    1606,
    290,
    112,
    "④ Effective Profile",
    "accepted / historical_unconfirmed\nconflicted / missing\nsupersededClaimIds",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "versioned-snapshot",
    1342,
    1606,
    312,
    112,
    "⑤ Versioned Snapshot",
    "factsVersion + messageWatermark\nprecheckId + acceptedClaimIds\n新消息使旧快照失效",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  arrow("event-to-claim", 352, 1662, [[0, 0], [32, 0]], { strokeColor: palette.blue });
  arrow("claim-to-adjudicator", 662, 1662, [[0, 0], [32, 0]], {
    strokeColor: palette.cyan,
  });
  arrow("adjudicator-to-profile", 972, 1662, [[0, 0], [32, 0]], {
    strokeColor: palette.violet,
  });
  arrow("profile-to-snapshot", 1302, 1662, [[0, 0], [32, 0]], {
    strokeColor: palette.amber,
  });

  rectangle("admission-matrix", 82, 1752, 1572, 100, {
    strokeColor: palette.line,
    backgroundColor: palette.white,
    strokeWidth: 1,
  });
  text("admission-title", 102, 1769, "按动作风险采信，而不是“一份画像到处通吃”", {
    fontSize: 16,
    strokeColor: palette.ink,
  });
  text(
    "admission-irreversible",
    102,
    1805,
    "不可逆副作用：≥ T2，且本会话产生或确认",
    { fontSize: 13, strokeColor: palette.red },
  );
  text(
    "admission-display",
    500,
    1805,
    "对外展示：本会话 T1；跨会话只能披露并确认",
    { fontSize: 13, strokeColor: palette.amber },
  );
  text(
    "admission-search",
    948,
    1805,
    "内部检索：T1 / T2 / T3 均可参考",
    { fontSize: 13, strokeColor: palette.green },
  );
  text(
    "admission-reachout",
    1272,
    1805,
    "触达：先查 human_oob 负向事实",
    { fontSize: 13, strokeColor: palette.violet },
  );

  return scene(elements);
}

function buildProfileScene() {
  const { elements, rectangle, ellipse, text, arrow, card } = createCanvas(9000);

  text("profile-title", 64, 42, "Cake Agent · 候选人画像模型", {
    fontSize: 34,
    strokeColor: "#0f172a",
  });
  text(
    "profile-subtitle",
    82,
    91,
    "画像不是一份扁平 JSON：稳定身份、长期意向、当前 episode、流程指针与历史摘要分别拥有不同生命周期和消费权限",
    { fontSize: 16, strokeColor: palette.muted },
  );

  // Central profile
  ellipse("profile-head", 718, 170, 184, 184, {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    strokeWidth: 3,
  });
  ellipse("profile-body", 638, 330, 344, 232, {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    strokeWidth: 3,
  });
  text("profile-person-title", 744, 250, "候选人", {
    fontSize: 25,
    strokeColor: palette.blue,
  });
  text("profile-person-key", 716, 398, "Candidate Profile", {
    fontSize: 24,
    strokeColor: palette.blue,
  });
  text("profile-person-id", 720, 442, "(corpId, userId)", {
    fontSize: 16,
    strokeColor: palette.muted,
  });
  text("profile-person-rule", 693, 486, "字段级事实 · 可追溯 · 可纠正", {
    fontSize: 15,
    strokeColor: palette.muted,
  });

  // Profile domains
  card(
    "identity-domain",
    72,
    170,
    450,
    250,
    "① 身份画像 · profile_facts",
    "姓名 name                 电话 phone\n性别 gender               年龄 age\n学生身份 is_student       学历 education\n健康证 has_health_certificate\n\n跨 session 复用；稳定或半稳定字段",
    {
      strokeColor: palette.pink,
      backgroundColor: palette.pinkFill,
      badge: "LONG-TERM",
      badgeWidth: 104,
      bodySize: 14,
      lineHeight: 1.5,
    },
  );
  card(
    "preference-domain",
    1098,
    170,
    540,
    250,
    "② 长期求职意向 · preference_facts",
    "位置：city / district / location\n目标：brands / position\n条件：schedule / salary / labor_form\n约束：schedule_constraint / delayed_intent / available_after\n\nSettlement 唯一写方；最新会话快照整组覆盖",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      badge: "LONG-TERM",
      badgeWidth: 104,
      bodySize: 14,
      lineHeight: 1.45,
    },
  );
  card(
    "episode-domain",
    72,
    488,
    500,
    250,
    "③ 当前求职 Episode · session memory",
    "候选字段：interview_info / preferences\n岗位关系：lastCandidatePool / presentedJobs\n焦点关系：currentFocusJob / brand_state\n动作历史：invitedGroups / lastJobListQuery\n\n按 session 隔离；低置信不覆盖高置信",
    {
      strokeColor: palette.cyan,
      backgroundColor: palette.cyanFill,
      badge: "SESSION TTL",
      badgeWidth: 108,
      bodySize: 14,
      lineHeight: 1.45,
    },
  );
  card(
    "process-domain",
    1048,
    488,
    590,
    250,
    "④ 流程与事务指针",
    "程序记忆 procedural\n  currentStage / fromStage / advancedAt / reason\n预约指针 active_booking\n  work_order_id / job_id / bookings[]\n\n只保存流程位置与业务对象指针；真实状态实时回查业务系统",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      badge: "PROCESS",
      badgeWidth: 88,
      bodySize: 14,
      lineHeight: 1.45,
    },
  );
  card(
    "history-domain",
    616,
    616,
    404,
    154,
    "⑤ 历史叙事 · summary_data",
    "recent[] + archive\nlastSettledBySession\n帮助理解上下文，不参与程序化硬判断",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.violetFill,
      badge: "HISTORY",
      badgeWidth: 84,
      bodySize: 13,
    },
  );

  arrow("profile-to-identity", 638, 292, [[0, 0], [-108, 0]], { strokeColor: palette.pink });
  arrow("profile-to-preference", 982, 292, [[0, 0], [108, 0]], { strokeColor: palette.amber });
  arrow("profile-to-episode", 638, 478, [[0, 0], [-58, 70]], { strokeColor: palette.cyan });
  arrow("profile-to-process", 982, 478, [[0, 0], [58, 70]], { strokeColor: palette.red });
  arrow("profile-to-history", 810, 562, [[0, 0], [0, 46]], { strokeColor: palette.violet });

  // Field wrapper and authority
  rectangle("fact-frame", 48, 800, 1640, 250, {
    strokeColor: "#cbd5e1",
    backgroundColor: palette.slateFill,
    strokeWidth: 2,
  });
  rectangle("fact-tag", 68, 818, 254, 36, {
    strokeColor: palette.blue,
    backgroundColor: palette.blueFill,
    strokeWidth: 1,
  });
  text("fact-tag-text", 88, 826, "每个字段都是可裁决的 Fact", {
    fontSize: 16,
    strokeColor: palette.blue,
  });
  card(
    "fact-shape",
    82,
    882,
    400,
    128,
    "Fact Wrapper",
    "value · confidence · source · evidence\nextractedAt / updatedAt\noriginSessionId / originBotId",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.white,
      titleSize: 17,
      bodySize: 13,
    },
  );
  card(
    "high-authority",
    520,
    882,
    318,
    128,
    "HIGH · 可执行",
    "候选人明确输入 / 强规则\n报名成功 / 工具确权\n可进入工具与硬判断",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      titleSize: 17,
      bodySize: 13,
    },
  );
  card(
    "medium-authority",
    876,
    882,
    318,
    128,
    "MEDIUM · 需确认",
    "LLM 提取 / Settlement\n外部画像补全\n给模型参考，不自动筛人",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      titleSize: 17,
      bodySize: 13,
    },
  );
  card(
    "low-authority",
    1232,
    882,
    422,
    128,
    "LOW / UNKNOWN · 弱背景",
    "系统兜底 / 旧数据 / 缺 metadata\n不得进入程序化判断\n候选人否认或本次改口时立即弃用",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      titleSize: 17,
      bodySize: 13,
    },
  );
  arrow("fact-to-high", 482, 946, [[0, 0], [30, 0]], { strokeColor: palette.green });
  arrow("high-to-medium", 838, 946, [[0, 0], [30, 0]], {
    strokeColor: palette.line,
    strokeStyle: "dashed",
  });
  arrow("medium-to-low", 1194, 946, [[0, 0], [30, 0]], {
    strokeColor: palette.line,
    strokeStyle: "dashed",
  });

  // Write paths and consumers
  rectangle("paths-frame", 48, 1078, 1640, 334, {
    strokeColor: "#ddd6fe",
    backgroundColor: "#fbfaff",
    strokeWidth: 2,
  });
  rectangle("paths-tag", 68, 1096, 268, 36, {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    strokeWidth: 1,
  });
  text("paths-tag-text", 88, 1104, "画像写入来源与消费边界", {
    fontSize: 16,
    strokeColor: palette.violet,
  });

  card(
    "booking-writer",
    82,
    1162,
    276,
    104,
    "Booking 成功",
    "name / phone / age / gender\nsource=booking · confidence=high",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "settlement-writer",
    386,
    1162,
    296,
    104,
    "Settlement",
    "sessionFacts → profile + preferences\nsource=extraction · confidence=medium",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "enrichment-writer",
    710,
    1162,
    276,
    104,
    "External Enrichment",
    "客户详情等补全缺失字段\nmedium / low；失败不阻塞 Agent",
    {
      strokeColor: palette.cyan,
      backgroundColor: palette.cyanFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "current-turn-writer",
    1014,
    1162,
    286,
    104,
    "Current Turn Sidecar",
    "highConfidenceFacts 立即可用\n本对象不直接成为长期画像",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.blueFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "prompt-use",
    82,
    1292,
    620,
    82,
    "给 LLM / Prompt",
    "展示值 + confidence + source + 更新日期；历史来源需披露，本次表达优先，可让候选人纠正",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.white,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "tool-use",
    744,
    1292,
    896,
    82,
    "给程序化工具",
    "默认只消费 high；显式工具入参 > 本轮 high > session high > profile high；事务状态仍以工具结果为准",
    {
      strokeColor: palette.green,
      backgroundColor: palette.white,
      titleSize: 16,
      bodySize: 12,
    },
  );
  arrow("writers-to-prompt", 548, 1266, [[0, 0], [0, 18], [-156, 18]], {
    strokeColor: palette.violet,
  });
  arrow("writers-to-tool", 1157, 1266, [[0, 0], [0, 18], [36, 18]], {
    strokeColor: palette.green,
  });

  // Explicit exclusions
  rectangle("exclusion-strip", 48, 1440, 1640, 104, {
    strokeColor: palette.red,
    backgroundColor: "#fffafa",
    strokeWidth: 1,
    strokeStyle: "dashed",
  });
  text("exclusion-title", 74, 1459, "不进入长期身份画像", {
    fontSize: 17,
    strokeColor: palette.red,
  });
  text(
    "exclusion-body",
    286,
    1459,
    "applied_store · applied_position · interview_time · short_term · time_windows · open_position · 当前候选池/焦点岗位/已邀群",
    { fontSize: 15, strokeColor: palette.muted },
  );
  text(
    "exclusion-note",
    286,
    1491,
    "这些字段属于单次求职 episode 或事务状态；需要跨会话时走 preference 快照、summary 或业务系统指针，不塞进 profile_facts。",
    { fontSize: 14, strokeColor: palette.muted },
  );

  // Evidence tiers and action-specific acceptance
  rectangle("evidence-strategy-frame", 48, 1576, 1640, 402, {
    strokeColor: "#fcd34d",
    backgroundColor: "#fffdf5",
    strokeWidth: 2,
  });
  rectangle("evidence-strategy-tag", 68, 1594, 390, 38, {
    strokeColor: palette.amber,
    backgroundColor: palette.amberFill,
    strokeWidth: 1,
  });
  text("evidence-strategy-tag-text", 88, 1603, "置信度与证据采信策略 · 目标态（部分交付）", {
    fontSize: 17,
    strokeColor: palette.amber,
  });
  text(
    "confidence-source-note",
    1130,
    1604,
    "source ≠ confidence；confidence ≠ 全动作通行证",
    { fontSize: 14, strokeColor: palette.red },
  );

  card(
    "tier-t1",
    82,
    1654,
    350,
    112,
    "T1 · 候选人亲证",
    "candidate_text / location_share\n绑定字段和值的 confirmation\n可追溯到 messageId + quote",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "tier-t2",
    460,
    1654,
    350,
    112,
    "T2 · 外生确权",
    "tool_attested / derived / human_oob\ngeocode unique / precheck / booking\n由确定性边界验证",
    {
      strokeColor: palette.blue,
      backgroundColor: palette.blueFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "tier-t3",
    838,
    1654,
    350,
    112,
    "T3 · 历史继承",
    "cross_session profile / preference\n只能作为待确认或检索参考\n展示时必须披露历史来源",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      titleSize: 16,
      bodySize: 12,
    },
  );
  card(
    "tier-untrusted",
    1216,
    1654,
    438,
    112,
    "不采信 · model_assertion",
    "模型裸工具参数不能证明自己\n允许提交带证据 Claim，不允许凭空造事实\nLLM 失败只会降级，不会获得放权",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      titleSize: 16,
      bodySize: 12,
    },
  );

  rectangle("conflict-priority", 82, 1798, 1572, 62, {
    strokeColor: palette.violet,
    backgroundColor: palette.violetFill,
    strokeWidth: 1,
  });
  text("conflict-priority-title", 104, 1810, "冲突裁决优先级", {
    fontSize: 15,
    strokeColor: palette.violet,
  });
  text(
    "conflict-priority-body",
    272,
    1810,
    "当前轮候选人明确自报 / 纠正  >  当前会话已接受自报  >  与具体字段和值绑定的确认  >  历史 Profile（仅待确认）",
    { fontSize: 14, strokeColor: palette.ink },
  );

  card(
    "risk-irreversible",
    82,
    1886,
    360,
    82,
    "不可逆动作",
    "booking / invite：≥T2 + 本会话确认",
    {
      strokeColor: palette.red,
      backgroundColor: palette.redFill,
      titleSize: 14,
      bodySize: 11,
    },
  );
  card(
    "risk-display",
    470,
    1886,
    360,
    82,
    "对外展示",
    "本会话 T1；跨会话只准披露式确认",
    {
      strokeColor: palette.amber,
      backgroundColor: palette.amberFill,
      titleSize: 14,
      bodySize: 11,
    },
  );
  card(
    "risk-search",
    858,
    1886,
    360,
    82,
    "内部检索 / 推荐",
    "T1 / T2 / T3 均可，候选人可纠正",
    {
      strokeColor: palette.green,
      backgroundColor: palette.greenFill,
      titleSize: 14,
      bodySize: 11,
    },
  );
  card(
    "risk-reachout",
    1246,
    1886,
    408,
    82,
    "触达 / 复聊",
    "必须检查 human_oob 负向事实，命中即静默",
    {
      strokeColor: palette.violet,
      backgroundColor: palette.violetFill,
      titleSize: 14,
      bodySize: 11,
    },
  );

  return scene(elements);
}

const outputs = [
  ["memory-relationship-system.excalidraw", buildRelationshipScene()],
  ["candidate-profile-model.excalidraw", buildProfileScene()],
];

fs.mkdirSync(diagramDir, { recursive: true });
for (const [filename, content] of outputs) {
  const outputPath = path.join(diagramDir, filename);
  fs.writeFileSync(outputPath, `${JSON.stringify(content, null, 2)}\n`);
  console.log(outputPath);
}
