import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { extractInterviewSupplementDefinitions } from '@sponge/sponge-job.util';
import { ToolBuilder } from '@shared-types/tool.types';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { stripNullish } from '@infra/utils/object.util';
import { API_BOOKING_USER_REQUIRED_FIELDS } from '@tools/duliday/booking/job-booking.contract';
import {
  buildJobPolicyAnalysis,
  isWaitNoticeInterview,
  normalizePolicyText,
} from '@tools/utils/job-policy-parser';
import {
  containsSensitiveScreeningText,
  SENSITIVE_SCREENING_CRITERIA_NOTICE,
} from '@tools/utils/sensitive-screening.util';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import {
  classifySupplementLabel,
  SupplementClassification,
} from '@tools/utils/supplement-label-classifier';
import { isStrictRealChineseName } from '@memory/facts/name-guard';
import {
  normalizeEducationValue,
  normalizeGenderValue,
  normalizeHealthCertificateValue,
  normalizeIdentityText,
  normalizeNumberText,
} from '@tools/duliday/precheck/field-normalize.util';

// Phase 1.A 拆分：辅助函数全部下沉到 duliday/precheck/* 子目录，0 逻辑改动。
import {
  detectAgeBoundary,
  parseAgeRange,
  parseCandidateAge,
} from '@tools/duliday/precheck/age.util';
import { normalizeRequestedDate } from '@tools/duliday/precheck/date.util';
import {
  buildChecklistTemplate,
  buildEnumHintsForMissing,
  buildKnownFieldMap,
  normalizeChecklistField,
} from '@tools/duliday/precheck/checklist.util';
import { getSupplementAnswerValue } from '@tools/duliday/booking/interview-booking-customer-label.builder';
import {
  buildCollectionStrategy,
  detectCollectionResistance,
  detectRealNameInsistence,
} from '@tools/duliday/precheck/collection-strategy.util';
import {
  buildBookableSlots,
  buildScheduleRule,
  buildUpcomingTimeOptions,
  evaluateRequestedDate,
} from '@tools/duliday/precheck/bookable-slot.util';
import {
  buildApiPayloadGuide,
  buildScreeningCriteria,
} from '@tools/duliday/precheck/screening-criteria.util';
import { isHighConfidenceValue } from '@memory/facts/high-confidence-facts';

// 保留 age util 的符号 re-export，兼容 tests/tools/tool/duliday-interview-precheck.age-boundary.spec
export {
  AGE_BOUNDARY_HANDOFF_FLOOR,
  AGE_BOUNDARY_LOWER_TOLERANCE_YEARS,
  AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
  detectAgeBoundary,
  parseAgeRange,
  parseCandidateAge,
} from '@tools/duliday/precheck/age.util';

const logger = new Logger('duliday_interview_precheck');

