import { JobBasicInfoSchema } from '@sponge/sponge.types';

/**
 * basicInfo.cooperationMode 是海绵 2026-08-06 新增的字段，决定发薪主体与签约主体
 * （见 render.util 的「合作模式 → 发薪/签约主体结论」）。它必须能穿过 zod 解析活着
 * 到达渲染层——JobBasicInfoSchema 虽有 .catchall(z.unknown()) 兜底，但显式声明后
 * 若有人误改成 strict/omit，这些用例会立刻红。
 */
describe('JobBasicInfoSchema · cooperationMode', () => {
  const base = { jobId: 1 };

  it('保留 BPO / RPO 取值', () => {
    for (const mode of ['BPO', 'RPO']) {
      const parsed = JobBasicInfoSchema.safeParse({ ...base, cooperationMode: mode });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.cooperationMode).toBe(mode);
    }
  });

  it('字段缺失时解析通过（海绵发布前的老数据）', () => {
    const parsed = JobBasicInfoSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.cooperationMode).toBeUndefined();
  });

  it('字段为 null 时解析通过（未回填）', () => {
    const parsed = JobBasicInfoSchema.safeParse({ ...base, cooperationMode: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.cooperationMode).toBeNull();
  });

  it('非字符串取值不通过校验，不会静默变形', () => {
    expect(JobBasicInfoSchema.safeParse({ ...base, cooperationMode: 1 }).success).toBe(false);
  });
});
