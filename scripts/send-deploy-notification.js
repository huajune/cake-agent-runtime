#!/usr/bin/env node

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const WEBHOOK_ENV_KEYS = [
  'PRIVATE_CHAT_MONITOR_WEBHOOK_URL',
  'DEPLOY_NOTIFICATION_WEBHOOK_URL',
];
const SECRET_ENV_KEYS = [
  'PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET',
  'DEPLOY_NOTIFICATION_WEBHOOK_SECRET',
];
const MAX_MARKDOWN_CHARS = 3500;

main().catch((error) => {
  console.error(`Deploy notification failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  const webhookUrl = firstEnv(WEBHOOK_ENV_KEYS);
  const requireNotification = isTruthy(process.env.REQUIRE_DEPLOY_NOTIFICATION);

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
          content: '版本发布通知',
        },
        template: 'green',
      },
      elements: [
        {
          tag: 'markdown',
          content: buildMarkdown(),
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

function buildMarkdown() {
  const releaseTag = env('RELEASE_TAG', env('IMAGE_TAG', env('GITHUB_REF_NAME', 'unknown')));
  const publishedAt = formatShanghaiTime(env('DEPLOY_FINISHED_AT', new Date().toISOString()));
  const updateSummary = extractUpdateSummary(normalizeReleaseNotes(readReleaseNotes()));

  const lines = [
    `**版本号**：${releaseTag}`,
    `**发布时间**：${publishedAt}`,
    '',
    '### 更新摘要',
    updateSummary,
  ];

  return truncateText(lines.join('\n'), MAX_MARKDOWN_CHARS);
}

function readReleaseNotes() {
  const releaseNotesFile = env('RELEASE_NOTES_FILE', '');
  if (releaseNotesFile && fs.existsSync(releaseNotesFile)) {
    return fs.readFileSync(releaseNotesFile, 'utf8');
  }

  return env('RELEASE_NOTES', '');
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
  const trimmed = releaseNotes.trim();
  if (!trimmed) {
    return '- 暂无';
  }

  const heading = /^### 更新摘要\s*\n/m.exec(trimmed);
  if (!heading) {
    return trimmed;
  }

  const rest = trimmed.slice(heading.index + heading[0].length);
  const nextHeadingIndex = rest.search(/^### /m);
  const summary = (nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex)).trim();
  return summary || '- 暂无';
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
    throw new Error(`Feishu webhook code=${code}: ${parsed.msg || parsed.StatusMessage || response.body}`);
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
