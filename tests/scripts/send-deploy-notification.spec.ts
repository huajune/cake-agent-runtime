import { execFileSync } from 'child_process';

function runNode(source: string): string {
  return execFileSync(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_FINISHED_AT: '2026-04-28T09:32:49.000Z',
      RELEASE_NOTES: '',
      RELEASE_NOTES_FILE: '',
      RELEASE_METADATA_FILE: '/tmp/cake-agent-runtime-missing-release-metadata.json',
    },
  }).trim();
}

describe('send deploy notification formatting', () => {
  it('uses a refined release title and status color', () => {
    const output = runNode(`
const { buildCardTitle, getCardTemplate } = require('./scripts/send-deploy-notification');
console.log(JSON.stringify({
  title: buildCardTitle('v5.4.0', 'success'),
  successTemplate: getCardTemplate('success'),
  failureTemplate: getCardTemplate('failure'),
}));
`);
    const result = JSON.parse(output);

    expect(result.title).toBe('🎂 蛋糕私域托管 · v5.4.0 已发布 ✨');
    expect(result.successTemplate).toBe('violet');
    expect(result.failureTemplate).toBe('red');
  });

  it('prefers the private monitor webhook used by CI/CD release notifications', () => {
    const output = runNode(`
process.env.DEPLOY_NOTIFICATION_WEBHOOK_URL = 'https://deploy.example/webhook';
process.env.PRIVATE_CHAT_MONITOR_WEBHOOK_URL = 'https://monitor.example/webhook';
process.env.DEPLOY_NOTIFICATION_WEBHOOK_SECRET = 'deploy-secret';
process.env.PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET = 'monitor-secret';
const { getWebhookConfig } = require('./scripts/send-deploy-notification');
console.log(JSON.stringify(getWebhookConfig()));
`);
    const result = JSON.parse(output);

    expect(result.webhookUrl).toBe('https://monitor.example/webhook');
    expect(result.secret).toBe('monitor-secret');
  });

  it('falls back to the dedicated deploy webhook when private monitor is not configured', () => {
    const output = runNode(`
process.env.DEPLOY_NOTIFICATION_WEBHOOK_URL = 'https://deploy.example/webhook';
process.env.DEPLOY_NOTIFICATION_WEBHOOK_SECRET = 'deploy-secret';
const { getWebhookConfig } = require('./scripts/send-deploy-notification');
console.log(JSON.stringify(getWebhookConfig()));
`);
    const result = JSON.parse(output);

    expect(result.webhookUrl).toBe('https://deploy.example/webhook');
    expect(result.secret).toBe('deploy-secret');
  });

  it('renders the production release card style from structured release notes', () => {
    const releaseNotes = `
### 更新摘要
- 占位摘要

### 新功能
- PR #154 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答
- PR #154 岗位推荐主动告知具体工作班次

### 问题修复
- PR #154 健康证不再阻塞面试

### 优化调整
- PR #154 班次时间逻辑下沉到工具内部

### 运维与流程
- PR #154 飞书 BadCase 状态双向回写脚本
`;

    const markdown = runNode(`
process.env.RELEASE_NOTES = ${JSON.stringify(releaseNotes)};
const { buildMarkdown } = require('./scripts/send-deploy-notification');
console.log(buildMarkdown({ releaseTag: 'v5.6.0', deployResult: 'success' }));
`);

    expect(markdown).toContain('**业务改动（候选人/运营可感知）**');
    expect(markdown).toContain('- 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答');
    expect(markdown).toContain('- 健康证不再阻塞面试');
    expect(markdown).not.toContain('**优化与运维（非业务感知）**');
    expect(markdown).not.toContain('- 班次时间逻辑下沉到工具内部');
    expect(markdown).not.toContain('- 飞书 BadCase 状态双向回写脚本');
    expect(markdown).not.toContain('**本次更新**');
  });

  it('rewrites technical English release notes into operator-friendly Chinese', () => {
    const releaseNotes = `
### 更新摘要
- 支持消息流水按托管 BOT 筛选
- Hardened interview precheck/booking around \`00:00-00:00\` date-only windows so deadline-like timestamps are not submitted as concrete interview times.
- Added bookable slot metadata and prompt guidance so the agent asks for a valid date/time instead of inventing one.
- Updated \`invite_to_group\` routing to refresh group member counts from the enterprise group list before selecting a group.
- Skips groups at or over \`GROUP_MEMBER_LIMIT\`, retries the next candidate when the invite API reports \`-10\`, and only alerts when every matching group is full.
- Reduces invalid interview booking submissions for special all-day/date-only windows.
`;

    const summary = runNode(`
const { extractUpdateSummary } = require('./scripts/send-deploy-notification');
console.log(extractUpdateSummary(${JSON.stringify(releaseNotes)}));
`);

    expect(summary).toContain('消息流水支持按托管 BOT 筛选，排查会话更方便');
    expect(summary).toContain('面试预约增加特殊日期窗口校验，避免把截止时间误当成具体面试时间提交');
    expect(summary).toContain('拉群前会刷新企业微信群人数，优先选择仍有容量的匹配群');
    expect(summary).not.toContain('Hardened interview');
    expect(summary).not.toContain('Added bookable slot');
  });

  it('keeps Chinese release notes with technical identifiers and rewrites them for operators', () => {
    const releaseNotes = `
### 新功能
- PR #224 新增 \`loadArtWorkImage\` API 调用获取原图（1179x2556, 222KB），存入 \`payload.artworkUrl\`
- PR #224 **Vision 降级链**: 新增 \`AGENT_VISION_FALLBACKS\` 只含 multimodal 模型

### 问题修复
- PR #224 托管平台回调的 \`imageUrl\` 是压缩缩略图（96x210, 8.8KB），vision 模型无法读取文字导致 100% 幻觉
- PR #224 全链路只调一次 API，下游三条消费路径（vision 描述 / Agent 对话 / Web 后台）全部读 \`payload.artworkUrl\`
- PR #224 **其他**: reply-fact-guard 误报率优化、Dashboard 趋势图修复、invite-to-group 群人数修复
`;

    const markdown = runNode(`
process.env.RELEASE_NOTES = ${JSON.stringify(releaseNotes)};
const { buildMarkdown } = require('./scripts/send-deploy-notification');
console.log(buildMarkdown({ releaseTag: 'v5.10.1', deployResult: 'success' }));
`);

    expect(markdown).toContain('候选人发图后会自动获取高清原图，图片识别准确率更高');
    expect(markdown).toContain('图片识别只降级到支持视觉的模型，避免落到纯文本模型误判');
    expect(markdown).toContain('图片消息改用高清原图识别，解决收银小票等图片文字识别不准的问题');
    expect(markdown).toContain('图片原图只获取一次并在识别、Agent 对话和后台展示中复用');
    expect(markdown).toContain(
      '降低回复事实校验误报，补齐 Dashboard 趋势日期轴，并修复拉群人数判断',
    );
  });

  it('falls back to a readable Chinese summary instead of sending raw English', () => {
    const releaseNotes = `
### 更新摘要
- Updated frontend resilience with async handoff and observable queue settlement.
`;

    const summary = runNode(`
const { extractUpdateSummary } = require('./scripts/send-deploy-notification');
console.log(extractUpdateSummary(${JSON.stringify(releaseNotes)}));
`);

    expect(summary).toBe('- 本次包含体验优化与稳定性修复，技术明细已记录在版本说明中。');
  });

  it('renders markdown with release status and localized updates', () => {
    const releaseNotes = `
### 更新摘要
- 支持消息流水按托管 BOT 筛选
`;

    const markdown = runNode(`
process.env.RELEASE_NOTES = ${JSON.stringify(releaseNotes)};
const { buildMarkdown } = require('./scripts/send-deploy-notification');
console.log(buildMarkdown({ releaseTag: 'v5.4.0', deployResult: 'success' }));
`);

    expect(markdown).toContain('**版本**：v5.4.0');
    expect(markdown).toContain('**发布状态**：生产环境发布完成');
    expect(markdown).toContain('**业务改动（候选人/运营可感知）**');
    expect(markdown).not.toContain('**本次更新**');
    expect(markdown).toContain('消息流水支持按托管 BOT 筛选，排查会话更方便');
  });

  it('renders businessUpdates from release metadata before parsing CHANGELOG markdown', () => {
    const markdown = runNode(`
const fs = require('fs');
const os = require('os');
const path = require('path');
const metadataFile = path.join(os.tmpdir(), \`release-metadata-\${process.pid}.json\`);
fs.writeFileSync(metadataFile, JSON.stringify({
  nextVersion: '5.10.1',
  entries: [],
  lastRelease: {
    version: '5.10.1',
    entries: [{
      businessUpdates: [
        '图片消息改用高清原图识别',
        'Dashboard 补齐趋势日期轴，并展示人工介入数据'
      ],
      features: ['不应该走到这里'],
      fixes: []
    }]
  }
}));
process.env.RELEASE_METADATA_FILE = metadataFile;
process.env.RELEASE_NOTES = '### 新功能\\n- 旧的 Markdown 内容不应该优先展示';
const { buildMarkdown } = require('./scripts/send-deploy-notification');
console.log(buildMarkdown({ releaseTag: 'v5.10.1', deployResult: 'success' }));
fs.rmSync(metadataFile, { force: true });
`);

    expect(markdown).toContain('- 图片消息改用高清原图识别');
    expect(markdown).toContain('- Dashboard 补齐趋势日期轴，并展示人工介入数据');
    expect(markdown).not.toContain('旧的 Markdown 内容不应该优先展示');
    expect(markdown).not.toContain('不应该走到这里');
  });

  it('does not render env reminders in deploy cards', () => {
    const releaseNotes = `
### 新功能
- PR #224 候选人发图后会自动获取高清原图，图片识别准确率更高

### 环境变量提醒
- PR #224 检测到环境变量相关文件变更：\`.env.example\`。请手动同步远程服务器 \`/data/cake/.env.production\`。
`;

    const markdown = runNode(`
process.env.RELEASE_NOTES = ${JSON.stringify(releaseNotes)};
const { buildMarkdown } = require('./scripts/send-deploy-notification');
console.log(buildMarkdown({ releaseTag: 'v5.10.1', deployResult: 'success' }));
`);

    expect(markdown).not.toContain('**需要关注**');
    expect(markdown).not.toContain('.env.example');
    expect(markdown).toContain('候选人发图后会自动获取高清原图，图片识别准确率更高');
  });

  it('matches the preferred v5.10.1 deploy card style', () => {
    const releaseNotes = `
### 新功能
- PR #224 候选人发图后会自动获取高清原图，图片识别准确率更高
- PR #224 图片识别只降级到支持视觉的模型，避免落到纯文本模型产生误判

### 问题修复
- PR #224 图片消息改用高清原图识别，解决缩略图导致小票/图片文字识别不准的问题
- PR #224 图片原图只获取一次，并在 Vision 描述、Agent 对话、Web 后台展示中全链路复用
- PR #224 后台聊天记录优先展示高清原图，排查图片消息更清楚
- PR #224 降低 reply-fact-guard 误报，减少不必要的人工排查
- PR #224 拉群前刷新企业微信群真实人数，避免继续把候选人拉进已满群
- PR #224 Dashboard 补齐趋势日期轴，并展示人工介入数据
- PR #224 同步修复面试预检/年龄边界、高置信候选人信息合并等稳定性问题
`;

    const markdown = runNode(`
process.env.RELEASE_NOTES = ${JSON.stringify(releaseNotes)};
const { buildCardTitle, buildMarkdown } = require('./scripts/send-deploy-notification');
console.log(buildCardTitle('v5.10.1', 'success'));
console.log('---');
console.log(buildMarkdown({ releaseTag: 'v5.10.1', deployResult: 'success' }));
`);

    expect(markdown).toContain('🎂 蛋糕私域托管 · v5.10.1 已发布 ✨');
    expect(markdown).toContain('**版本**：v5.10.1');
    expect(markdown).toContain('**发布时间**：2026/04/28 17:32:49');
    expect(markdown).toContain('**发布状态**：生产环境发布完成');
    expect(markdown).toContain('**业务改动（候选人/运营可感知）**');
    expect(markdown).toContain(
      '- 图片消息改用高清原图识别，解决缩略图导致小票/图片文字识别不准的问题',
    );
    expect(markdown).toContain('- Dashboard 补齐趋势日期轴，并展示人工介入数据');
    expect(markdown).not.toContain('**需要关注**');
    expect(markdown).not.toContain('**优化与运维');
  });
});
