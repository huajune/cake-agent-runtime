import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';

describe('FeishuCardBuilderService', () => {
  let service: FeishuCardBuilderService;

  beforeEach(() => {
    service = new FeishuCardBuilderService();
  });

  it('should build a basic interactive card', () => {
    const card = service.buildMarkdownCard({
      title: '标题',
      content: '内容',
      color: 'green',
    });

    expect(card).toHaveProperty('msg_type', 'interactive');
    expect(card).toHaveProperty('card');

    const cardData = card.card as Record<string, unknown>;
    const header = cardData.header as Record<string, unknown>;
    expect(header.template).toBe('green');

    const title = header.title as Record<string, unknown>;
    expect(title.content).toBe('标题');

    const elements = cardData.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect(elements[0].tag).toBe('markdown');
    expect(elements[0].content).toBe('内容');
  });

  it('should append user mentions when atUsers are provided', () => {
    const card = service.buildMarkdownCard({
      title: '标题',
      content: '内容',
      atUsers: [
        { openId: 'ou_1', name: '高雅琪' },
        { openId: 'ou_2', name: '艾酱' },
      ],
    });

    const elements = ((card.card as Record<string, unknown>).elements ||
      []) as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(3);
    expect(elements[2].tag).toBe('div');
    expect(((elements[2].text as Record<string, unknown>).content as string)).toContain('ou_1');
    expect(((elements[2].text as Record<string, unknown>).content as string)).toContain('ou_2');
  });

  it('should append @all when atAll is true', () => {
    const card = service.buildMarkdownCard({
      title: '标题',
      content: '内容',
      atAll: true,
    });

    const elements = ((card.card as Record<string, unknown>).elements ||
      []) as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(3);
    expect(((elements[2].text as Record<string, unknown>).content as string)).toContain(
      '<at id=all></at>',
    );
  });

  it('should prefer atUsers over atAll', () => {
    const card = service.buildMarkdownCard({
      title: '标题',
      content: '内容',
      atAll: true,
      atUsers: [{ openId: 'ou_1', name: '高雅琪' }],
    });

    const elements = ((card.card as Record<string, unknown>).elements ||
      []) as Array<Record<string, unknown>>;
    expect(((elements[2].text as Record<string, unknown>).content as string)).toContain('ou_1');
    expect(((elements[2].text as Record<string, unknown>).content as string)).not.toContain(
      '<at id=all></at>',
    );
  });
});
