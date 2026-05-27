const EMPTY_RELEASE_LINE_RE = /^(?:无|暂无|none|n\/a|待补充)$/i;

const EXACT_REWRITES = [
  [/^improve hosting ops and feedback flows$/i, '优化托管运营与反馈流程'],
  [
    /^fix WeCom image\/text merge handling and booking\/dashboard stats recording$/i,
    '修复企微图片/文本合并处理，以及预约与仪表盘统计记录',
  ],
  [
    /^improve the users hosting operations page with search, stable sorting, bot filtering, and real configured bot data$/i,
    '托管用户运营页支持搜索、稳定排序、BOT 筛选和真实配置数据',
  ],
  [
    /^add Good\/Bad feedback from the message-processing drawer, including Batch ID write-through to Feishu$/i,
    '消息处理详情抽屉新增好/坏反馈，并将 Batch ID 回写飞书',
  ],
  [
    /^make feedback success and failure states much more visible, including backend error details$/i,
    '优化反馈成功/失败状态展示，并补充后端错误详情',
  ],
  [
    /^refine pending release notes and deploy notification markdown$/i,
    '优化待发布说明和部署通知格式',
  ],
];

const TERM_REWRITES = [
  [/\bWeCom\b/g, '企微'],
  [/\bGood\/Bad feedback\b/g, '好/坏反馈'],
  [/\bmessage-processing drawer\b/g, '消息处理详情抽屉'],
  [/\bBatch ID write-through to Feishu\b/g, 'Batch ID 回写飞书'],
  [/\bpending release notes\b/g, '待发布说明'],
  [/\bdeploy notification markdown\b/g, '部署通知格式'],
  [/\bbackend error details\b/g, '后端错误详情'],
  [/\busers hosting operations page\b/g, '托管用户运营页'],
  [/\bstable sorting\b/g, '稳定排序'],
  [/\bbot filtering\b/gi, 'BOT 筛选'],
  [/\breal configured bot data\b/gi, '真实配置数据'],
  [/\bimage\/text merge handling\b/g, '图片/文本合并处理'],
  [/\bbooking\/dashboard stats recording\b/g, '预约与仪表盘统计记录'],
];

const OPERATIONAL_REWRITES = [
  [
    /托管平台回调的 `?imageUrl`?.*压缩缩略图.*vision 模型无法读取文字/i,
    '图片消息改用高清原图识别，解决收银小票等图片文字识别不准的问题',
  ],
  [
    /新增 `?loadArtWorkImage`? API 调用获取原图/i,
    '候选人发图后会自动获取高清原图，图片识别准确率更高',
  ],
  [
    /全链路只调一次 API.*payload\.artworkUrl/i,
    '图片原图只获取一次并在识别、Agent 对话和后台展示中复用',
  ],
  [
    /图片原图获取.*enrichImagePayload.*原图 URL/i,
    '图片消息入库前就补齐原图地址，避免后续流程再读压缩图',
  ],
  [
    /Vision 描述路径.*artworkUrl/i,
    '图片描述直接读取高清原图，减少视觉模型幻觉',
  ],
  [
    /Agent vision 路径.*artworkUrl/i,
    'Agent 对话会使用高清原图理解图片内容',
  ],
  [
    /Web 后台.*previewUrl.*artworkUrl/i,
    '后台聊天记录优先展示高清原图，排查图片消息更清楚',
  ],
  [
    /Vision 降级链.*AGENT_VISION_FALLBACKS/i,
    '图片识别只降级到支持视觉的模型，避免落到纯文本模型误判',
  ],
  [
    /reply-fact-guard 误报率优化.*Dashboard 趋势图修复.*invite-to-group 群人数修复/i,
    '降低回复事实校验误报，补齐 Dashboard 趋势日期轴，并修复拉群人数判断',
  ],
  [
    /reply-fact-guard 误报率优化/i,
    '降低回复事实校验误报，减少不必要的人工排查',
  ],
  [
    /Dashboard 趋势图修复/i,
    'Dashboard 补齐趋势日期轴，并展示人工介入数据',
  ],
  [
    /invite-to-group 群人数修复/i,
    '拉群前刷新真实群人数，避免继续把候选人拉进已满群',
  ],
  [/支持消息流水按托管 BOT 筛选/, '消息流水支持按托管 BOT 筛选，排查会话更方便'],
  [
    /Hardened interview precheck\/booking around `?00:00-00:00`? date-only windows/i,
    '面试预约增加特殊日期窗口校验，避免把截止时间误当成具体面试时间提交',
  ],
  [
    /Added bookable slot metadata and prompt guidance/i,
    '可预约时段会明确标记和提示，缺少具体时间时 Agent 会先询问候选人',
  ],
  [
    /Updated `?invite_to_group`? routing to refresh group member counts/i,
    '拉群前会刷新企业微信群人数，优先选择仍有容量的匹配群',
  ],
  [
    /Skips groups at or over `?GROUP_MEMBER_LIMIT`?/i,
    '群满时会自动跳过并尝试下一个匹配群，只有所有匹配群都满时才告警',
  ],
  [/Reduces invalid interview booking submissions/i, '减少全天/仅日期面试窗口导致的无效预约提交'],
  [
    /Prevents continuing to invite candidates into full part-time groups/i,
    '当存在同城同业的可用群时，不再继续拉入已满兼职群',
  ],
  [/Keeps the group capacity alert reserved/i, '群容量告警只在所有匹配群都满时触发，减少误报'],
];

