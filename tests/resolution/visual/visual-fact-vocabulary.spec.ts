import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FIELD_OWNERSHIPS,
  VISUAL_FACT_FIELD_KEYS,
  VISUAL_FACT_FIELD_KEY_PROMPT,
  VISUAL_FACT_KINDS,
  VISUAL_FACT_KIND_PROMPT,
} from '@/resolution/visual';

/**
 * 视觉事实词表的「单一居所」守卫。
 *
 * 背景：kind / field key / ownership 三张词表原本在 resolution/visual 有权威常量，
 * 却被两个生产者（channels P1 预描述、tools P2 工具）各手抄了一份进 zod schema 与
 * describe 文案。其中 key 词表最危险——schema 刻意收 string 而非 enum，模型能否
 * 产出合法 key 全靠 describe 里那句词表；漂移了不报错、不抛类型错，只是静默少收
 * 一类事实。本 spec 把「只有一处定义」变成可执行断言。
 */

const REPO_SRC = join(__dirname, '../../../src');
const PRODUCERS = [
  'tools/save-image-description.tool.ts',
  'channels/wecom/message/application/image-description.service.ts',
];

describe('resolution/visual · 词表单一居所', () => {
  it('生成的 kind 提示串覆盖且仅覆盖权威 kind 词表', () => {
    for (const kind of VISUAL_FACT_KINDS) {
      expect(VISUAL_FACT_KIND_PROMPT).toContain(`${kind}=`);
    }
    // 释义两两以「；」分隔，段数必须与词表等长（多写/漏写一档即失败）
    expect(VISUAL_FACT_KIND_PROMPT.split('；')).toHaveLength(VISUAL_FACT_KINDS.length);
  });

  it('生成的 key 提示串覆盖且仅覆盖权威 key 白名单', () => {
    const listed = VISUAL_FACT_FIELD_KEY_PROMPT.replace('只能用这些值：', '').split(' / ');
    expect(listed).toEqual([...VISUAL_FACT_FIELD_KEYS]);
  });

  it.each(PRODUCERS)('%s 不得再手抄词表副本', (relPath) => {
    const source = readFileSync(join(REPO_SRC, relPath), 'utf8');

    // ownership 内联字面量数组（本次清理掉的形态）
    expect(source).not.toMatch(/\[\s*'candidate'\s*,\s*'publisher'\s*,/);
    // key 白名单手抄进 describe（用两个相邻 key 作指纹，避免误伤单个 key 的正常引用）
    expect(source).not.toContain('salary_text / shift_text');
    // kind 释义手抄进 describe
    expect(source).not.toContain('map_location=地图');

    // 反向确认：确实是从权威常量取的
    expect(source).toContain('@resolution/visual');
  });

  it('ownership 词表本身未被改动（消费端 finalize 默认值规则依赖此顺序与取值）', () => {
    expect([...FIELD_OWNERSHIPS]).toEqual(['candidate', 'publisher', 'third_party', 'unknown']);
  });
});
