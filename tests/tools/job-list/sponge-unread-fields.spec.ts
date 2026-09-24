import * as path from 'path';
import { JobDetailSchema } from '@sponge/sponge.types';
import {
  collectFieldPaths,
  collectSourcePropertyKeys,
  collectZodDeclaredPaths,
  leafKeyOf,
  loadSpongeJobFixtures,
  readUnreadFieldsAllowlist,
  UNREAD_FIELDS_ALLOWLIST_PATH,
} from '../../fixtures/sponge-jobs';

/**
 * 「海绵下发但蛋糕从未读取」字段比对（PRD R4 J9 / R8 防复发）。
 *
 * 口径：字段路径来自真实样例；「已读」= 在 sponge.types.ts 的 zod schema 里显式声明，
 * 或其叶子键在 src/ 任一非测试源码里以属性形态出现（`.key` / `'key'` / `key:`）。
 * 这是启发式：通用键（salary/description…）会被别处对象误算成已读，所以本测只能兜住
 * 「没有任何代码提到」的字段；反向（提到就等于读对）不成立。
 *
 * 出现新未读字段 → 要么接入读取，要么人审后加进 allowlist（附说明）；allowlist 里的字段
 * 一旦被接入读取，本测同样报错提醒把它移出，保证清单始终是现状。
 */
const SRC_DIR = path.resolve(__dirname, '../../../src');

describe('sponge unread fields (海绵下发但蛋糕未读)', () => {
  const fixturePaths = new Set<string>();
  for (const job of loadSpongeJobFixtures()) collectFieldPaths(job, '', fixturePaths);
  const declared = collectZodDeclaredPaths(JobDetailSchema);
  const sourceKeys = collectSourcePropertyKeys(SRC_DIR);

  const unread = [...fixturePaths]
    .filter((fieldPath) => !declared.has(fieldPath) && !sourceKeys.has(leafKeyOf(fieldPath)))
    .sort();
  const allowlist = readUnreadFieldsAllowlist();
  const allowed = new Set(allowlist.paths);

  it('样例字段路径与源码属性键都收集到了', () => {
    expect(fixturePaths.size).toBeGreaterThan(100);
    expect(declared.has('basicInfo.cooperationMode')).toBe(true);
    expect(sourceKeys.has('cooperationMode')).toBe(true);
    expect(sourceKeys.has('memo')).toBe(true);
  });

  it('未读字段必须都在 allowlist 里（新出现的先人审）', () => {
    const newlyUnread = unread.filter((fieldPath) => !allowed.has(fieldPath));
    if (newlyUnread.length > 0) {
      throw new Error(
        `以下海绵字段没有任何代码读取，请接入读取或人审后加入 ${UNREAD_FIELDS_ALLOWLIST_PATH}：\n` +
          newlyUnread.map((fieldPath) => `  - ${fieldPath}`).join('\n'),
      );
    }
    expect(newlyUnread).toEqual([]);
  });

  it('allowlist 里的字段仍然未读（已接入读取的要移出清单）', () => {
    const stale = allowlist.paths.filter((fieldPath) => !unread.includes(fieldPath));
    if (stale.length > 0) {
      throw new Error(
        `以下字段已被代码读取，请从 allowlist 移除：\n${stale.map((p) => `  - ${p}`).join('\n')}`,
      );
    }
    expect(stale).toEqual([]);
  });

  it('allowlist 已排序去重，便于 diff', () => {
    expect(allowlist.paths).toEqual([...new Set(allowlist.paths)].sort());
  });
});
