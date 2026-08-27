import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { buildReleasePrContent } = require('../../scripts/build-release-pr-body');

/**
 * 夹具驱动，禁止读仓库真实 CHANGELOG/package.json。
 *
 * 背景（2026-08-27 v11.0.0 发版事故）：旧 spec 直接读真实 CHANGELOG 并断言
 * 「待发布段包含本轮迁移 id」。发布 tag 打在固化提交上——待发布段恰好在固化时
 * 清空，deploy 工作流按 tag 检出源码后本 spec 必然失败，test job 挂掉导致
 * deploy 被跳过，而生产 migration 已推，形成旧代码读新 schema 的事故窗口。
 * 测试对仓库可变状态的依赖 = 发版级时间炸弹，此处必须夹具化。
 */
describe('build-release-pr-body', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pr-body-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(pendingBody: string): { changelogPath: string; packageJsonPath: string } {
    const changelogPath = path.join(dir, 'CHANGELOG.md');
    const packageJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(
      changelogPath,
      ['# Changelog', '', '<!-- release:pending:start -->', pendingBody, '<!-- release:pending:end -->', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(packageJsonPath, JSON.stringify({ version: '9.9.8' }));
    return { changelogPath, packageJsonPath };
  }

  it('surfaces pending config and migration changes before the approval checklist', () => {
    const paths = writeFixture(
      [
        '**预计版本**: `v9.9.9`',
        '',
        '### 更新摘要',
        '- 示例业务改动一条',
        '',
        '### 配置变更',
        '- 新增 migration `20990101000000_example_change.sql`，生产库待受控切换时应用',
        '',
        '### 环境变量提醒',
        '- 新增可选变量 `EXAMPLE_FLAG`',
      ].join('\n'),
    );

    const { title, body } = buildReleasePrContent({ base: 'master', head: 'develop', ...paths });

    expect(title).toBe('chore(release): 发布 v9.9.9');
    expect(body).toContain('## 配置与 Migration 提醒');
    expect(body).toContain('20990101000000');
    expect(body).toContain('生产库待受控切换时应用');
    expect(body).toContain('EXAMPLE_FLAG');
    expect(body.indexOf('## 配置与 Migration 提醒')).toBeLessThan(body.indexOf('## 发布前确认'));
  });

  it('renders fallbacks when the pending section is empty (post-finalize tag state)', () => {
    const paths = writeFixture('');

    const { title, body } = buildReleasePrContent({ base: 'master', head: 'develop', ...paths });

    expect(title).toBe('chore(release): 发布 v9.9.8');
    expect(body).toContain('- 暂无待发布摘要');
    expect(body).toContain('## 配置与 Migration 提醒\n- 无');
  });
});
