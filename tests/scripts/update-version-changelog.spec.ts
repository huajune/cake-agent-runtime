const { analyzeReleaseLevel, bumpVersion } = require('../../scripts/update-version-changelog');

function commit(subject: string, body = '') {
  return { hash: 'test', subject, body };
}

describe('update-version-changelog release level', () => {
  it('bumps major for breaking change markers', () => {
    expect(analyzeReleaseLevel([commit('fix(api): 调整字段', 'BREAKING CHANGE: 字段不兼容')])).toBe(
      'major',
    );
    expect(analyzeReleaseLevel([commit('feat(agent)!: 重做运行时契约')])).toBe('major');
  });

  it('treats feature releases as minor versions (standard semver)', () => {
    expect(analyzeReleaseLevel([commit('feat(reengagement): 优化复聊控制与追溯视图')])).toBe(
      'minor',
    );
    expect(bumpVersion('8.0.0', 'minor')).toBe('8.1.0');
  });

  it('keeps fixes and other effective commits as patch', () => {
    expect(analyzeReleaseLevel([commit('fix(db): 删除旧函数签名')])).toBe('patch');
    expect(analyzeReleaseLevel([commit('refactor(agent): 收口运行时边界')])).toBe('patch');
    expect(analyzeReleaseLevel([commit('perf(dashboard): 缓存投影新鲜度')])).toBe('patch');
    expect(analyzeReleaseLevel([commit('docs(release): 更新说明')])).toBe('patch');
    expect(bumpVersion('6.1.0', 'patch')).toBe('6.1.1');
  });

  it('feat outranks patch-level commits in a mixed batch', () => {
    expect(
      analyzeReleaseLevel([
        commit('fix(db): 删除旧函数签名'),
        commit('feat(agent): 新增岗位召回工具'),
        commit('chore(deps): 升级依赖'),
      ]),
    ).toBe('minor');
  });

  it('ignores release and skipped commits', () => {
    expect(
      analyzeReleaseLevel([
        commit('chore(release): 更新待发布版本信息'),
        commit('feat(agent): shadow mode [skip ci]'),
        commit('Merge pull request #1 from huajune/test'),
      ]),
    ).toBeNull();
  });
});
