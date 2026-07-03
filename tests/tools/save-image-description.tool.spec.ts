import { buildSaveImageDescriptionTool } from '@tools/save-image-description.tool';
import { MessageType } from '@enums/message-callback.enum';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildSaveImageDescriptionTool', () => {
  const mockChatSession = {
    updateMessageContent: jest.fn().mockResolvedValue(undefined),
  };

  const imageMessageIds = ['msg-img-1', 'msg-img-2'];

  beforeEach(() => jest.clearAllMocks());

  it('should return a valid ToolBuilder function', () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, imageMessageIds);
    expect(typeof builder).toBe('function');
  });

  it('should build a tool that returns a valid tool object', () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, imageMessageIds);
    const builtTool = builder({} as never);
    expect(builtTool).toBeDefined();
  });

  it('should update message content via chatSession when messageId is valid', async () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, imageMessageIds);
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      messageId: 'msg-img-1',
      description: '一张招聘海报，包含门店地址和薪资信息',
    });

    expect(result).toEqual({ success: true });
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-1',
      '[图片消息] 一张招聘海报，包含门店地址和薪资信息',
    );
  });

  it('should return success: false when messageId is not in imageMessageIds', async () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, imageMessageIds);
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      messageId: 'msg-unknown',
      description: '某些描述',
    });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.SAVE_IMAGE_INVALID_MESSAGE_ID,
      providedMessageId: 'msg-unknown',
    });
    expect(mockChatSession.updateMessageContent).not.toHaveBeenCalled();
  });

  it('should include imageMessageIds in tool description', () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, ['id-a', 'id-b']);
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((builtTool as any).description).toContain('id-a, id-b');
    expect((builtTool as any).description).toContain('4-12 个字');
    expect((builtTool as any).description).toContain('不要描述角色外观');
    expect((builtTool as any).description).toContain('品牌ID：10239');
    expect((builtTool as any).description).toContain('薪资及阶梯规则');
    expect((builtTool as any).description).toContain('班次时间');
  });

  it('should handle multiple images independently', async () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, imageMessageIds);
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (builtTool as any).execute;

    await exec({ messageId: 'msg-img-1', description: '第一张图片描述' });
    await exec({ messageId: 'msg-img-2', description: '第二张图片描述' });

    expect(mockChatSession.updateMessageContent).toHaveBeenCalledTimes(2);
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-1',
      '[图片消息] 第一张图片描述',
    );
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-2',
      '[图片消息] 第二张图片描述',
    );
  });

  it('should use [表情消息] prefix when messageType is EMOTION', async () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      ['msg-emoji-1', 'msg-img-1'],
      { 'msg-emoji-1': MessageType.EMOTION, 'msg-img-1': MessageType.IMAGE },
    );
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (builtTool as any).execute;

    await exec({ messageId: 'msg-emoji-1', description: '微笑表情' });
    await exec({ messageId: 'msg-img-1', description: '一张招聘海报' });

    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-emoji-1',
      '[表情消息] 微笑表情',
    );
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-1',
      '[图片消息] 一张招聘海报',
    );
  });

  it('should append 简历附件 line when description identifies a resume image', async () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      imageMessageIds,
      { 'msg-img-1': MessageType.IMAGE },
      { 'msg-img-1': 'https://example.com/artwork/abc123.jpg' },
    );
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      messageId: 'msg-img-1',
      description: '简历图片：姓名兮兮，手机号18271421690，籍贯启东，身高163cm。',
    });

    expect(result).toEqual({
      success: true,
      resumeAttachmentUrl: 'https://example.com/artwork/abc123.jpg',
    });
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-1',
      '[图片消息] 简历图片：姓名兮兮，手机号18271421690，籍贯启东，身高163cm。\n简历附件：https://example.com/artwork/abc123.jpg',
    );
  });

  it('should not append 简历附件 line for non-resume descriptions or emotion messages', async () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      ['msg-img-1', 'msg-emoji-1'],
      { 'msg-img-1': MessageType.IMAGE, 'msg-emoji-1': MessageType.EMOTION },
      {
        'msg-img-1': 'https://example.com/artwork/poster.jpg',
        'msg-emoji-1': 'https://example.com/artwork/emoji.gif',
      },
    );
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (builtTool as any).execute;

    await exec({ messageId: 'msg-img-1', description: 'Boss直聘简历列表截图，展示多个候选岗位' });
    await exec({ messageId: 'msg-emoji-1', description: '微笑' });

    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-1',
      '[图片消息] Boss直聘简历列表截图，展示多个候选岗位',
    );
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-emoji-1',
      '[表情消息] 微笑',
    );
  });

  it('should not append 简历附件 line when image URL is unknown', async () => {
    const builder = buildSaveImageDescriptionTool(mockChatSession as never, imageMessageIds, {
      'msg-img-1': MessageType.IMAGE,
    });
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      messageId: 'msg-img-1',
      description: '手写简历，包含姓名与电话',
    });

    expect(result).toEqual({ success: true });
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-img-1',
      '[图片消息] 手写简历，包含姓名与电话',
    );
  });

  it('should fall back to [图片消息] prefix when messageId is missing from visualMessageTypes', async () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      ['msg-unknown-kind'],
      {},
    );
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      messageId: 'msg-unknown-kind',
      description: '未标注类型的描述',
    });

    expect(result).toEqual({ success: true });
    expect(mockChatSession.updateMessageContent).toHaveBeenCalledWith(
      'msg-unknown-kind',
      '[图片消息] 未标注类型的描述',
    );
  });
});
