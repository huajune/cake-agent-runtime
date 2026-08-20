import { InterviewBookingLabelValueSchema } from '@sponge/sponge.types';

describe('InterviewBookingLabelValueSchema', () => {
  it.each([
    { labelId: 1, optionCodes: ['option-a'] },
    { labelId: 2, value: '兮兮' },
  ])('accepts exactly one value carrier: %o', (value) => {
    expect(InterviewBookingLabelValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    { labelId: 1 },
    { labelId: 1, optionCodes: ['option-a'], value: '兮兮' },
    { labelId: 1, optionCodes: [] },
  ])('rejects an empty or ambiguous value carrier: %o', (value) => {
    expect(InterviewBookingLabelValueSchema.safeParse(value).success).toBe(false);
  });
});
