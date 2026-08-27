import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { generateReleaseLedger, AUTO_MARKER } = require('../../scripts/generate-release-ledger');
const { validateReleaseLedger } = require('../../scripts/check-release-ledger');

function makeFixtureRoot(pending: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ledger-'));
  fs.mkdirSync(path.join(root, '.release'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: pending.nextVersion }),
  );
  fs.writeFileSync(
    path.join(root, '.release', 'pending-release.json'),
    JSON.stringify(pending, null, 2),
  );
  return root;
}

const PENDING = {
  baseVersion: '11.0.3',
  nextVersion: '11.0.4',
  updatedAt: '2026-08-27',
  sourceBranch: 'develop',
  entries: [
    {
      number: '1081',
      title: '固化 v11.0.3 发版底账 + 失败路径守卫回归用例',
      businessUpdates: ['失败路径守卫回归断言', '「没约上」如实披露不再误拦'],
      verification: ['38/38 tests 通过', 'check-release-ledger 本地通过'],
      level: 'patch',
    },
    {
      number: '1080',
      title: 'repair 回归闸豁免"首版即违规结构"的坍缩误伤',
      businessUpdates: ['回归闸豁免收窄'],
      verification: ['ci:check 全量通过'],
      level: 'patch',
    },
  ],
};

describe('generate-release-ledger', () => {
  it('生成的草稿直接通过 check-release-ledger 校验', () => {
    const root = makeFixtureRoot(PENDING);
    const result = generateReleaseLedger(root);
    expect(result.version).toBe('11.0.4');

    const content = fs.readFileSync(result.targetPath, 'utf8');
    expect(content.startsWith(AUTO_MARKER)).toBe(true);
    expect(content).toContain('#1081');
    expect(content).toContain('#1080');

    const validated = validateReleaseLedger(root);
    expect(validated.version).toBe('11.0.4');
  });

  it('目标底账已人工定稿（无标记）时拒绝覆盖，--force 可强制', () => {
    const root = makeFixtureRoot(PENDING);
    const target = path.join(root, 'docs', 'releases', '2026', 'v11.0.4.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# 人工定稿的底账\n');

    expect(() => generateReleaseLedger(root)).toThrow(/拒绝覆盖/u);
    expect(fs.readFileSync(target, 'utf8')).toContain('人工定稿');

    generateReleaseLedger(root, { force: true });
    expect(fs.readFileSync(target, 'utf8').startsWith(AUTO_MARKER)).toBe(true);
  });

  it('清理旧版本号的自动草稿，人工定稿文件不动', () => {
    const root = makeFixtureRoot(PENDING);
    const dir = path.join(root, 'docs', 'releases', '2026');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'v11.0.3.md'), '# 人工定稿的历史底账\n');
    fs.writeFileSync(path.join(dir, 'v11.0.2.md'), `${AUTO_MARKER}\n# 旧的自动草稿\n`);

    const result = generateReleaseLedger(root);
    expect(result.removed).toEqual(['v11.0.2.md']);
    expect(fs.existsSync(path.join(dir, 'v11.0.3.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'v11.0.2.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'v11.0.4.md'))).toBe(true);
  });

  it('entries 为空时仍产出可过校验的空窗版本底账', () => {
    const root = makeFixtureRoot({ ...PENDING, entries: [] });
    generateReleaseLedger(root);
    expect(validateReleaseLedger(root).version).toBe('11.0.4');
  });
});
