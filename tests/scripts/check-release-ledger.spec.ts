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

  it('rejects a pending ledger for a formal release', () => {
    const root = createRepo('pending-2026-07-21-pr-619.md', validLedger);
    expect(() => validateReleaseLedger(root)).toThrow('仍有 pending 底账');
  });

  it('rejects incomplete P0 cases', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('通过 |', '部分通过 |'));
    expect(() => validateReleaseLedger(root)).toThrow('P0 仍包含');
  });

  it('rejects unchecked release gates', () => {
    const root = createRepo('v10.23.0.md', validLedger.replace('- [x]', '- [ ]'));
    expect(() => validateReleaseLedger(root)).toThrow('发布闸口仍有未勾选项');
  });
});
