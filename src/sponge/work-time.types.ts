import { z } from 'zod';

const ClockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const EndClockSchema = z.union([ClockSchema, z.literal('24:00')]);
const SlotSchema = z
  .object({
    combinedArrangementStartTime: ClockSchema,
    combinedArrangementEndTime: EndClockSchema,
  })
  .strict()
  .refine((slot) => slot.combinedArrangementStartTime !== slot.combinedArrangementEndTime, {
    message: '班次起止钟点相同，海绵需明确含义或修复',
    path: ['combinedArrangementEndTime'],
  });
const FlexibleTimeSchema = z
  .object({
    perDayMinWorkHours: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .refine((value) => Number(value) > 0 && Number(value) <= 24, '最低工时须大于0且不超过24小时'),
    shiftCodes: z.array(z.string()),
    goToWorkStartTime: ClockSchema,
    goOffWorkEndTime: EndClockSchema,
    goOffWorkTimeType: z.enum(['当日', '次日']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const minutes = (clock: string) => {
      const [h, m] = clock.split(':').map(Number);
      return h * 60 + m;
    };
    const span =
      minutes(value.goOffWorkEndTime) +
      (value.goOffWorkTimeType === '次日' ? 1440 : 0) -
      minutes(value.goToWorkStartTime);
    if (span <= 0 || span > 1440 || Number(value.perDayMinWorkHours) * 60 > span) {
      ctx.addIssue({ code: 'custom', message: '排班窗口须在0到24小时内，且足以覆盖最低工时' });
    }
  });

/** 海绵班次的固定字段契约。不接受历史整句类型、不补值、不按数组长度改类型。 */
export const DayWorkTimeSchema = z.discriminatedUnion('arrangementType', [
  z
    .object({
      arrangementType: z.literal('固定排班'),
      combinedArrangement: z.array(SlotSchema).min(1),
      fixedTime: z.null(),
    })
    .strict(),
  z
    .object({
      arrangementType: z.literal('组合排班制'),
      combinedArrangement: z.array(SlotSchema).min(2),
      fixedTime: z.null(),
    })
    .strict(),
  z
    .object({
      arrangementType: z.literal('灵活排班'),
      combinedArrangement: z.null(),
      fixedTime: FlexibleTimeSchema,
    })
    .strict(),
]);
export type DayWorkTime = z.infer<typeof DayWorkTimeSchema>;

export class WorkTimeContractError extends Error {
  constructor(
    message: string,
    public readonly jobId: number | null = null,
  ) {
    super(`海绵班次数据契约错误${jobId === null ? '' : `（岗位${jobId}）`}：${message}`);
    this.name = 'WorkTimeContractError';
  }
}

export function parseDayWorkTime(workTime: unknown, jobId: number | null = null): DayWorkTime {
  const parsed = z.object({ dayWorkTime: DayWorkTimeSchema }).safeParse(workTime);
  if (!parsed.success)
    throw new WorkTimeContractError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      jobId,
    );
  return parsed.data.dayWorkTime;
}
