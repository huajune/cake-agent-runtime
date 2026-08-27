const { buildReleasePrContent } = require('../../scripts/build-release-pr-body');

describe('build-release-pr-body', () => {
  it('surfaces pending config and migration changes before the approval checklist', () => {
    const { body } = buildReleasePrContent({ base: 'master', head: 'develop' });

    expect(body).toContain('## 配置与 Migration 提醒');
    expect(body).toContain('20260821210000');
    expect(body).toContain('生产库待受控切换时应用');
    expect(body.indexOf('## 配置与 Migration 提醒')).toBeLessThan(body.indexOf('## 发布前确认'));
  });
});