const DESCRIPTION = `面试前置校验。本工具负责解释岗位规则、返回筛选条件和收资策略，**不负责真正提交预约**（真正提交用 duliday_interview_booking）。

**与 duliday_interview_booking 的契约**：booking 工具完全信任本工具的结论，自身不会再做时段窗口/筛选答案/真实姓名等硬规则的二次校验。Agent 必须在调 booking 之前先调本工具，并按返回的 nextAction 行动；漏调本工具就直接进 booking 会让候选人被错约面、被错放过筛选硬伤。

## 何时调用
- 候选人问"今天可以吗"、"什么时候可以面试"、"要准备什么资料"、"还需要我提供什么信息"时优先调用
- 回答"今天可以吗/哪天能面/要补哪些资料"前，先看此工具结果；不要只根据 duliday_job_list 的摘要或自己理解直接回答
- 候选人明确提出日期或时间（如"后天最好"、"5月1号回来面试可以吗"、"今天六点才能下班可以去面试吗"）时，必须带 requestedDate 调用；当前焦点岗位不明确时，先确认门店/岗位，不得凭记忆给出可约日期
- 收资/约面过程中候选人补充"每周最多两天/做一休一/只周末/不上夜班/下班后/六点才下班/现在决定不了时间"等硬约束时，先用本工具和/或 duliday_job_list(includeWorkTime=true) 校验当前岗位是否匹配，再决定是否继续收资
- **进入收资场景前必须先调本工具一次**：候选人明确表达约面意向（"需要面试吗 / 帮我约 / 这家可以"等）后，**第一步必须先调本工具拿到 bookingChecklist.requiredFieldsToCollectNow 与 nameFieldGuard**，再按工具结果一次性发资料模板；严禁绕过工具直接问"哪天方便"或"叫什么"等碎片化收资
- **每次准备调 duliday_interview_booking 之前必须最后再确认一次本工具的本轮结果**：哪怕之前已经调过，只要候选人补了新字段、改了面试时间、改了门店或岗位，就要重新调一次，确保你拿到的 bookableSlots / screeningChecks / nameFieldGuard 是最新的

## 参数
- jobId：岗位 ID（必填）
- requestedDate：**仅当**候选人明确说出想约的具体日期时才传入（如 today / 明天 / 下周三 / YYYY-MM-DD）。候选人只是泛泛询问时不要传。**候选人已说出想约的日期/时间时，必须把同一个值同时传给 candidateInterviewTime**——只传 requestedDate 会因"面试时间"字段缺失而卡在 collect_fields，逼你下一轮再把本就已知的日期补进去对同一岗位重调一次，凭空多一轮工具往返
- candidateName / candidatePhone：候选人本轮在对话里给出的真实姓名 / 联系电话。**只要对话里能看到（典型如候选人本轮刚报名、或跨天回访旧会话事实已过期），就必须显式传入**——姓名/电话没有别的回灌通道，漏传会让"姓名/联系电话"一直留在 missingFields、nextAction 卡死 collect_fields，逼你反复让候选人确认。**禁止把姓名/电话塞进 candidateSupplementAnswers（那里只认岗位补充标签，会被忽略）**
- candidateAge：候选人已明确自报的年龄。只要当前对话里能看到候选人年龄，**必须显式传入本字段**，不要只依赖记忆或运行时高置信事实；不要传岗位年龄要求。candidateAge 与记忆冲突时，以 candidateAge 作为本轮最新口径
- candidateInterviewTime / candidateGender / candidateEducation / candidateHasHealthCertificate / candidateIsStudent / candidateUploadResume / candidateHeight / candidateWeight / candidateHouseholdProvince：候选人本轮已明确补充的预约字段。只传候选人答案，不要传岗位要求；这些字段与旧记忆冲突时，以本轮显式入参为准。**当 missingFields 含 身高/体重/户籍省份 且候选人本轮已给出时，务必用 candidateHeight/candidateWeight/candidateHouseholdProvince 传进来，否则会一直卡在 collect_fields 无法进 booking**
- candidateSupplementAnswers：候选人本轮已答的岗位补充标签（collect 型，如 居住地址/意向区域/周末两天是否在/每天可以出勤的时间/能做到什么时候/不要早班要周末和全天）的回答，key 用标签名、value 用候选人答案。**与 booking 的 supplementAnswers 同源**：只要候选人在对话里给出了这些补充标签的答案，就必须在本字段一并传入，否则这些标签会一直留在 missingFields、nextAction 永远卡在 collect_fields 无法进 booking。只传候选人答案，禁止传岗位筛选要求
- **一次性传全已知字段，禁止"残缺入参先调、补字段再调"**：调用本工具前，先把候选人当轮及历史**已经明确给出的所有字段**（年龄/性别/学历/健康证/面试日期时间等）整理齐再调用；严禁用残缺入参先调一次、看到 collect_fields 后把本就已知的字段补进去对同一岗位重调一遍——同一轮内对同一岗位重复 precheck 会触发 tool_loop 并平白拖慢一整轮响应。collect_fields 只应由候选人**确实尚未提供**的字段触发

## 返回字段
- interview.scheduleRule：岗位的面试周期规则，例如"周一至周五 13:30-16:30，当天 12:00 前报名"。用来回答"还有别的时间吗/下周能约吗"这类开放问题
- interview.upcomingTimeOptions：未来 7 天实际可约时段的示例 label 数组（已自动过滤报名截止已过的时段）。用来回答"给我几个时间选选"
- interview.bookableSlots：结构化可约时段。只有 bookingAllowed=true 且带 interviewTime 的 slot 才能进入 duliday_interview_booking；bookingAllowed=false / dateOnly=true 表示只确定日期、不确定具体面试时间，必须先人工确认，严禁拿 registrationDeadline 当 interviewTime
- interview.requestedDate：只有在传入 requestedDate 时才有；包含 status（available / unavailable / needs_confirmation）和 reason
- interview.interviewTimeMode："wait_notice" 表示该岗位未配置面试时段（平台预约时间=等待通知，常见于电话面试流程）。此时不需要收集"面试时间"、bookableSlots 为空属正常现象；资料收齐后 nextAction 即为 ready_to_book，调 duliday_interview_booking 时**不要传 interviewTime**。约面话术按 interviewTimeModeNote 执行：告知候选人提交后面试官会直接打电话联系（保持电话畅通），严禁因为"没有面试时段"判定无法预约或转人工
- interview.flowDescription / interview.processRemark / interview.timingHighlights：岗位面试流程的事实描述，含"线上 AI 面试 / 二维码会发到企微 / 保持电话畅通 / 24 小时出结果 / 入职前必须办好健康证"等关键流程。**预约成功后或候选人问"怎么面/什么形式/会发什么"时必须按这些字段照念**，不得凭 method 字段（仅"线上/线下"两个字）自己编流程。北京必胜客等品牌的 AI 面试码、流程节奏都在这里
- screeningCriteria：岗位硬性筛选条件（性别/年龄/学历/健康证/是否学生等），**用来筛人**——候选人不符合时直接说明，不要继续往下引导
- screeningCriteria.householdRegisterProvince（户籍约束）属于**敏感字段**，禁止直问"你是不是 X 籍 / 不要东北的 / 是不是本地"等让候选人感到被歧视的措辞；只能用"哥/姐方便问下是哪边人吗（公司这边登记需要核对下户籍信息）"等承接式开口，候选人主动给户籍后再对照 screeningCriteria.householdRegisterProvince 判断
- sensitiveScreeningNotice：返回该字段时，说明本岗位筛选条件（含 remark/screeningChecks 原文）内嵌户籍/籍贯/民族等敏感信息，必须严格按该提示执行——条件本身 🔒 仅供内部筛选，严禁透露给候选人
- healthCertGate：健康证业务口径，三选一：
  - "before_interview"：岗位明确收紧，必须先确认候选人有食品健康证才能继续约面；无证时直接说明"这家要求先有证才能约"并给办证建议
  - "before_onboard"：默认宽口径（多数岗位走这条），不要在约面前主动追问健康证；约面成功或推进入岗讨论时告知"上岗前要办好食品健康证"即可
  - "unknown"：岗位数据没提健康证，按宽口径处理但不主动提
- screeningChecks：岗位后台把约束语义直接配在 supplement label 里的那一类筛选题（例如 "是否学生（不要学生）"、"专业（非新媒、食品）"、"周四六日都能上班吗"）。**用来筛人**——必须先独立向候选人核对，候选人答案命中 failSignals 就停止收资、走婉拒/拉群，不得继续 booking；但 "食品类健康证/食品健康证/餐饮健康证" 是健康证类型，不是专业答案，遇到专业筛选题时必须澄清实际专业
- bookingChecklist.missingFields：预约还缺哪些字段（已剔除 screeningChecks 列出的筛选型 label）
- bookingChecklist.requiredFieldsToCollectNow：当前阶段必须立刻收齐的字段（missingFields 的扁平副本，便于一次性补问；若数组非空，回复必须把这些字段写成模板让候选人一次性填齐）
- bookingChecklist.templateText：正常收资场景下可直接参考的话术模板，已根据会话上下文预填已知字段
- bookingChecklist.enumHints：只包含 missingFields 涉及字段的合法枚举
- bookingChecklist.collectionStrategy：当前更适合一次性收资还是渐进式收资；若候选人已表现出抗拒，会返回 starterFields 供你先降负担推进
- nameFieldGuard：仅当当前已知姓名不像真名时返回（suspicious=true）；意味着 knownFieldMap 里的"姓名"是昵称或占位串，**严禁**在 booking 里复用——必须先向候选人补问真实姓名后再覆写
- apiPayloadGuide：最新 supplier/entryUser 契约入参指引

## 硬规则
- 面试时段是**周期性规则**，不是"固定几个名额"。即使 upcomingTimeOptions 只列出几条，也要结合 scheduleRule 理解完整规则，不得说"只有这几个时间可以约"
- **interview.interviewTimeMode === "wait_notice" 时**：不要追问候选人"哪天方便面试"；候选人主动给出日期也不用对齐时段，如实说明"这个岗位不用约时间，报名后面试官会直接打电话联系你"即可，继续按 bookingChecklist 收资；严禁因"没有面试时段"走 request_handoff 或告知候选人约不了
- "报名截止/registrationDeadline" 只表示最晚提交预约的时间，**绝不是面试时间**；严禁把报名截止时间传给 duliday_interview_booking
- 若 bookableSlots 中目标日期的 slot 为 dateOnly=true 或 bookingAllowed=false，只能告诉候选人"日期可以/线上面试但具体时间需确认"，不要调用 duliday_interview_booking
- 若 interview.requestedDate.status 为 unavailable，必须直接说明原因，不得继续引导候选人填写资料假装可以预约
- 若 interview.requestedDate.status 为 needs_confirmation，先表述"我先帮你确认下今天还能不能约"，不要直接承诺可以，也不要输出生硬的规则解释句
- 候选人指定的未来日期不可约时，只能说明该日期不可约并给出工具返回的最近可选时段，不能擅自把候选人改到更近/更远日期，也不能继续催今天/明天
- 候选人只是询问规则或资料时，先解释规则；不要跳过校验直接进入 duliday_interview_booking
- 当 nextAction = collect_fields 时，bookingChecklist.templateText 只是默认模板，不是必须逐字复读的指令；正常收资场景优先参考它一次性收集资料，但不要为了守模板而忽略候选人当前情绪
- 当候选人已经给过姓名、电话、年龄、学历、面试时间等字段时，使用 bookingChecklist.knownFieldMap / missingFields 只补问缺失项；不要让候选人重填已给字段
- **严禁分批发收资 checklist**：当 missingFields 包含多个字段时（如同时缺学历/健康证/住址/出勤天数/时间段等），必须**一次性把所有 missingFields 整合到同一条 templateText 中发给候选人**，让候选人一次填完所有缺失字段；禁止先问一组基础字段（姓名/电话/年龄/性别）让候选人填，回填后再补发一组扩展字段（学历/健康证/住址/出勤等）的"分批漏斗式"收资。例外只有两个：(a) collectionStrategy.mode === "progressive"；(b) 候选人本轮已表现抗拒/不耐烦——这两种情况才允许降级到 starterFields 渐进收资
- **字段集合必须与本工具返回一致**：发给候选人的资料模板字段名/字段数必须与 bookingChecklist.requiredFieldsToCollectNow（或降级时的 starterFields）**完全一致**——可以改文案/排版/补充语气，但**不得自行增删字段**。典型反例：precheck 返回需要"过往工作经验"等字段，Agent 自己改写时把"工作经验"漏掉、又凭习惯加上 precheck 没要求的"应聘门店/面试时间"，导致候选人按 Agent 模板回填后 booking 仍然缺字段或带错字段。要补充新字段时，必须在下一轮 precheck 工具调用里把字段补到 supplement label / supplier 入参里让本工具确认
- **nameFieldGuard.suspicious=true 时**：sessionFacts 里的姓名是昵称/占位串，本工具已经把"姓名"放回 missingFields、templateText 中"姓名："留空；必须先向候选人补问真实姓名（"门店登记需要本名"或同义请求）再调 booking，**严禁直接拿可疑姓名去调 duliday_interview_booking**
- **nameFieldGuard.mustHandoff=true 时**（候选人已坚持是真名，疑似少数民族/特殊姓名）：**严禁**继续要求候选人改名或重写姓名；必须立刻调 request_handoff(reasonCode="other", reason="疑似少数民族/特殊姓名 booking 校验拒绝，需人工补录") 转人工，由招募经理人工补录。重复逼问候选人改名会直接导致候选人流失
- **ageBoundary 字段**（始终存在）：候选人年龄筛选信号，包含 severity + reason：
  - **severity="pass"**：完全符合岗位年龄要求，正常流程
  - **severity="boundary"**（弹性范围内，如超上限 ≤3 岁或差下限 ≤2 岁且 ≥23 岁）：差一点点，**可继续推进**收资/约面，不需要 handoff 也不需要劝退
  - **severity="hard_reject"**（远超弹性范围）：年龄硬伤，**nextAction 已被设为 "age_rejected"**，禁止继续收资/约面/booking；必须婉拒当前岗位（禁止说出具体年龄要求数值），立即调 duliday_job_list 基于候选人其他条件查替代岗位；查无替代时走 invite_to_group 或 request_handoff
  - **severity="unknown"**：候选人年龄或岗位年龄要求未知，无法判断，按正常流程走（年龄在 missingFields 中待收集）
- 若候选人当轮出现抗拒、不耐烦、拒绝填写、嫌麻烦或辱骂，立即暂停模板化收资；先共情并解释用途，再按 bookingChecklist.collectionStrategy 里的 starterFields 降负担推进，不要继续追整张字段清单
- 只有在候选人恢复配合、且没有明显情绪阻力时，才恢复完整字段清单或继续进入预约
- 若返回了 screeningChecks，在把 templateText 发给候选人之前，**必须**用自然话术核对每一条的通过条件；候选人在专业筛选题里明确回答"我是食品专业/学食品"，或在出勤筛选题里回答"不一定"等命中 failSignals 的答案时，立即停止收资、婉拒并走 invite_to_group 或 request_handoff，**严禁带着不合格答案去调 duliday_interview_booking**（booking 不会再做筛选兜底）。若候选人说的是"食品类健康证/食品健康证/餐饮健康证"，不要当成专业不合格，先澄清专业
- **班次硬约束与岗位 workTime 不重叠时禁约面**：候选人 schedule 硬约束（"做一休一/每周最多两天/只周末/不上夜班/下班后/六点才下班"等）与当前候选岗位的工作时间无重叠时，禁止继续 collect_fields/duliday_interview_booking 进入约面流程，必须先用 duliday_job_list(includeWorkTime=true) 校验确认无匹配，再婉拒并走 invite_to_group。已经识别为不匹配仍继续收资约面 = 通融式推荐
- **候选人主动自报学生身份时（"我是学生/在读/本科在读/刚考上研究生/准研究生/待入学/暑假工/寒假工/这几个月没事干"等）**：必须照 screeningChecks 中"是否学生"题项核对——若该题项存在且候选人答案命中 failSignals，立即停止收资、走婉拒/拉群，不得继续 booking；若 screeningChecks 未返回该题项，**不得**凭"figure=不限/学历够/未写学生限制/工具未返回学生字段"反推为"身份没限制/接受学生"，必须保守说"这个身份我先帮你确认下"或调 request_handoff。判定与 duliday_job_list 工具描述中"学生身份不能由缺省反推"同口径
- **候选人明确说出未来某天才能面试（"五一回来再说/X 月 X 号之后/下周回来/月底/等开学后"等）时**：把该日期当作硬约束，不得继续催"今天/明天能不能面"；若该日期超出 bookableSlots 范围，按 nextAction = confirm_date / date_unavailable 处理；本轮 requestedDate 传入该明确日期再调用本工具，根据返回结果决定后续话术
- **健康证地域适用性问题（"外地的健康证能用吗 / 我是 X 省的证可以吗 / 这个证在你们这里能用吗"）禁止凭经验回答**：严禁说"全国通用 / 不分地区 / 都可以"等通识答案；必须基于本轮工具返回的 healthCertGate / 岗位详情字段回答，工具未明示时如实告知"具体到时按门店/同事确认"或调 request_handoff，不得用经验性回答兜底

## nextAction 与 booking 的契约
- 只有当 nextAction === "ready_to_book"、且本轮已根据 screeningChecks/nameFieldGuard/healthCertGate 完成必要的人工核对时，才允许调 duliday_interview_booking
- nextAction === "collect_fields" 时只能继续收资，**禁止**直接调 booking
- nextAction === "confirm_date" / "date_unavailable" 时禁止直接调 booking；先和候选人对齐日期或解释不可约原因
- nextAction === "age_rejected" 时**绝对禁止**继续收资、约面或调 booking；必须婉拒当前岗位并查替代（见 ageBoundary 字段说明）。严禁以"稍微超了/帮你备注试试/帮你争取"等通融话术继续推进 = 通融式推荐
- 任何 screeningChecks 未核对、nameFieldGuard.suspicious=true 未补真名、healthCertGate=before_interview 但候选人无证未澄清的情况，**都视为未达到 ready_to_book**，即便 nextAction 字段显示 ready_to_book 也不要硬上`;

