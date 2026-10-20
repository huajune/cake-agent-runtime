#!/usr/bin/env node
/**
 * 运营版上线通知卡片投递：把人工整理、用户审阅过的「X 月 X 日上线通知」发到蛋糕私聊监控群。
 *
 * 用法：
 *   node scripts/ops-release-notice/send-notice-card.js <notice.json> [--dry-run] [--json]
 *
 * notice.json 结构（写法与核实流程见 src/skills/ship-release/references/ops-release-notice.md）：
 *   {
 *     "dateLabel": "10 月 15 日",
 *     "intro": "今天上线了两个版本：14:44 上线 v11.13.1……",
 *     "sections": [
 *       { "heading": "🆕 新上线功能", "items": ["**按候选人不方便的时间排除岗位**：……"] },
 *       { "heading": "🔧 问题修复", "items": ["……"] },
 *       { "heading": "⚠️ 需要运营留意", "items": ["……"] }
 *     ]
 *   }
 *
 * 每个 item 写成一段、不换行、不带编号：运营多在手机上看，多层子条目难读，脚本统一编号。
 * 卡片样式（标题前缀、紫色模板、@所有人）与自动发版卡片一致；凭证取自 .env.production
 * （私聊监控群 webhook 与发版通知同群），worktree 里没有时回退到主仓库。
 * 先 --dry-run 读一遍正文；真发成功后在通知文件旁写 .sent 标记，挡住重复发送。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { setTimeout: sleep } = require('timers/promises');

const WEBHOOK_URL_KEY = 'PRIVATE_CHAT_MONITOR_WEBHOOK_URL';
const WEBHOOK_SECRET_KEY = 'PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET';
const KNOWN_FLAGS = ['--dry-run', '--json'];
const MAX_SECTION_CHARS = 3500;
// 飞书自定义机器人请求体上限 20 KB，留约 1 KB 给 timestamp/sign。
const MAX_BODY_BYTES = 19 * 1024;

if (require.main === module) {
  main().catch((error) => {
    console.error(`上线通知发送失败：${error.message}`);
    process.exit(1);
  });
}

async function main(argv = process.argv.slice(2), deps = { loadWebhookConfig, postJson }) {
  const { noticePath, dryRun, printJson } = parseArgs(argv);
  const notice = readNotice(noticePath);
  const card = buildCard(notice);

  if (dryRun) {
    printPreview(card);
    if (printJson) console.log(JSON.stringify(card, null, 2));
    return;
  }

  const sentMarker = `${path.resolve(noticePath)}.sent`;
  if (fs.existsSync(sentMarker)) {
    const sentAt = fs.readFileSync(sentMarker, 'utf8').trim();
    throw new Error(`这份通知已于 ${sentAt} 发送过；确需重发请先删除 ${sentMarker}`);
  }

  const { url, secret } = deps.loadWebhookConfig();
  const payload = { msg_type: 'interactive', card };

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = generateFeishuSign(timestamp, secret);
  }

  // 在第一个网络请求之前独占通知，避免两个进程同时通过 .sent 检查。
  // 请求结果不明时保留 pending：超时不代表群里没有收到，必须先人工核对。
  const pendingMarker = `${path.resolve(noticePath)}.pending`;
  try {
    fs.writeFileSync(pendingMarker, `${new Date().toISOString()}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`这份通知正在发送或上次结果未确认；先核对群消息，再处理 ${pendingMarker}`);
  }
  // 前一个进程可能刚把 pending 改名为 sent；拿到锁后再检查一次。
  if (fs.existsSync(sentMarker)) {
    fs.unlinkSync(pendingMarker);
    throw new Error('这份通知已发送过；请先核对群消息');
  }
  // 只重试飞书明确拒收的限流；网络异常或不明回执继续保留独占锁，避免重复投递。
  for (let attempt = 0; ; attempt += 1) {
    const response = await deps.postJson(url, payload);
    try {
      assertFeishuResponse(response);
      break;
    } catch (error) {
      if (error.feishuCode !== 11232 || attempt >= 3) throw error;
      await (deps.sleep || sleep)(1000 * 2 ** attempt);
    }
  }
  fs.writeFileSync(pendingMarker, `${new Date().toISOString()}\n`);
  fs.renameSync(pendingMarker, sentMarker);
  console.log(`${notice.dateLabel}上线通知已发送到蛋糕私聊监控群。`);
}

/** 只认已知参数：写错的开关（如 --dryrun、中文破折号）一律报错，避免误判为真发。 */
function parseArgs(argv) {
  const isFlag = (arg) => /^[-—–]/.test(arg);
  const unknown = argv.filter((arg) => isFlag(arg) && !KNOWN_FLAGS.includes(arg));
  if (unknown.length > 0) {
    throw new Error(`不认识的参数：${unknown.join(' ')}；只支持 ${KNOWN_FLAGS.join(' ')}`);
  }

  const positional = argv.filter((arg) => !isFlag(arg));
  if (positional.length !== 1) {
    throw new Error('用法：send-notice-card.js <notice.json> [--dry-run] [--json]');
  }

  return {
    noticePath: positional[0],
    dryRun: argv.includes('--dry-run') || argv.includes('--json'),
    printJson: argv.includes('--json'),
  };
}

