#!/usr/bin/env node

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const {
  formatOperationalReleaseText,
  formatReleaseText,
  isEmptyReleaseLine,
} = require('./release-note-formatters');

const WEBHOOK_ENV_KEYS = ['PRIVATE_CHAT_MONITOR_WEBHOOK_URL', 'DEPLOY_NOTIFICATION_WEBHOOK_URL'];
const SECRET_ENV_KEYS = [
  'PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET',
  'DEPLOY_NOTIFICATION_WEBHOOK_SECRET',
];
const MAX_MARKDOWN_CHARS = 3500;
const CHANGELOG_PATH = 'CHANGELOG.md';
const PENDING_START = '<!-- release:pending:start -->';
const PENDING_END = '<!-- release:pending:end -->';
const DEFAULT_OPERATIONAL_SUMMARY = '- 本次包含体验优化与稳定性修复，技术明细已记录在版本说明中。';
const DEPLOY_STATUS_META = {
  success: {
    icon: '🎂',
    title: '已发布',
    accent: '✨',
    markdown: '生产环境发布完成',
    template: 'violet',
  },
  failure: {
    icon: '⚠️',
    title: '发布异常',
    accent: '',
    markdown: '生产环境发布失败，请查看 GitHub Actions 日志',
    template: 'red',
  },
  cancelled: {
    icon: '⏸️',
    title: '发布取消',
    accent: '',
    markdown: '发布流程已取消',
    template: 'orange',
  },
  canceled: {
    icon: '⏸️',
    title: '发布取消',
    accent: '',
    markdown: '发布流程已取消',
    template: 'orange',
  },
  skipped: {
    icon: '⏭️',
    title: '发布跳过',
    accent: '',
    markdown: '发布流程被跳过',
    template: 'grey',
  },
  unknown: {
    icon: '🔎',
    title: '发布状态待确认',
    accent: '',
    markdown: '发布状态待确认',
    template: 'blue',
  },
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Deploy notification failed: ${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const webhookUrl = firstEnv(WEBHOOK_ENV_KEYS);
  const requireNotification = isTruthy(process.env.REQUIRE_DEPLOY_NOTIFICATION);
  const releaseTag = getReleaseTag();
  const deployResult = getDeployResult();

  if (!webhookUrl) {
    const message = `Deploy notification skipped: configure ${WEBHOOK_ENV_KEYS.join(' or ')}`;
    if (requireNotification) {
      throw new Error(message);
    }
    console.log(message);
    return;
  }

  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: buildCardTitle(releaseTag, deployResult),
        },
        template: getCardTemplate(deployResult),
      },
      elements: [
        {
          tag: 'markdown',
          content: buildMarkdown({ releaseTag, deployResult }),
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '<at id=all></at>',
          },
        },
      ],
    },
  };

  const secret = firstEnv(SECRET_ENV_KEYS);
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = generateFeishuSign(timestamp, secret);
  }

  const response = await postJson(webhookUrl, payload);
  assertFeishuResponse(response);
  console.log('Deploy notification sent to Feishu private domain monitor group.');
}

function buildMarkdown(options = {}) {
  const releaseTag = options.releaseTag || getReleaseTag();
  const deployResult = normalizeDeployResult(options.deployResult || getDeployResult());
  const deployStatus = getDeployStatusMeta(deployResult);
  const publishedAt = formatShanghaiTime(env('DEPLOY_FINISHED_AT', new Date().toISOString()));
  const releaseNotes = normalizeReleaseNotes(readReleaseNotes());
  const envReminder = extractEnvReminder(releaseNotes);

  const lines = [
    `**版本**：${releaseTag}`,
    `**发布时间**：${publishedAt}`,
    `**发布状态**：${deployStatus.markdown}`,
  ];
  if (envReminder) {
    lines.push('', ...renderOptionalSection('需要关注', envReminder));
  }

  const structured = extractStructuredUpdate(releaseNotes);
  if (structured) {
    lines.push('', structured);
  } else {
    lines.push('', '**本次更新**', extractUpdateSummary(releaseNotes));
  }

  return truncateText(lines.join('\n'), MAX_MARKDOWN_CHARS);
}

