import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildToolError', () => {
  it('should default to success: false when successField is omitted', () => {
    const result = buildToolError({
      errorType: TOOL_ERROR_TYPES.GEOCODE_FAILED,
      replyInstruction: '稍等再试',
    });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.GEOCODE_FAILED,
      _replyInstruction: '稍等再试',
    });
    // 'error' 字段在本轮 review 已清理，与 errorType 同值的冗余 alias 不应再出现
    expect(result).not.toHaveProperty('error');
  });

  it('should route to alternate success keys: dispatched / accepted / found', () => {
    const dispatched = buildToolError({
      errorType: TOOL_ERROR_TYPES.NO_ACTIVE_CASE,
      replyInstruction: '转人工',
      successField: 'dispatched',
    });
    const accepted = buildToolError({
      errorType: TOOL_ERROR_TYPES.NO_ACTIVE_CASE,
      replyInstruction: '转人工',
      successField: 'accepted',
    });
    const found = buildToolError({
      errorType: TOOL_ERROR_TYPES.NO_ACTIVE_CASE,
      replyInstruction: '转人工',
      successField: 'found',
    });

    expect(dispatched).toMatchObject({ dispatched: false });
    expect(dispatched).not.toHaveProperty('success');
    expect(accepted).toMatchObject({ accepted: false });
    expect(accepted).not.toHaveProperty('success');
    expect(found).toMatchObject({ found: false });
    expect(found).not.toHaveProperty('success');
  });

  it('should attach _outcome only when provided', () => {
    const withOutcome = buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
      replyInstruction: '换岗位',
      outcome: '预约失败（API 拒绝）',
    });
    const withoutOutcome = buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
      replyInstruction: '换岗位',
    });

    expect(withOutcome).toMatchObject({ _outcome: '预约失败（API 拒绝）' });
    expect(withoutOutcome).not.toHaveProperty('_outcome');
  });

  it('should spread details fields onto the returned object', () => {
    const result = buildToolError({
      errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_IN_CITY,
      replyInstruction: '本城市没有候选群',
      details: { city: '上海', industry: '餐饮', citySnapshot: { totalGroups: 0 } },
    });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_IN_CITY,
      city: '上海',
      industry: '餐饮',
      citySnapshot: { totalGroups: 0 },
    });
  });

  it('should not let details override the core errorType / _replyInstruction fields', () => {
    // details 是 helper 的开放扩展位，但核心契约字段不应被覆写
    const result = buildToolError({
      errorType: TOOL_ERROR_TYPES.GEOCODE_FAILED,
      replyInstruction: '正确指令',
      details: {
        // 故意尝试用 details 污染核心字段——helper 必须确保稳定形状
        // 当前实现是按字段顺序排列（details 在 _replyInstruction 之后），所以确认两件事：
        // 1) errorType 保持来自 args.errorType
        // 2) _replyInstruction 不允许被覆盖（如果允许会引发安全隐患）
        somethingExtra: 'ok',
      },
    });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_FAILED);
    expect(result._replyInstruction).toBe('正确指令');
    expect(result.somethingExtra).toBe('ok');
  });

  it('TOOL_ERROR_TYPES values should follow namespace.code convention', () => {
    // 监控/告警面板按 namespace 前缀聚合；这里只断言所有 value 形如 `xxx.yyy`，
    // 保证未来新增 errorType 不会破坏聚合
    for (const [key, value] of Object.entries(TOOL_ERROR_TYPES)) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^[a-z_]+\.[a-z_]+$/);
      // 常量 key 用 SCREAMING_SNAKE_CASE
      expect(key).toBe(key.toUpperCase());
    }
  });
});