function readNotice(noticePath) {
  const resolved = path.resolve(noticePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`通知文件不存在：${resolved}`);
  }

  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function validateNotice(notice) {
  if (!notice.dateLabel) {
    throw new Error('通知缺少 dateLabel');
  }
  if (!notice.intro) {
    throw new Error('通知缺少 intro（开头一句：上线了哪些版本、各自部署完成时间）');
  }
  if (!Array.isArray(notice.sections) || notice.sections.length === 0) {
    throw new Error('通知缺少 sections，或 sections 为空');
  }

  for (const section of notice.sections) {
    if (!section.heading) {
      throw new Error('有分区缺少 heading');
    }
    if (/^\*\*|\*\*$/.test(section.heading) || section.heading.includes('\n')) {
      throw new Error(`分区标题「${section.heading}」不要自带 ** 或换行，脚本会自动加粗`);
    }
    if (!Array.isArray(section.items) || section.items.length === 0) {
      throw new Error(`分区「${section.heading}」没有条目`);
    }
    for (const item of section.items) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`分区「${section.heading}」有空条目`);
      }
      if (item.includes('\n')) {
        throw new Error(`分区「${section.heading}」的条目含换行：每条写成一段，子条目合成一句`);
      }
      if (/^\s*(\d+[.、)]\s*|[-•]\s|\*\s)/.test(item)) {
        throw new Error(`分区「${section.heading}」的条目自带编号或项目符号：去掉，脚本会自动编号`);
      }
    }

    const content = renderSection(section);
    if (content.length > MAX_SECTION_CHARS) {
      throw new Error(
        `分区「${section.heading}」共 ${content.length} 字，超过 ${MAX_SECTION_CHARS}：请合并同类条目或拆成两个分区`,
      );
    }
  }
}

function buildCard(notice) {
  validateNotice(notice);

  const elements = [{ tag: 'markdown', content: escapeCardText(notice.intro) }];
  for (const section of notice.sections) {
    elements.push({ tag: 'hr' }, { tag: 'markdown', content: renderSection(section) });
  }
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: '<at id=all></at>' } });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🎂 蛋糕私域托管 · ${notice.dateLabel}上线通知 ✨` },
      template: 'violet',
    },
    elements,
  };

  const bytes = measureBodyBytes(card);
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `卡片请求体 ${bytes} 字节，超过飞书自定义机器人 20 KB 上限：请合并同类条目、压缩措辞`,
    );
  }

  return card;
}

function renderSection(section) {
  const lines = section.items.map((item, index) => `${index + 1}. ${escapeCardText(item.trim())}`);
  return [`**${escapeCardText(section.heading)}**`, ...lines].join('\n');
}

/** 飞书卡片 markdown 把 < > 当标签解析，需转义；* 保留，条目里的加粗标题要靠它。 */
function escapeCardText(text) {
  return text.replace(/</g, '&#60;').replace(/>/g, '&#62;');
}

function measureBodyBytes(card) {
  return Buffer.byteLength(
    JSON.stringify({
      msg_type: 'interactive',
      card,
      timestamp: '0000000000',
      sign: 'x'.repeat(44),
    }),
  );
}

function printPreview(card) {
  console.log(`标题：${card.header.title.content}\n`);
  const sections = card.elements.filter((element) => element.tag === 'markdown');
  for (const element of sections) {
    console.log(`${element.content}\n----`);
  }
  const sizes = sections.map((element) => element.content.length);
  console.log(
    `[dry-run] 未发送。分区字数：${sizes.join(', ')}；请求体 ${measureBodyBytes(card)} 字节（上限 20 KB）；加 --json 可查看完整卡片 JSON。`,
  );
}

function resolveEnvPath() {
  const local = path.resolve(__dirname, '../../.env.production');
  if (fs.existsSync(local)) return local;

  // worktree 里没有生产环境文件：回退到主仓库，不要把凭证复制进 worktree。
  const commonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      cwd: __dirname,
      encoding: 'utf8',
    },
  ).trim();
  return path.join(path.dirname(commonDir), '.env.production');
}

function loadWebhookConfig() {
  const envPath = resolveEnvPath();
  if (!fs.existsSync(envPath)) {
    throw new Error(`缺少 ${envPath}——私聊监控群 webhook 凭证只在生产环境文件中`);
  }

  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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

    request.on('timeout', () =>
      request.destroy(new Error('飞书 webhook 请求超时：先确认群里是否已收到，再决定是否重发')),
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function assertFeishuResponse(response) {
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`飞书 webhook HTTP ${response.statusCode}: ${response.body}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error('飞书 webhook 未返回有效 JSON 成功回执');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('飞书 webhook 缺少成功状态码');
  }

  const code = typeof parsed.code === 'number' ? parsed.code : parsed.StatusCode;
  if (typeof code !== 'number') throw new Error('飞书 webhook 缺少成功状态码');
  if (code !== 0) {
    const error = new Error(
      `飞书 webhook code=${code}: ${parsed.msg || parsed.StatusMessage || response.body}`,
    );
    error.feishuCode = code;
    throw error;
  }
}

module.exports = { assertFeishuResponse, buildCard, main, parseArgs, validateNotice };