function formatReleaseText(value, options = {}) {
  const { includePrReference = true } = options;
  let text = normalizeInlineText(value);
  if (!text) return '';

  if (!includePrReference) {
    text = stripPrReference(text);
  }

  text = stripAutomationPrefix(text);
  text = stripConventionalPrefix(text);
  text = localizeReleaseText(text);
  text = normalizeInlineText(text);

  return isEmptyReleaseLine(text) ? '' : text;
}

function formatOperationalReleaseText(value, options = {}) {
  const text = formatReleaseText(value, options);
  if (!text) return '';

  const localized = localizeOperationalReleaseText(text);
  if (localized) {
    return localized;
  }

  if (isMostlyTechnicalEnglish(text)) {
    return '';
  }

  return text;
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripPrReference(value) {
  return value.replace(/^PR\s+#\d+\s*/i, '').trim();
}

function stripAutomationPrefix(value) {
  return value.replace(/^\[(?:codex|agent|bot|auto)\]\s*/i, '').trim();
}

function stripConventionalPrefix(value) {
  return value
    .replace(
      /^(?:feat|fix|chore|perf|refactor|docs|test|ci|build|style|revert)(?:\([^)]+\))?!?\s*[:：]\s*/i,
      '',
    )
    .trim();
}

function localizeReleaseText(value) {
  for (const [pattern, replacement] of EXACT_REWRITES) {
    if (pattern.test(value)) {
      return replacement;
    }
  }

  let localized = value;
  for (const [pattern, replacement] of TERM_REWRITES) {
    localized = localized.replace(pattern, replacement);
  }

  return localized;
}

function localizeOperationalReleaseText(value) {
  for (const [pattern, replacement] of OPERATIONAL_REWRITES) {
    if (pattern.test(value)) {
      return replacement;
    }
  }

  return '';
}

function isMostlyTechnicalEnglish(value) {
  const englishLetters = (value.match(/[A-Za-z]/g) || []).length;
  const chineseLetters = (value.match(/[\u4e00-\u9fa5]/g) || []).length;

  if (chineseLetters > 0) {
    return false;
  }

  return englishLetters >= 12 && englishLetters > chineseLetters * 2;
}

function isEmptyReleaseLine(value) {
  return EMPTY_RELEASE_LINE_RE.test(normalizeInlineText(value));
}

module.exports = {
  formatOperationalReleaseText,
  formatReleaseText,
  isEmptyReleaseLine,
};
