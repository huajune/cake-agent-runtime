import { API_BOOKING_SUBMISSION_FIELDS } from '@tools/duliday/job-booking.contract';
import {
  findSpongeEducationIdByLabel,
  getAvailableSpongeEducations,
  SPONGE_COLLECTABLE_EDUCATION_MAPPING,
  SPONGE_EDUCATION_MAPPING,
} from '@sponge/sponge.enums';

describe('job-booking.contract', () => {
  it('should expose the fixed API submission contract fields in order', () => {
    expect(API_BOOKING_SUBMISSION_FIELDS).toEqual(['姓名', '联系电话', '性别', '年龄', '面试时间']);
  });

  it('should convert sponge education names back to ids', () => {
    expect(findSpongeEducationIdByLabel('大专')).toBe(3);
    expect(findSpongeEducationIdByLabel('本科')).toBe(2);
    expect(findSpongeEducationIdByLabel('博士后')).toBeNull();
  });

  it('should return collectable sponge education labels without 不限', () => {
    expect(getAvailableSpongeEducations()).toEqual(
      Object.values(SPONGE_COLLECTABLE_EDUCATION_MAPPING),
    );
    expect(getAvailableSpongeEducations()).not.toContain(SPONGE_EDUCATION_MAPPING[1]);
  });
});