function extractStructuredUpdate(releaseNotes) {
  const businessLines = collectSectionLines(releaseNotes, ['新功能', '问题修复']);
  const opsLines = collectSectionLines(releaseNotes, ['优化调整', '运维与流程']);

  if (businessLines.length === 0 && opsLines.length === 0) {
    return '';
  }

  const blocks = [];
  if (businessLines.length > 0) {
    blocks.push('**业务改动（候选人/运营可感知）**');
    blocks.push(...businessLines.map((line) => `- ${line}`));
  }
  if (opsLines.length > 0) {
    if (blocks.length > 0) blocks.push('');
    blocks.push('**优化与运维（非业务感知）**');
    blocks.push(...opsLines.map((line) => `- ${line}`));
  }
  return blocks.join('\n');
}

function collectSectionLines(releaseNotes, sectionTitles) {
  const lines = [];
  for (const title of sectionTitles) {
    for (const item of parseMarkdownBullets(extractMarkdownSection(releaseNotes, title))) {
      const text = formatOperationalReleaseText(item, { includePrReference: false });
      if (!text || isEmptyReleaseLine(text)) continue;
      lines.push(text);
    }
  }
  return uniqueList(lines);
}

function buildCardTitle(releaseTag = getReleaseTag(), deployResult = getDeployResult()) {
  const deployStatus = getDeployStatusMeta(deployResult);
  const versionText = releaseTag && releaseTag !== 'unknown' ? `${releaseTag} ` : '';
  const accentText = deployStatus.accent ? ` ${deployStatus.accent}` : '';

  return `${deployStatus.icon} 蛋糕私域托管 · ${versionText}${deployStatus.title}${accentText}`;
}

function getCardTemplate(deployResult = getDeployResult()) {
  return getDeployStatusMeta(deployResult).template;
}

function getReleaseTag() {
  return env('RELEASE_TAG', env('IMAGE_TAG', env('GITHUB_REF_NAME', 'unknown')));
}

function getDeployResult() {
  return env('DEPLOY_RESULT', 'success');
}

function readReleaseNotes() {
  const releaseNotesFile = env('RELEASE_NOTES_FILE', '');
  if (releaseNotesFile && fs.existsSync(releaseNotesFile)) {
    return fs.readFileSync(releaseNotesFile, 'utf8');
  }

  const releaseNotes = env('RELEASE_NOTES', '');
  if (releaseNotes) {
    return releaseNotes;
  }

  return readChangelogFallback();
}

function normalizeReleaseNotes(rawNotes) {
  const trimmed = rawNotes.trim();
  if (!trimmed) {
    return '';
  }

  const lines = trimmed.split('\n');
  if (lines[0] && lines[0].startsWith('## ')) {
    return lines.slice(2).join('\n').trim();
  }

  return trimmed;
}

function extractUpdateSummary(releaseNotes) {
  const summaryLines = parseMarkdownBullets(extractMarkdownSection(releaseNotes, '更新摘要'))
    .map((line) => formatOperationalReleaseText(line, { includePrReference: false }))
    .filter(Boolean);

  if (summaryLines.length > 0) {
    return renderUpdateSummary(summaryLines);
  }

  const publicLines = extractPublicUpdateLines(releaseNotes);
  if (publicLines.length > 0) {
    return renderUpdateSummary(publicLines);
  }

  const fallbackLines = parseMarkdownBullets(releaseNotes.trim())
    .map((line) => formatOperationalReleaseText(line, { includePrReference: false }))
    .filter(Boolean);

  return renderUpdateSummary(fallbackLines);
}

function extractEnvReminder(releaseNotes) {
  const reminder = extractMarkdownSection(releaseNotes, '环境变量提醒');
  if (!reminder || reminder === '- 无') {
    return '';
  }

  const lines = parseMarkdownBullets(reminder)
    .map((line) => formatReleaseText(line, { includePrReference: false }))
    .filter((line) => line && !isEmptyReleaseLine(line));

  if (lines.length === 0) {
    return '';
  }

  return uniqueList(lines)
    .map((line) => `- ${line}`)
    .join('\n');
}

