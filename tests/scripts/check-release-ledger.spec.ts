const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateReleaseLedger } = require('../../scripts/check-release-ledger');

function createRepo(ledgerName: string, ledgerContent: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ledger-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '10.23.0' }));
  const directory = path.join(root, 'docs', 'releases', '2026');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ledgerName), ledgerContent);
  return root;
}

const validLedger = [
  '# 发版底账',
  '### P0：发布阻断',
  '| ID | 状态 |',
  '| --- | --- |',
  '| P0-01 | 通过 |',
  '### P1：重点观察',
  '## 5. 发布闸口',
  '- [x] P0 全部通过',
  '## 6. 发布结果',
].join('\n');

describe('check-release-ledger', () => {
  it('accepts the version ledger when P0 and release gates are complete', () => {
    const root = createRepo('v10.23.0.md', validLedger);
    expect(validateReleaseLedger(root)).toEqual(
      expect.objectContaining({
        version: '10.23.0',
        ledgerPath: expect.stringContaining('v10.23.0.md'),
      }),
    );
  });

  it('locates 状态 by header when the template includes a trailing 证据 column', () => {
    const ledger = validLedger
      .replace('| ID | 状态 |', '| ID | 场景与输入 | 状态 | 证据 |')
      .replace('| --- | --- |', '| --- | --- | --- | --- |')
      .replace('| P0-01 | 通过 |', '| P0-01 | 场景 | 通过 | run-123 |');
    const root = createRepo('v10.23.0.md', ledger);

    expect(validateReleaseLedger(root)).toEqual(expect.objectContaining({ version: '10.23.0' }));
  });

  it('rejects an incomplete status even when 证据 is the final column', () => {
    const ledger = validLedger
      .replace('| ID | 状态 |', '| ID | 场景与输入 | 状态 | 证据 |')
      .replace('| --- | --- |', '| --- | --- | --- | --- |')
      .replace('| P0-01 | 通过 |', '| P0-01 | 场景 | 待验证 | run-123 |');
    const root = createRepo('v10.23.0.md', ledger);

    expect(() => validateReleaseLedger(root)).toThrow('P0-01=待验证');
  });

  it('rejects a pending ledger for a formal release', () => {
    const root = createRepo('pending-2026-07-21-pr-619.md', validLedger);
    expect(() => validateReleaseLedger(root)).toThrow('仍有 pending 底账');
  });

  it('rejects leftover pending ledgers even when the matching version ledger exists', () => {
    const root = createRepo('v10.23.0.md', validLedger);
    const directory = path.join(root, 'docs', 'releases', '2026');
    fs.writeFileSync(path.join(directory, 'pending-aborted-release.md'), validLedger);

    expect(() => validateReleaseLedger(root)).toThrow('正式版本底账已存在，但仍有 pending 底账');
  });

  it('rejects incomplete P0 cases', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('通过 |', '部分通过 |'));
    expect(() => validateReleaseLedger(root)).toThrow('P0 状态必须明确为“通过”');
  });

  it('rejects unknown P0 statuses instead of treating them as passed', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('通过 |', '已回放 |'));
    expect(() => validateReleaseLedger(root)).toThrow('P0-01=已回放');
  });

  it('rejects an empty P0 table', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('| P0-01 | 通过 |\n', ''));
    expect(() => validateReleaseLedger(root)).toThrow('没有可验证的 case');
  });

  it('rejects a P0 table without a 状态 column', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('状态', '结果'));
    expect(() => validateReleaseLedger(root)).toThrow('缺少“状态”列');
  });

  it('rejects unchecked release gates', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('- [x]', '- [ ]'));
    expect(() => validateReleaseLedger(root)).toThrow('发布闸口仍有未勾选项');
  });
});
