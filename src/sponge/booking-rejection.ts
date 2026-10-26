/** Confirmed booking business rejections. Unrecognized codes remain indeterminate. */
export function classifyBookingRejection(result: { success: boolean; code?: number }) {
  if (result.success) return null;
  switch (result.code) {
    case 30058:
      return 'capacity_full' as const;
    case 30049:
      return 'interview_time_rejected' as const;
    default:
      return null;
  }
}