function extractMarkdownSection(markdown, headingText) {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return '';
  }

  const escapedHeading = escapeRegExp(headingText);
  const heading = new RegExp(`^### ${escapedHeading}\\s*\\n`, 'm').exec(trimmed);
  if (!heading) {
    return '';
  }

  const rest = trimmed.slice(heading.index + heading[0].length);
  const nextHeadingIndex = rest.search(/^### /m);
  return (nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex)).trim();
}

function extractPublicUpdateLines(releaseNotes) {
  const sections = ['新功能', '问题修复', '优化调整', '运维与流程', '配置变更'];
  const lines = [];

  for (const section of sections) {
    for (const item of parseMarkdownBullets(extractMarkdownSection(releaseNotes, section))) {
      const text = formatOperationalReleaseText(item, { includePrReference: false });
      if (!text || isEmptyReleaseLine(text)) continue;
      lines.push(text);
    }
  }

  return uniqueList(lines).slice(0, 10);
}

function renderUpdateSummary(lines) {
  const items = uniqueList(lines).slice(0, 6);

  if (items.length === 0) {
    return DEFAULT_OPERATIONAL_SUMMARY;
  }

  return items.map((line) => `- ${line}`).join('\n');
}

function parseMarkdownBullets(markdown) {
  if (!markdown) {
    return [];
  }

  return markdown
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(?:[-*+]\s+|\d+\.\s+)(.+)$/);
      return match ? match[1].trim() : '';
    })
    .filter(Boolean);
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function renderOptionalSection(title, content) {
  if (!content) {
    return [];
  }

  return [`**${title}**`, content];
}

function readChangelogFallback() {
  if (!fs.existsSync(CHANGELOG_PATH)) {
    return '';
  }

  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const pending = extractPendingSection(changelog);
  if (pending) {
    return pending;
  }

  return extractLatestReleaseSection(changelog);
}

function extractPendingSection(changelog) {
  const start = changelog.indexOf(PENDING_START);
  const end = changelog.indexOf(PENDING_END);
  if (start === -1 || end === -1 || end <= start) {
    return '';
  }

  return changelog.slice(start + PENDING_START.length, end).trim();
}

function extractLatestReleaseSection(changelog) {
  const match = /^## \[/m.exec(changelog);
  if (!match) {
    return '';
  }

  const section = changelog.slice(match.index);
  const nextMatch = /^## \[/m.exec(section.slice(1));
  if (!nextMatch) {
    return section.trim();
  }

  return section.slice(0, nextMatch.index + 1).trim();
}

function getDeployStatusMeta(deployResult) {
  return DEPLOY_STATUS_META[normalizeDeployResult(deployResult)];
}

function normalizeDeployResult(deployResult) {
  const normalized = String(deployResult || '')
    .trim()
    .toLowerCase();

  return DEPLOY_STATUS_META[normalized] ? normalized : 'unknown';
}

function formatShanghaiTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function truncateText(input, maxChars) {
  if (input.length <= maxChars) {
    return input;
  }

  return `${input.slice(0, maxChars)}\n\n...内容过长，已截断`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const transport = target.protocol === 'http:' ? http : https;

    const request = transport.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            body: data,
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Feishu webhook request timed out'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

module.exports = {
  buildCardTitle,
  buildMarkdown,
  extractStructuredUpdate,
  extractUpdateSummary,
  getCardTemplate,
  normalizeReleaseNotes,
};

function assertFeishuResponse(response) {
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Feishu webhook HTTP ${response.statusCode}: ${response.body}`);
  }

  if (!response.body) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return;
  }

  const code = typeof parsed.code === 'number' ? parsed.code : parsed.StatusCode;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(
      `Feishu webhook code=${code}: ${parsed.msg || parsed.StatusMessage || response.body}`,
    );
  }
}

function generateFeishuSign(timestamp, secret) {
  const hmac = crypto.createHmac('sha256', `${timestamp}\n${secret}`);
  hmac.update(Buffer.alloc(0));
  return hmac.digest('base64');
}

function firstEnv(keys) {
  for (const key of keys) {
    const value = env(key, '');
    if (value) {
      return value;
    }
  }

  return '';
}

function env(key, fallback) {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : fallback;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}
