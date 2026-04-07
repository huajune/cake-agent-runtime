import {
  API_BOOKING_SUBMISSION_FIELDS,
  EDUCATION_MAPPING,
  getAvailableEducations,
  getEducationIdByName,
} from '@tools/duliday/job-booking.contract';

describe('job-booking.contract', () => {
  it('should expose the fixed API submission contract fields in order', () => {
    expect(API_BOOKING_SUBMISSION_FIELDS).toEqual([
      '姓名',
      '联系电话',
      '性别',
      '年龄',
      '面试时间',
      '学历',
      '健康证情况',
    ]);
  });

  it('should convert education names back to ids', () => {
    expect(getEducationIdByName('大专')).toBe(5);
    expect(getEducationIdByName('本科')).toBe(6);
    expect(getEducationIdByName('博士后')).toBeNull();
  });

  it('should return all available education labels from the mapping', () => {
    expect(getAvailableEducations()).toEqual(Object.values(EDUCATION_MAPPING));
  });
});
