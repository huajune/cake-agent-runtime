import { FeishuTaskClient } from '@notification/feishu-task/feishu-task.client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('FeishuTaskClient', () => {
  const feishuApi = { getToken: jest.fn(async () => 'tok') };
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit | undefined]>();
  let client: FeishuTaskClient;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new FeishuTaskClient(feishuApi as never);
    jest
      .spyOn(client as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
  });

  it('createTask 组装官方字段并返回 guid', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { code: 0, msg: 'ok', data: { task: { guid: 'g1' } } }),
    );
    const dueAt = new Date('2026-09-22T03:00:00Z');
    const task = await client.createTask({
      summary: 's',
      description: 'd',
      dueAt,
      members: [{ id: 'ou_1' }],
      tasklistGuid: 'tl',
      sectionGuid: 'sec',
      customFields: [{ guid: 'f', text_value: 'v' }],
      clientToken: 'ct',
    });
    expect(task?.guid).toBe('g1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/tasks?user_id_type=open_id');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init?.body))).toEqual({
      summary: 's',
      description: 'd',
      due: { timestamp: String(dueAt.getTime()), is_all_day: false },
      members: [{ id: 'ou_1', type: 'user', role: 'assignee' }],
      tasklists: [{ tasklist_guid: 'tl', section_guid: 'sec' }],
      custom_fields: [{ guid: 'f', text_value: 'v' }],
      client_token: 'ct',
    });
  });

  it('HTTP 429 指数退避后重试成功', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { code: 99991400, msg: 'rate' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { code: 0, msg: 'ok', data: { task: { guid: 'g2' } } }),
      );
    const task = await client.createTask({ summary: 's' });
    expect(task?.guid).toBe('g2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('业务错误码不抛错，返回 null', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { code: 1470001, msg: 'no permission' }));
    await expect(client.createTask({ summary: 's' })).resolves.toBeNull();
    await expect(client.addMembers('g', [{ id: 'ou' }])).resolves.toBe(false);
  });

  it('网络异常 / token 失败均不抛错', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(client.addComment('g', 'c')).resolves.toBeNull();
    feishuApi.getToken.mockRejectedValueOnce(new Error('token'));
    await expect(client.updateTask('g', { summary: 'x' })).resolves.toBe(false);
  });

  it('字段目录缓存：选项缺失时创建并刷新缓存', async () => {
    const catalog = {
      code: 0,
      msg: 'ok',
      data: {
        items: [
          {
            guid: 'f-priority',
            name: '优先级',
            type: 'single_select',
            single_select_setting: { options: [{ guid: 'o-urgent', name: '急' }] },
          },
        ],
        has_more: false,
      },
    };
    const refreshed = {
      ...catalog,
      data: {
        ...catalog.data,
        items: [
          {
            ...catalog.data.items[0],
            single_select_setting: {
              options: [
                { guid: 'o-urgent', name: '急' },
                { guid: 'o-today', name: '当日' },
              ],
            },
          },
        ],
      },
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, catalog))
      .mockResolvedValueOnce(
        jsonResponse(200, { code: 0, msg: 'ok', data: { option: { guid: 'o-today' } } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, refreshed));

    expect(await client.resolveFieldGuid('tl', '优先级')).toBe('f-priority');
    expect(await client.resolveOptionGuid('tl', '优先级', '急')).toBe('o-urgent');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 命中缓存
    expect(await client.resolveOptionGuid('tl', '优先级', '当日')).toBe('o-today');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://open.feishu.cn/open-apis/task/v2/custom_fields/f-priority/options',
    );
    expect(await client.resolveOptionGuid('tl', '优先级', '当日')).toBe('o-today');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await client.resolveFieldGuid('tl', '不存在')).toBeNull();
  });

  it('分组缺失时创建', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          code: 0,
          msg: 'ok',
          data: { items: [{ guid: 's1', name: 'T1 现场急件' }] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { code: 0, msg: 'ok', data: { section: { guid: 's2' } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          code: 0,
          msg: 'ok',
          data: {
            items: [
              { guid: 's1', name: 'T1 现场急件' },
              { guid: 's2', name: 'T2 预约协调' },
            ],
          },
        }),
      );
    expect(await client.resolveSectionGuid('tl', 'T1 现场急件')).toBe('s1');
    expect(await client.resolveSectionGuid('tl', 'T2 预约协调')).toBe('s2');
    expect(await client.resolveSectionGuid('tl', 'T2 预约协调')).toBe('s2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
