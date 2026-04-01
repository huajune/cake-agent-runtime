import { buildSaveImageDescriptionTool } from '@tools/save-image-description.tool';

describe('buildSaveImageDescriptionTool', () => {
  const mockChatSession = {
    updateMessageContent: jest.fn().mockResolvedValue(undefined),
  };

  const imageMessageIds = ['msg-img-1', 'msg-img-2'];

  beforeEach(() => jest.clearAllMocks());

  it('should return a valid ToolBuilder function', () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      imageMessageIds,
    );
    expect(typeof builder).toBe('function');
  });

  it('should build a tool that returns a valid tool object', () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      imageMessageIds,
    );
    const builtTool = builder({} as never);
    expect(builtTool).toBeDefined();
  });

  it('should update message content via chatSession when messageId is valid', async () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      imageMessageIds,
    );
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
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      imageMessageIds,
    );
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      messageId: 'msg-unknown',
      description: '某些描述',
    });

    expect(result).toEqual({ success: false, error: 'Invalid messageId' });
    expect(mockChatSession.updateMessageContent).not.toHaveBeenCalled();
  });

  it('should include imageMessageIds in tool description', () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      ['id-a', 'id-b'],
    );
    const builtTool = builder({} as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((builtTool as any).description).toContain('id-a, id-b');
  });

  it('should handle multiple images independently', async () => {
    const builder = buildSaveImageDescriptionTool(
      mockChatSession as never,
      imageMessageIds,
    );
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
});
