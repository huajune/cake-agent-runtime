#!/usr/bin/env node
/**
 * 周报运行数据卡片投递：把「本周运行数据」发到蛋糕私聊监控群。
 *
 * 用法：
 *   node scripts/weekly-ops-report/send-weekly-card.js <payload.json> [--dry-run]
 *
 * payload.json 结构（由 weekly-ops-report skill 在采集完数据后写出）：
 *   {
 *     "windowLabel": "08/31 ~ 09/04",
 *     "summary": "本周业务量比上周涨约 45%……",   // 可选，一句话业务概述
 *     "metrics": ["对话：**8922 轮 / 1647 位候选人**……", "……"]
 *   }
 *
 * 只发运行数据，不带系统改动条目——改动明细留在会话与 docs/releases 存档里。
 * 凭证取自 .env.production（私聊监控群 webhook 与发版通知同群）。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ENV_PATH = path.resolve(__dirname, '../../.env.production');
const WEBHOOK_URL_KEY = 'PRIVATE_CHAT_MONITOR_WEBHOOK_URL';
const WEBHOOK_SECRET_KEY = 'PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET';
const CARD_TITLE = '🍰 蛋糕私域托管 · 本周运行同步';
const MAX_MARKDOWN_CHARS = 3500;

if (require.main === module) {
  main().catch((error) => {
    console.error(`周报卡片发送失败：${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const payloadPath = args.find((arg) => !arg.startsWith('--'));

  if (!payloadPath) {
    throw new Error('缺少 payload 文件路径：send-weekly-card.js <payload.json> [--dry-run]');
  }

  const report = readReport(payloadPath);
  const card = buildCard(report);

  if (dryRun) {
    console.log(JSON.stringify(card, null, 2));
    console.log('\n[dry-run] 未发送。去掉 --dry-run 才会真正投递到私聊监控群。');
    return;
  }

  const { url, secret } = loadWebhookConfig();
  const payload = { msg_type: 'interactive', card };

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = generateFeishuSign(timestamp, secret);
  }

  const response = await postJson(url, payload);
  assertFeishuResponse(response);
  console.log(`周报卡片已发送到蛋糕私聊监控群（窗口 ${report.windowLabel}）。`);
}

function readReport(payloadPath) {
  const resolved = path.resolve(payloadPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`payload 文件不存在：${resolved}`);
  }

  const report = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!report.windowLabel) {
    throw new Error('payload 缺少 windowLabel');
  }
  if (!Array.isArray(report.metrics) || report.metrics.length === 0) {
    throw new Error('payload 缺少 metrics，或 metrics 为空');
  }

  return report;
}

function buildCard(report) {
  const lines = [`**窗口**：${report.windowLabel}（北京时间）`];

  if (report.summary) {
    lines.push('', report.summary);
  }

  lines.push('', '**本周运行数据**', ...report.metrics.map((item) => `- ${item}`));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: CARD_TITLE },
      template: 'violet',
    },
    elements: [
      { tag: 'markdown', content: truncate(lines.join('\n'), MAX_MARKDOWN_CHARS) },
      { tag: 'div', text: { tag: 'lark_md', content: '<at id=all></at>' } },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `数据源：Supabase 生产库 · 飞书 BadCase 台账 · git tag ｜ 生成于 ${formatShanghaiTime(new Date())}`,
          },
        ],
      },
    ],
  };
}

function loadWebhookConfig() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`缺少 ${ENV_PATH}——私聊监控群 webhook 凭证只在生产环境文件中`);
  }

  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (matched) env[matched[1]] = matched[2].trim().replace(/^["']|["']$/g, '');
  }

  const url = env[WEBHOOK_URL_KEY];
  if (!url) {
    throw new Error(`.env.production 缺少 ${WEBHOOK_URL_KEY}`);
  }

  return { url, secret: env[WEBHOOK_SECRET_KEY] || '' };
}

function generateFeishuSign(timestamp, secret) {
  const hmac = crypto.createHmac('sha256', `${timestamp}\n${secret}`);
  hmac.update(Buffer.alloc(0));
  return hmac.digest('base64');
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
        response.on('end', () => resolve({ statusCode: response.statusCode, body: data }));
      },
    );

    request.on('timeout', () => request.destroy(new Error('飞书 webhook 请求超时')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function assertFeishuResponse(response) {
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`飞书 webhook HTTP ${response.statusCode}: ${response.body}`);
  }
  if (!response.body) return;

  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return;
  }

  const code = typeof parsed.code === 'number' ? parsed.code : parsed.StatusCode;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(
      `飞书 webhook code=${code}: ${parsed.msg || parsed.StatusMessage || response.body}`,
    );
  }
}

function formatShanghaiTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function truncate(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

module.exports = { buildCard };