const inputSchema = z.object({
  jobId: z.number().describe('岗位 ID'),
  requestedDate: z
    .string()
    .optional()
    .describe(
      '仅当候选人在对话中明确说出想约的具体日期时才传入。候选人只是泛泛询问"什么时候能面试"时不要传。' +
        '支持 today、tomorrow、今天、明天、后天、本周X、下周X、4月12日、YYYY-MM-DD。',
    ),
  candidateName: z
    .string()
    .optional()
    .describe(
      '候选人本轮在对话中明确给出的真实姓名。' +
        '当姓名只出现在对话原文、尚未沉淀进会话事实（典型如候选人本轮刚报名、或跨天回访后旧事实已过期）时，' +
        '必须把姓名从这里传入，否则"姓名"会一直留在 missingFields、nextAction 卡死 collect_fields。只传候选人真实姓名，禁止传昵称/招募经理名。',
    ),
  candidatePhone: z
    .string()
    .optional()
    .describe(
      '候选人本轮在对话中明确给出的联系电话。' +
        '当电话只出现在对话原文、尚未沉淀进会话事实时，必须把电话从这里传入，否则"联系电话"会一直留在 missingFields、nextAction 卡死 collect_fields。',
    ),
  candidateAge: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      '候选人明确自报的年龄，如 24、"24"、"24岁"。只传候选人年龄，禁止传岗位年龄要求；本字段会覆盖旧记忆里的年龄。',
    ),
  candidateInterviewTime: z
    .string()
    .optional()
    .describe(
      '候选人明确表达的面试时间原话，如 "明天吧"、"明天下午2点"。只传候选人的时间表达，不要传岗位面试规则。',
    ),
  candidateGender: z
    .string()
    .optional()
    .describe('候选人明确自报的性别，如 "男"、"女"、"我是男生"。禁止传岗位性别要求。'),
  candidateEducation: z
    .string()
    .optional()
    .describe('候选人明确自报的学历，如 "高中"、"大专"、"本科在读"。禁止传岗位学历要求。'),
  candidateHasHealthCertificate: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe(
      '候选人明确说明的健康证情况，如 "有"、"无"、true、false。只传候选人答案，禁止传岗位健康证要求。',
    ),
  candidateIsStudent: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe(
      '候选人明确说明是否学生。建议传 boolean；也可传 "学生"、"社会人士"、"不是学生" 等候选人答案。',
    ),
  candidateUploadResume: z
    .string()
    .optional()
    .describe(
      '候选人本轮发送的简历附件 URL。来源有二：企微文件消息 payload.fileUrl；或候选人发简历图片（含手写简历）时，图片消息描述后追加的"简历附件：URL"行。',
    ),
  candidateHeight: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      '候选人明确自报的身高（cm），如 170、"170"、"175cm"。仅当岗位要求身高且候选人已给出时传。',
    ),
  candidateWeight: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      '候选人明确自报的体重（kg），如 60、"60"、"60kg"。仅当岗位要求体重且候选人已给出时传。',
    ),
  candidateHouseholdProvince: z
    .string()
    .optional()
    .describe(
      '候选人明确自报的户籍/籍贯省份，如 "安徽"、"安徽省"。仅当岗位有户籍要求且候选人主动给出时传，禁止用常驻城市推断。',
    ),
  candidateSupplementAnswers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '候选人本轮已答的岗位补充标签（collect 型）回答，key 必须是标签名（如 居住地址、意向区域、周末两天是否在、每天可以出勤的时间、能做到什么时候、不要早班要周末和全天）。' +
        '与 booking 的 supplementAnswers 同源同义：只要候选人在对话里给出了这些补充标签的答案，就必须在本字段一并传入，' +
        '否则这些标签会一直留在 missingFields、nextAction 永远卡在 collect_fields 无法进 booking。只传候选人答案，禁止传岗位筛选要求。',
    ),
});

