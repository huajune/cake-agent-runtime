const EMPTY_RELEASE_LINE_RE = /^(?:无|暂无|none|n\/a|待补充)$/i;

const EXACT_REWRITES = [
  [
    /^improve hosting ops and feedback flows$/i,
    '优化托管运营与反馈流程',
  ],
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

function isEmptyReleaseLine(value) {
  return EMPTY_RELEASE_LINE_RE.test(normalizeInlineText(value));
}

module.exports = {
  formatReleaseText,
  isEmptyReleaseLine,
};
