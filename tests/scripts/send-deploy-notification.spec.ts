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

  it('renders two-section update when structured release notes are available', () => {
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
    expect(markdown).toContain('**优化与运维（非业务感知）**');
    expect(markdown).toContain('- 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答');
    expect(markdown).toContain('- 健康证不再阻塞面试');
    expect(markdown).toContain('- 班次时间逻辑下沉到工具内部');
    expect(markdown).toContain('- 飞书 BadCase 状态双向回写脚本');
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
    expect(markdown).toContain('**本次更新**');
    expect(markdown).toContain('消息流水支持按托管 BOT 筛选，排查会话更方便');
  });
});
