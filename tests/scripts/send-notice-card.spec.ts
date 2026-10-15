import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  assertFeishuResponse,
  buildCard,
  main,
  parseArgs,
  validateNotice,
} = require('../../scripts/ops-release-notice/send-notice-card');
const example = require('../../src/skills/ship-release/references/ops-release-notice-example.json');

const EXAMPLE_PATH = 'src/skills/ship-release/references/ops-release-notice-example.json';

type CardElement = { tag: string; content?: string; text?: { content: string } };

function notice(overrides: Record<string, unknown> = {}) {
  return {
    dateLabel: '10 月 15 日',
    intro: '今天 17:43 上线 v11.13.2。',
    sections: [
      { heading: '🆕 新上线功能', items: ['**功能 A**：说明'] },
      { heading: '🔧 问题修复', items: ['修复 B', '修复 C'] },
    ],
    ...overrides,
  };
}

function mockDeps(body = '{"code":0,"msg":"success"}') {
  return {
    loadWebhookConfig: jest.fn(() => ({ url: 'https://example.invalid/hook', secret: '' })),
    postJson: jest.fn(async () => ({ statusCode: 200, body })),
  };
}

describe('ops release notice card', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the release-card style title, numbered sections and @all', () => {
    const card = buildCard(notice());
    const elements = card.elements as CardElement[];

    expect(card.header.title.content).toBe('🎂 蛋糕私域托管 · 10 月 15 日上线通知 ✨');
    expect(card.header.template).toBe('violet');
    expect(elements.map((element) => element.tag)).toEqual([
      'markdown',
      'hr',
      'markdown',
      'hr',
      'markdown',
      'div',
    ]);
    expect(elements[0].content).toBe('今天 17:43 上线 v11.13.2。');
    expect(elements[4].content).toBe('**🔧 问题修复**\n1. 修复 B\n2. 修复 C');
    expect(elements[5].text?.content).toBe('<at id=all></at>');
  });

  it('keeps the bundled example within the Feishu request size limit', () => {
    const card = buildCard(example);
    const sections = (card.elements as CardElement[]).filter(
      (element) => element.tag === 'markdown',
    );

    expect(sections).toHaveLength(example.sections.length + 1);
    expect(Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', card }))).toBeLessThan(
      19 * 1024,
    );
  });

  it('escapes angle brackets so card markdown does not parse them as tags', () => {
    const card = buildCard(notice({ intro: '岗位数 <10 时提醒' }));

    expect((card.elements as CardElement[])[0].content).toBe('岗位数 &#60;10 时提醒');
  });

  it('rejects multi-line items so each entry stays one paragraph', () => {
    const nested = notice({
      sections: [{ heading: '🔧 问题修复', items: ['地点识别更准：\n- 村名\n- 地址'] }],
    });

    expect(() => validateNotice(nested)).toThrow('子条目合成一句');
  });

  it('rejects items that carry their own numbering and headings that carry bold markers', () => {
    expect(() =>
      validateNotice(notice({ sections: [{ heading: '🔧 问题修复', items: ['1. 修复 B'] }] })),
    ).toThrow('自带编号');
    expect(() =>
      validateNotice(notice({ sections: [{ heading: '**🔧 问题修复**', items: ['修复 B'] }] })),
    ).toThrow('不要自带 **');
  });

  it('rejects notices without intro or items', () => {
    expect(() => validateNotice(notice({ intro: '' }))).toThrow('缺少 intro');
    expect(() =>
      validateNotice(notice({ sections: [{ heading: '⚠️ 需要运营留意', items: [] }] })),
    ).toThrow('没有条目');
  });

  it('rejects a section that exceeds the per-section length limit', () => {
    const long = notice({
      sections: [
        { heading: '🔧 问题修复', items: Array.from({ length: 40 }, () => '字'.repeat(100)) },
      ],
    });

    expect(() => validateNotice(long)).toThrow('超过 3500');
  });

  it('rejects misspelled flags instead of sending for real', () => {
    expect(() => parseArgs(['n.json', '--dryrun'])).toThrow('不认识的参数');
    expect(() => parseArgs(['n.json', '—dry-run'])).toThrow('不认识的参数');
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow('用法');
    expect(parseArgs(['n.json', '--dry-run'])).toEqual({
      noticePath: 'n.json',
      dryRun: true,
      printJson: false,
    });
  });

  it('dry-run never loads credentials or posts', async () => {
    const deps = mockDeps();

    await main([EXAMPLE_PATH, '--dry-run'], deps);

    expect(deps.loadWebhookConfig).not.toHaveBeenCalled();
    expect(deps.postJson).not.toHaveBeenCalled();
  });

  it('sends once and refuses a second send of the same notice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notice-'));
    const noticePath = path.join(dir, 'notice.json');
    fs.writeFileSync(noticePath, JSON.stringify(notice()));
    const deps = mockDeps();

    try {
      await main([noticePath], deps);
      expect(deps.postJson).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(`${noticePath}.sent`)).toBe(true);

      await expect(main([noticePath], deps)).rejects.toThrow('发送过');
      expect(deps.postJson).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mark the notice as sent when Feishu rejects it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notice-'));
    const noticePath = path.join(dir, 'notice.json');
    fs.writeFileSync(noticePath, JSON.stringify(notice()));

    try {
      await expect(
        main([noticePath], mockDeps('{"code":19021,"msg":"sign match fail"}')),
      ).rejects.toThrow('code=19021');
      expect(fs.existsSync(`${noticePath}.sent`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats non-zero Feishu codes as failures', () => {
    expect(() => assertFeishuResponse({ statusCode: 200, body: '{"code":11232}' })).toThrow(
      'code=11232',
    );
    expect(() =>
      assertFeishuResponse({ statusCode: 200, body: '{"StatusCode":0,"code":0}' }),
    ).not.toThrow();
  });
});
