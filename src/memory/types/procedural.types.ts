/** 程序记忆 — 招聘流程阶段状态 */
export interface ProceduralState {
  /** 当前这段会话停留在哪个业务阶段。 */
  currentStage: string | null;
  /** 最近一次显式推进时，推进前所在的阶段。 */
  fromStage: string | null;
  /** 最近一次通过 advance_stage 显式推进阶段的时间。 */
  advancedAt: string | null;
  /** 最近一次推进阶段时记录的原因。 */
  reason: string | null;
}