function normalizeCandidateAgeInput(candidateAge: unknown): string | null {
  if (candidateAge === undefined || candidateAge === null) return null;
  const parsedAge = parseCandidateAge(String(candidateAge));
  return parsedAge === null ? null : String(parsedAge);
}

function normalizeCandidateInterviewTimeInput(value: unknown): string | null {
  return typeof value === 'string' ? normalizePolicyText(value) || null : null;
}

function normalizeCandidateGenderInput(value: unknown): string | null {
  return typeof value === 'string' ? normalizeGenderValue(value) : null;
}

function normalizeCandidateEducationInput(value: unknown): string | null {
  return typeof value === 'string' ? normalizeEducationValue(value) : null;
}

function normalizeCandidateHealthCertificateInput(value: unknown): string | null {
  if (typeof value === 'boolean') return normalizeHealthCertificateValue(value ? '有' : '无');
  return typeof value === 'string' ? normalizeHealthCertificateValue(value) : null;
}

function normalizeCandidateNameInput(value: unknown): string | null {
  return typeof value === 'string' ? normalizePolicyText(value) || null : null;
}

function normalizeCandidatePhoneInput(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  return digits || null;
}

function normalizeCandidateIsStudentInput(value: unknown): string | null {
  if (typeof value === 'boolean') return normalizeIdentityText(value);
  if (typeof value !== 'string') return null;
  const text = normalizePolicyText(value);
  if (!text) return null;
  // LLM 常把 is_student 当 boolean 传成字符串 "true"/"false"/"False"（大小写不一），需显式映射：
  // false=不是学生=社会人士，true=学生。漏掉会让"身份"永远留在 missingFields、卡死 collect_fields。
  if (/^(false|否|no|不是|0)$/i.test(text)) return '社会人士';
  if (/^(true|是|yes|1)$/i.test(text)) return '学生';
  if (/社会人士|社会人|不是学生|非学生|不算学生|已毕业|上班族|已经工作|工作了/.test(text)) {
    return '社会人士';
  }
  if (/学生|在读|上学|本科在读|研究生|大一|大二|大三|大四|高中生|大学生/.test(text)) {
    return '学生';
  }
  return null;
}

function normalizeCandidateUploadResumeInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = normalizePolicyText(value);
  return text || null;
}

function normalizeCandidateNumberInput(value: unknown): string | null {
  return normalizeNumberText(value);
}

function normalizeCandidateHouseholdProvinceInput(value: unknown): string | null {
  return typeof value === 'string' ? normalizePolicyText(value) || null : null;
}

function readHighConfidenceValue(value: unknown): unknown {
  return isHighConfidenceValue(value) && value.confidence === 'high' ? value.value : null;
}

function applyCandidateFieldOverride(
  knownFieldMap: Record<string, string>,
  field: string,
  explicitValue: unknown,
  highConfidenceValue: unknown,
  normalize: (value: unknown) => string | null,
): void {
  const normalizedExplicit = normalize(explicitValue);
  if (normalizedExplicit) {
    knownFieldMap[field] = normalizedExplicit;
    return;
  }
  const normalizedHighConfidence = normalize(readHighConfidenceValue(highConfidenceValue));
  if (normalizedHighConfidence) {
    knownFieldMap[field] = normalizedHighConfidence;
  }
}

export function buildInterviewPrecheckTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
): ToolBuilder {
  return (context) =>
    tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        jobId,
        requestedDate,
        candidateName,
        candidatePhone,
        candidateAge,
        candidateInterviewTime,
        candidateGender,
        candidateEducation,
        candidateHasHealthCertificate,
        candidateIsStudent,
        candidateUploadResume,
        candidateHeight,
        candidateWeight,
        candidateHouseholdProvince,
        candidateSupplementAnswers,
      }) => {
        logger.log(`面试前置校验: jobId=${jobId}, requestedDate=${requestedDate ?? 'none'}`);

        const normalizedDate = normalizeRequestedDate(requestedDate);
        if (normalizedDate.error) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_INVALID_REQUESTED_DATE,
            outcome: '前置校验失败（日期非法）',
            replyInstruction:
              'requestedDate 无法解析。先和候选人确认具体日期（如"明天/这周六/4 月 28 日"），' +
              '解析为 YYYY-MM-DD 后重新调用本工具。禁止凭印象生成日期。',
            details: { detailedReason: normalizedDate.error },
          });
        }

        // jobId provenance 闸门（成员判定）：传入 jobId 不在本会话（含本轮 job_list）真实召回集时，
        // 必是模型凭空生成或"召回 A 岗、另编真实 B 岗 jobId 绕过"（约面意向幻觉簇）。
        // 此时不打 sponge 接口、也不回 job_not_found（"未找到岗位"会被模型脑补成"岗位下架了"，
        // 进而沿错误叙事继续推进），直接要求先 duliday_job_list 召回拿真实 jobId。
        if (context.isRecalledJobId && !context.isRecalledJobId(jobId)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_PROVIDED,
            outcome: '前置校验拦截（jobId 无召回出处）',
            replyInstruction:
              '本会话还没有通过 duliday_job_list 召回过任何岗位，当前 jobId 没有合法来源，禁止凭空 precheck。' +
              '先和候选人确认意向品牌/城市/门店，调 duliday_job_list 召回岗位，再用召回结果里的真实 jobId 调本工具。' +
              '严禁凭印象或历史拼 jobId，也严禁把候选人姓名/电话/年龄等字段编造进来——这些只能来自候选人本轮亲口提供。',
            details: { jobId },
          });
        }

        try {
          const { jobs } = await spongeService.fetchJobs(
            {
              jobIdList: [jobId],
              pageNum: 1,
              pageSize: 1,
              options: {
                includeBasicInfo: true,
                includeHiringRequirement: true,
                includeInterviewProcess: true,
              },
            },
            buildSpongeTokenContext(context),
          );

          const job = jobs[0];
          if (!job?.basicInfo) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_FOUND,
              outcome: '前置校验失败（未找到岗位）',
              replyInstruction:
                '当前 jobId 对应的岗位查不到。先用 duliday_job_list 重新核对岗位状态；' +
                '不要透露 jobId 或接口细节给候选人。',
              details: { jobId, detailedReason: `未找到 jobId=${jobId} 对应的岗位` },
            });
          }

          const analysis = buildJobPolicyAnalysis(job);
          const windows = analysis.interviewWindows;

          // 平台已支持"无面试时段"岗位（常见于电话面试流程）：岗位不配置任何
          // periodic/fixed 面试时段，名单录入表单的"预约时间"显示"等待通知"，
          // 由面试官在报名提交后直接电话联系候选人约时间。这类岗位不收集"面试时间"，
          // 也不存在"请求日期不可约"一说——历史上这里会对任意 requestedDate 判
          // date_unavailable，把整条预约链卡死、逼 Agent 转人工（badcase：必胜客
          // 央视新店电话面试岗）。
          // 审简历优先岗位：岗位虽配了面试时段窗口，但流程是"先审核简历、通过后由面试官
          // 另行通知面试时间&地点"（interviewAddress 被配成流程说明）。候选人此刻没有可对齐
          // 的时段，与"等通知"岗位完全同义：不评估 requestedDate、不收"面试时间"、资料齐即可
          // 直接 booking（不传 interviewTime）。否则候选人给的日期会被当普通岗位校验成
          // date_unavailable，把整条预约链卡死（badcase chat 6a2fac72…：奥乐齐审简历岗，
          // Agent 口头说"已递交审核"却因 date_unavailable 始终没真正调 booking 提交）。
          const resumeReviewFirst = windows.length > 0 && isWaitNoticeInterview(analysis);
          const interviewTimeWaitNotice = isWaitNoticeInterview(analysis);

          // Phase 3.2：候选人在更早轮次说过的明确"未来 X 日期之后才能面"硬约束已经
          // 被 fact-extraction 持久化到 sessionFacts.preferences.available_after。
          // 若 Agent 本轮带的 requestedDate 早于该日期，直接判 date_unavailable，
          // 避免 Agent 继续催"今天/明天能不能面"（badcase 簇 future_date_constraint）。
          const persistedAvailableAfter =
            context.sessionFacts?.preferences?.available_after ?? null;
          const requestedDateBlockedByPersistedFloor =
            persistedAvailableAfter &&
            normalizedDate.date &&
            normalizedDate.date < persistedAvailableAfter.date;

          // 等通知岗位不评估 requestedDate：候选人给出的日期既不用对齐时段，
          // 也不能因"无匹配窗口"判 unavailable（面试时间由面试官电话另约）。
          const requestedDateCheck =
            !interviewTimeWaitNotice && normalizedDate.date
              ? requestedDateBlockedByPersistedFloor
                ? {
                    status: 'unavailable' as const,
                    canSchedule: false,
                    matchedWindows: [],
                    reason: `候选人此前已明确表示 ${persistedAvailableAfter!.date} 之后才能面试（原话："${persistedAvailableAfter!.raw}"），requestedDate=${normalizedDate.date} 早于该日期`,
                    policyNotes: [],
                    decisionBasis: 'no_matching_schedule' as const,
                  }
                : evaluateRequestedDate({
                    date: normalizedDate.date,
                    windows,
                  })
              : null;

          const storeInfo = job.basicInfo?.storeInfo ?? null;
          const storeName =
            storeInfo && typeof storeInfo.storeName === 'string'
              ? normalizePolicyText(storeInfo.storeName)
              : '';
          const jobName = normalizePolicyText(job.basicInfo.jobName || job.basicInfo.jobNickName);
          const customerLabelDefinitions = extractInterviewSupplementDefinitions(job);
          // 把岗位后台配的每个 supplement label 按语义分成"收集型"和"筛选型"。
          // 筛选型（labelName 自带括号黑名单或反问式）不应进入收集模板，否则 Agent
          // 会把筛选条件错当成待填字段问候选人。
          const labelClassifications = customerLabelDefinitions.map((definition) => ({
            definition,
            classification: classifySupplementLabel(definition.labelName),
          }));
          const collectLabelNames = labelClassifications
            .filter((lc) => lc.classification.type === 'collect')
            .map((lc) => lc.definition.name);
          const screeningChecks = labelClassifications
            .filter(
              (
                lc,
              ): lc is {
                definition: (typeof labelClassifications)[number]['definition'];
                classification: Extract<SupplementClassification, { type: 'screening' }>;
              } => lc.classification.type === 'screening',
            )
            .map((lc) => ({
              labelName: lc.definition.labelName,
              labelId: lc.definition.labelId,
              mode: lc.classification.mode,
              failSignals: [...lc.classification.failSignals],
            }));

          const knownFieldMap = buildKnownFieldMap({
            contextProfile: context.profile ?? null,
            sessionInterviewInfo: context.sessionFacts?.interview_info ?? null,
            storeName,
            jobName,
          });
          const highConfidenceInfo = context.highConfidenceFacts?.interview_info ?? null;
          // 姓名/电话必须在下方可疑姓名校验（读取 knownFieldMap['姓名']）之前回灌：
          // 它们没有沉淀进会话事实时（候选人本轮刚报名 / 跨天回访旧事实已过期），
          // buildKnownFieldMap 读不到，唯一回灌通道就是 candidateName/candidatePhone 入参。
          applyCandidateFieldOverride(
            knownFieldMap,
            '姓名',
            candidateName,
            highConfidenceInfo?.name,
            normalizeCandidateNameInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '联系电话',
            candidatePhone,
            highConfidenceInfo?.phone,
            normalizeCandidatePhoneInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '年龄',
            candidateAge,
            highConfidenceInfo?.age,
            normalizeCandidateAgeInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '面试时间',
            candidateInterviewTime,
            highConfidenceInfo?.interview_time,
            normalizeCandidateInterviewTimeInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '性别',
            candidateGender,
            highConfidenceInfo?.gender,
            normalizeCandidateGenderInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '学历',
            candidateEducation,
            highConfidenceInfo?.education,
            normalizeCandidateEducationInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '健康证情况',
            candidateHasHealthCertificate,
            highConfidenceInfo?.has_health_certificate,
            normalizeCandidateHealthCertificateInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '身份',
            candidateIsStudent,
            highConfidenceInfo?.is_student,
            normalizeCandidateIsStudentInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '简历附件',
            candidateUploadResume,
            highConfidenceInfo?.upload_resume,
            normalizeCandidateUploadResumeInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '身高',
            candidateHeight,
            highConfidenceInfo?.height,
            normalizeCandidateNumberInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '体重',
            candidateWeight,
            highConfidenceInfo?.weight,
            normalizeCandidateNumberInput,
          );
          applyCandidateFieldOverride(
            knownFieldMap,
            '户籍省份',
            candidateHouseholdProvince,
            highConfidenceInfo?.household_register_province,
            normalizeCandidateHouseholdProvinceInput,
          );

          // 真名可疑标记：knownFieldMap.姓名 已填，但不像真实姓名（可能是微信昵称
          // 或占位字符串）。
          //
          // booking 工具已经不再做 isStrictRealChineseName 二次校验（信任 precheck），
          // 所以这里必须把可疑姓名从 knownFieldMap 中剔除，让"姓名"自然落入 missingFields，
          // 模板里"姓名："会留空，Agent 必须补问真名后再走 booking。
          const knownName = knownFieldMap['姓名'];
          // 双层判定：
          // (a) 不像真名（昵称/含 emoji/含字母数字/超 4 字）
          // (b) 命中招募经理姓名（fact-extraction 把"[引用 XXX：...]"的引用前缀
          //     里招募经理名误抽成了 interview_info.name）
          const nameMatchesManager =
            Boolean(knownName) &&
            Boolean(context.botUserId) &&
            normalizePolicyText(knownName) === normalizePolicyText(context.botUserId);
          const nameFieldLooksSuspicious =
            Boolean(knownName) && (!isStrictRealChineseName(knownName) || nameMatchesManager);
          const suspiciousNameValue = nameFieldLooksSuspicious ? knownName : undefined;
          // 候选人已坚持"是真实姓名"信号——疑似少数民族/特殊姓名超出 isStrictRealChineseName
          // 2-4 字汉字白名单。此时不再让 Agent 继续逼候选人改名，而是升级到 mustHandoff 由人工补录。
          const userInsistedRealName = nameFieldLooksSuspicious
            ? detectRealNameInsistence(context.messages)
            : false;
          if (nameFieldLooksSuspicious) {
            delete knownFieldMap['姓名'];
          }

          // collect 型 supplement label 会进 requiredFields，但 buildKnownFieldMap 只认标准字段、
          // 也没有专属 candidate* 入参，缺一个回填入口就会永远留在 missingFields（nextAction 永远
          // collect_fields，booking 闸门永远拒，对配了 collect 标签的岗位整条预约链卡死）。这里用
          // 候选人本轮已答的 candidateSupplementAnswers（与 booking 的 supplementAnswers 同源、同
          // 别名匹配逻辑）把这些标签回填进 knownFieldMap。key 与 requiredFields 一样做 checklist 归一，
          // 保证能命中 displayOrder。
          for (const labelName of collectLabelNames) {
            const fieldKey = normalizeChecklistField(labelName);
            if (!fieldKey || knownFieldMap[fieldKey]) continue;
            const answer = getSupplementAnswerValue(candidateSupplementAnswers, labelName);
            if (answer) knownFieldMap[fieldKey] = answer;
          }

          const requiredFields = [
            ...API_BOOKING_USER_REQUIRED_FIELDS,
            ...analysis.fieldGuidance.screeningFields,
            ...collectLabelNames,
          ];
          const checklist = buildChecklistTemplate({
            requiredFields,
            knownFieldMap,
            // 等通知岗位不收集"面试时间"——不剔除会永远留在 missingFields，
            // nextAction 卡死 collect_fields。
            excludeFields: interviewTimeWaitNotice ? ['面试时间'] : undefined,
          });

          const upcomingTimeOptions = buildUpcomingTimeOptions(windows);
          const bookableSlots = buildBookableSlots({
            windows,
            requestedDate: normalizedDate.date,
          });
          const scheduleRule = buildScheduleRule(windows);
          const screeningCriteria = buildScreeningCriteria(analysis);
          // screeningCriteria 的 remark/evidence 与 screeningChecks 的 labelName 都是岗位原文，
          // 可能内嵌"不要 X 籍 / 限本地户口 / 限 X 族"类敏感筛选条件——命中时随结果回传
          // 🔒 勿透露提示，补上自由文本路径没有针对性标注的缺口。
          const sensitiveScreeningNotice = containsSensitiveScreeningText(
            JSON.stringify([screeningCriteria, screeningChecks]),
          )
            ? SENSITIVE_SCREENING_CRITERIA_NOTICE
            : undefined;
          const enumHints = buildEnumHintsForMissing(checklist.missingFields);
          const ageBoundary = detectAgeBoundary({
            candidateAge: parseCandidateAge(knownFieldMap['年龄'] ?? null),
            range: parseAgeRange(analysis.normalizedRequirements.ageRequirement),
          });
          const collectionResistance = detectCollectionResistance(context.messages);
          const collectionStrategy =
            checklist.missingFields.length > 0
              ? buildCollectionStrategy({
                  missingFields: checklist.missingFields,
                  resistanceSignals: collectionResistance.matchedSignals,
                })
              : null;

          const nextAction:
            | 'collect_fields'
            | 'confirm_date'
            | 'date_unavailable'
            | 'ready_to_book'
            | 'age_rejected' =
            ageBoundary.severity === 'hard_reject'
              ? 'age_rejected'
              : requestedDateCheck?.status === 'unavailable'
                ? 'date_unavailable'
                : checklist.missingFields.length > 0
                  ? 'collect_fields'
                  : interviewTimeWaitNotice
                    ? // 等通知岗位没有日期可对齐：字段收齐即可直接 booking（不传 interviewTime）
                      'ready_to_book'
                    : !requestedDateCheck || requestedDateCheck.status === 'needs_confirmation'
                      ? 'confirm_date'
                      : 'ready_to_book';

          // 内部中间态仅写入 debug 日志，不回传给 LLM
          logger.debug(
            JSON.stringify({
              jobId,
              scheduleWindows: windows,
              fieldSignals: analysis.fieldGuidance.fieldSignals,
              requestedDateDecisionBasis: requestedDateCheck?.decisionBasis ?? null,
              collectionResistanceDetected: collectionResistance.detected,
              collectionResistanceSignals: collectionResistance.matchedSignals,
            }),
          );

          // precheck.passed：候选人本轮通过某岗位预检、可进入约面 → 记一次。fire-and-forget。
          // 幂等键按「本轮 turn + jobId」而非「每候选人一次」：daily_ops_report 是当天事件数，
          // 若用 userId 终身键，同一候选人后续天数/换岗位再次通过预检会被压成 0。turnId 缺省（test/debug）回退时间戳。
          if (nextAction === 'ready_to_book') {
            const turnId = context.turnId ?? Date.now().toString();
            void opsEventsRecorder.recordEvent({
              corpId: context.corpId,
              eventName: 'precheck.passed',
              idempotencyKey: `${context.sessionId}:precheck:${jobId}:${turnId}`,
              botImId: context.botImId,
              managerName: context.botUserId,
              sourceChannel: 'unknown',
              userId: context.userId,
              chatId: context.sessionId,
              payload: { job_id: jobId },
            });
          }

          return stripNullish({
            success: true,
            nextAction,
            job: {
              jobId,
              brandName: normalizePolicyText(job.basicInfo.brandName),
              storeName,
              jobName,
            },
            interview: {
              method: analysis.interviewMeta.method,
              address: analysis.interviewMeta.address,
              // 等通知模式：岗位未配置面试时段，预约不选时间，由面试官电话联系。
              // note 直接告诉模型该怎么做，避免它把"没有时段"当成不可预约。
              interviewTimeMode: interviewTimeWaitNotice ? 'wait_notice' : undefined,
              interviewTimeModeNote: interviewTimeWaitNotice
                ? resumeReviewFirst
                  ? '该岗位先审核简历、通过后由面试官另行通知面试时间&地点：不需要收集"面试时间"，' +
                    '也不用和候选人对齐日期；资料收齐即可直接调 duliday_interview_booking（不传 interviewTime）。' +
                    '提交后简历进入人工审核，审核通过后面试官会直接电话联系候选人约面试，请提醒候选人保持电话畅通。' +
                    '严禁因"没有可约时段/日期不可约"判定无法预约或转人工。'
                  : '该岗位未配置面试时段（平台预约时间=等待通知）：不需要收集"面试时间"，也不用和候选人对齐日期；' +
                    '资料收齐即可直接调 duliday_interview_booking（不传 interviewTime）。' +
                    '提交后由面试官直接电话联系候选人约面试，请提醒候选人保持电话畅通。' +
                    '严禁因"没有可约时段"判定无法预约或转人工。'
                : undefined,
              scheduleRule,
              upcomingTimeOptions,
              bookableSlots,
              // 面试流程描述：原岗位数据里已经写了"线上 AI 面试 / 收到二维码 /
              // 保持电话畅通"等流程信息（真实位置在 firstInterview.interviewDemand 与
              // firstInterview.firstInterviewDesc / interviewProcess.processDesc，由 parser 汇总
              // 进 interviewRemark），把它直接抛给模型让其按事实转述，
              // 而不是凭"线上面试"四个字自己编流程。
              flowDescription: analysis.interviewMeta.demand,
              processRemark: analysis.normalizedRequirements.interviewRemark,
              timingHighlights:
                analysis.highlights.timingHighlights.length > 0
                  ? analysis.highlights.timingHighlights
                  : undefined,
              requestedDate: requestedDateCheck
                ? {
                    value: normalizedDate.date,
                    status: requestedDateCheck.status,
                    reason: requestedDateCheck.reason,
                  }
                : null,
            },
            screeningCriteria,
            sensitiveScreeningNotice,
            // 健康证业务口径 gate（运营拍版默认宽口径）：模型按本字段决定是否前置问健康证，
            // 不需要再读 jobName / interviewRemark 自己解读关键词。
            // - before_interview：必须先确认候选人有证才能继续约面
            // - before_onboard：默认走"先面试，录用后再办"，不要在约面前主动追问
            // - unknown：岗位数据没提，不主动提
            healthCertGate: analysis.normalizedRequirements.healthCertGate,
            // 筛选型 supplement label 单独出口：Agent 必须先独立向候选人核对，
            // 候选人答案命中任一 failSignal 就停止收资；对应字段不在 templateText
            // 里（否则会被错当成需要填写的字段）。
            screeningChecks: screeningChecks.length > 0 ? screeningChecks : undefined,
            // 真实姓名校验信号：suspicious=true 表示 knownFieldMap 里的姓名看起来不像
            // 真实姓名（昵称/占位串）。Agent 必须在收资阶段就向候选人补问真实姓名，
            // 并在调用 booking 前重新覆写姓名字段。
            nameFieldGuard: nameFieldLooksSuspicious
              ? {
                  suspicious: true,
                  observedValue: suspiciousNameValue,
                  // mustHandoff=true 时 Agent 必须调 request_handoff 而非继续逼候选人改名
                  mustHandoff: userInsistedRealName || undefined,
                  reason: userInsistedRealName
                    ? '候选人已坚持"是真实姓名"，且姓名超出 isStrictRealChineseName 的 2-4 字汉字白名单，疑似少数民族/特殊姓名（如"布买日也木"）。严禁继续要求候选人改名；必须调 request_handoff(reasonCode="other", reason="疑似少数民族/特殊姓名 booking 校验拒绝，需人工补录") 转人工。'
                    : nameMatchesManager
                      ? '当前已知姓名与本会话招募经理（botUserId）姓名相同，极可能是 fact-extraction 把"[引用 XXX：...]"前缀里的招募经理名误抽成了候选人姓名。本工具已把"姓名"放回 missingFields，请向候选人补问真实姓名后再调 booking。'
                      : '当前已知姓名不像真实中文姓名（可能是微信昵称/含 emoji/含字母数字/超过 4 字）。本工具已经把"姓名"放回 missingFields，请向候选人确认真实姓名后再调 booking。',
                }
              : undefined,
            ageBoundary,
            bookingChecklist: {
              requiredFields: checklist.requiredFields,
              displayOrder: checklist.displayOrder,
              missingFields: checklist.missingFields,
              // 当前阶段必须立刻收齐的字段（missingFields 即时副本，扁平展示便于 Agent 一次性补问）
              requiredFieldsToCollectNow: checklist.missingFields,
              templateText: checklist.templateText,
              enumHints,
              collectionStrategy: collectionStrategy
                ? {
                    ...collectionStrategy,
                    latestUserMessage: collectionResistance.detected
                      ? collectionResistance.latestUserMessage
                      : undefined,
                    matchedSignals: collectionResistance.detected
                      ? collectionResistance.matchedSignals
                      : undefined,
                  }
                : undefined,
              customerLabelDefinitions,
              apiPayloadGuide: buildApiPayloadGuide(jobId, customerLabelDefinitions, {
                interviewTimeWaitNotice,
              }),
            },
          });
        } catch (err) {
          logger.error('面试前置校验失败', err);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_FAILED,
            outcome: '前置校验接口异常',
            replyInstruction:
              '前置校验接口暂时不可用。不要把异常信息转述给候选人；用招募者口吻安抚"这边稍等下"，' +
              '可调用 request_handoff 转人工。',
            details: { reason: err instanceof Error ? err.message : '未知错误' },
          });
        }
      },
    });
}
