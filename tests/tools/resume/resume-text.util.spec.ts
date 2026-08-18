import {
  hoistProfileBlock,
  normalizeResumeText,
  trimLowValueSections,
} from '@tools/resume/resume-text.util';

describe('resume-text.util', () => {
  it('normalizes Unicode, newlines and spacing once for extract/notary parity', () => {
    expect(normalizeResumeText('姓名：\t兮兮\r\n\r\n\r\n电话：  18271421690')).toBe(
      '姓名: 兮兮\n\n电话: 18271421690',
    );
  });

  it('trims low-value sections without removing later work experience', () => {
    const text = [
      '教育经历',
      '测试大学本科',
      '自我评价',
      '认真负责'.repeat(200),
      '工作经历',
      '测试咖啡店3年',
    ].join('\n');
    const result = trimLowValueSections(text, 3000);
    expect(result).not.toContain('认真负责');
    expect(result).toContain('工作经历\n测试咖啡店3年');
  });

  it('enforces the output character limit after section trimming', () => {
    expect(trimLowValueSections('工作经历\n' + '门店服务'.repeat(1000), 100).length).toBe(100);
  });

  it('moves profile lines to the front and leaves unmatched text unchanged', () => {
    const text = '教育经历\n测试大学本科\n姓名:兮兮\n电话:18271421690\n24岁';
    expect(hoistProfileBlock(text)).toBe(
      '基本信息\n姓名:兮兮\n电话:18271421690\n24岁\n教育经历\n测试大学本科',
    );
    expect(hoistProfileBlock('教育经历\n测试大学本科')).toBe('教育经历\n测试大学本科');
  });
});
