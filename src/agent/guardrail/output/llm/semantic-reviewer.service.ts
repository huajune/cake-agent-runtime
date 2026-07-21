import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ModelRole } from '@/llm/llm.types';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import type { GuardrailReviewPacket } from './review-packet.types';

export const SEMANTIC_REVIEW_FINDING_CODES = [
  'job_recommendation_not_best_supported',
  'brand_or_geo_ambiguity_ignored',
  'active_booking_state_conflict',
] as const;

export type SemanticReviewFindingCode = (typeof SEMANTIC_REVIEW_FINDING_CODES)[number];

/** 每个语义 finding 自带恢复能力声明，与 code 定义同处维护。 */
export const SEMANTIC_REVIEW_FINDING_POLICIES = {
  job_recommendation_not_best_supported: {
    repairToolNames: ['geocode', 'duliday_job_list'],
  },
  brand_or_geo_ambiguity_ignored: {
    repairToolNames: ['geocode', 'duliday_job_list'],
  },
  active_booking_state_conflict: {
    repairToolNames: ['send_store_location', 'request_handoff'],
  },
} as const satisfies Record<SemanticReviewFindingCode, { repairToolNames: readonly string[] }>;

const semanticReviewSchema = z.object({
  decision: z.enum(['pass', 'observe', 'revise', 'replan', 'block']),
  confidence: z.enum(['low', 'medium', 'high']),
  findings: z
    .array(
      z.object({
        code: z.enum(SEMANTIC_REVIEW_FINDING_CODES),
        evidencePath: z.string(),
        evidenceQuote: z.string(),
        userImpact: z.string(),
        repairMode: z.enum(['rewrite', 'replan']),
        feedbackToGenerator: z.string(),
      }),
    )
    .default([]),
});

export type SemanticReviewVerdict = z.infer<typeof semanticReviewSchema>;

// —— 截断检测 ————————————————————————————————————————————————
// 生产档案（2026-07-21 复盘）：约 27% 的 finding 文本在英文双引号处被截断——模型在
// JSON 字符串里输出未转义的 `"`，约束解码把它当字符串终结符，引号后的内容被语法
// 强制吞掉，产物是"结构合法但内容断在半句"的 finding（如 userImpact 只剩
// 「…但回复推荐的岗位品牌名为」）。schema 校验对此无感，必须按悬垂结尾识别。
// 悬垂词集刻意收窄到"不可能作为完整句子结尾"的及物成分，避免把正常句子误判成
// 截断触发无谓重试。
const TRUNCATED_TEXT_RE =
  /(?:提到|写着|名为|称为|改为|误将|显示为|标注为|将|把|被|向|与|或|但|且|因为|由于|即|为|是)$/u;

function isLikelyTruncatedText(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && TRUNCATED_TEXT_RE.test(text);
}

/** 判定裁决中是否存在疑似被约束解码截断的 finding 文本（导出仅供单测）。 */
export function hasTruncatedFindingText(verdict: SemanticReviewVerdict): boolean {
  return verdict.findings.some((finding) =>
    [finding.evidenceQuote, finding.userImpact, finding.feedbackToGenerator].some((text) =>
      isLikelyTruncatedText(text),
    ),
  );
}

@Injectable()
export class SemanticReviewerService {
  constructor(private readonly llm: LlmExecutorService) {}

  shouldReview(packet: GuardrailReviewPacket): boolean {
    const reply = packet.draftReply;
    const jobList = packet.evidence.jobList;
    const hasJobRecommendation =
      Boolean(jobList?.jobs.length || jobList?.markdownExcerpt) &&
      /推荐|这家|这个岗位|门店|距离|班次|薪资|地址|报名|预约/.test(reply);
    const hasGeoOrBrandAmbiguity =
      Boolean(packet.evidence.geocode) && /附近|地址|位置|门店|距离|城市|区|路/.test(reply);
    const hasBookingStateClaim =
      Boolean(packet.evidence.booking) && /预约|报名|面试|到店|二维码|地址|时间/.test(reply);
    const hasSentLocationClaim =
      Boolean(packet.evidence.sentLocation) && /地址|位置|定位|导航|面试|门店/.test(reply);
    return (
      hasJobRecommendation || hasGeoOrBrandAmbiguity || hasBookingStateClaim || hasSentLocationClaim
    );
  }

  async review(packet: GuardrailReviewPacket): Promise<SemanticReviewVerdict> {
    const result = await this.llm.generateStructured({
      role: ModelRole.Review,
      schema: semanticReviewSchema,
      outputName: 'SemanticOutputGuardrailReview',
      messages: [
        {
          role: 'system',
          content: [
            '你是招聘对话的语义出站守卫，负责最终确认候选人可见回复是否忠实、可发送。',
            '只基于输入里的 evidence packet 判断，不要凭常识补事实。',
            'jobList.markdownExcerpt 是岗位工具返回的 markdown 原文摘录（结构化 jobs 为空时它就是岗位事实的 ground truth，其中"品牌（门店）"格式里括号前是品牌名、括号内是门店名，不要把品牌名误读为城市）。',
            '只检查三类问题：',
            '1. job_recommendation_not_best_supported：岗位推荐与 jobList 证据、距离排序、候选人指定品牌或班次明显冲突。',
            '2. brand_or_geo_ambiguity_ignored：地理或品牌证据不确定，但回复直接下结论。',
            '3. active_booking_state_conflict：booking 证据显示已约/失败/线上线下/面试时间地址等状态，但回复与其冲突或漏关键状态。',
            '证据读取要求：',
            '- jobList.hasEvidence=true 表示已有可核验岗位证据；即使 jobList.jobs=[]，只要 markdownExcerpt 存在也不能说“无岗位数据/无证据支撑”。',
            '- geocode.hasResolvedCoordinate=true 表示已解析到坐标；unique 解析常见 candidates=[]，不能仅因 candidates 为空就说地理解析失败。',
            '- geocode.areaLevelQuery=true 表示只解析到行政区级，不能支撑精确门店距离，但不等于 geocode 失败。',
            '- sentLocation.addressConflict=true 表示面试地址与工作门店不同。仅当 destination=interview 时，回复必须说清两者差异，且不得把 storeAddress 当成面试目的地；destination=store 表示候选人明确询问工作地点，不要求额外展开面试地址，但不得把工作门店说成面试地点。',
            '- sentLocation.destination=interview 时，回复必须称其为面试定位；不得说已发门店定位或声称应去工作门店面试。',
            '- 只有 sentLocation.interviewMethod 明确为线下/到店/现场面试时才允许声称有面试地址或已发面试定位。线上/AI/视频/电话面试或 locationNotRequired=true 时，任何到店、面试地址或面试定位声称都是 active_booking_state_conflict。',
            '- “地图未更新/新店刚入驻/地址没错”等解释必须在 evidence 中有明确依据；否则按 active_booking_state_conflict 要求删除。',
            '裁决要求：',
            '- 每条 finding 必须给出 evidencePath（指向 packet 中的证据字段）和 evidenceQuote（回复原文）。',
            '- 所有字符串字段内禁止使用英文双引号(")；需要引用原文或品牌名时用中文引号「」，否则内容会在引号处被截断丢失。',
            '- feedbackToGenerator 写成可直接执行的改写指令，只描述候选人可见回复该怎么改。',
            '- 如果证据不足，只能 pass 或 observe，不要 revise/replan/block；把握不高时 confidence 填 low。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(packet),
        },
      ],
      // 截断的 finding 文本没有取证价值还会污染 shadow 样本池：按生成失败处理，
      // 复用重试/降级策略换一次采样（prompt 已禁英文双引号，重采大概率恢复）。
      validateOutput: (output) => {
        if (hasTruncatedFindingText(output as SemanticReviewVerdict)) {
          throw new Error('semantic review finding text likely truncated at unescaped quote');
        }
      },
    });

    return this.applyEvidenceBackstop(result.output as SemanticReviewVerdict, packet);
  }

  /**
   * LLM reviewer 不能自证 evidence 缺失：
   * 若 finding 的理由明确建立在“jobs/geocode 空”上，但 packet 明字段证明证据存在，
   * 则丢弃该 finding，避免 shadow 样本池被系统性假阳污染。
   */
  private applyEvidenceBackstop(
    verdict: SemanticReviewVerdict,
    packet: GuardrailReviewPacket,
  ): SemanticReviewVerdict {
    const findings = verdict.findings.filter(
      (finding) => !this.isContradictedByPacket(finding, packet),
    );
    if (findings.length === verdict.findings.length) return verdict;
    if (findings.length === 0) {
      return { ...verdict, decision: 'pass', confidence: 'low', findings };
    }
    return { ...verdict, decision: this.normalizeDecision(verdict.decision, findings), findings };
  }

  private isContradictedByPacket(
    finding: SemanticReviewVerdict['findings'][number],
    packet: GuardrailReviewPacket,
  ): boolean {
    const text = [
      finding.evidencePath,
      finding.evidenceQuote,
      finding.userImpact,
      finding.feedbackToGenerator,
    ].join('\n');

    if (finding.code === 'job_recommendation_not_best_supported') {
      return this.claimsMissingJobEvidence(text) && packet.evidence.jobList?.hasEvidence === true;
    }
    if (finding.code === 'brand_or_geo_ambiguity_ignored') {
      return (
        this.claimsGeocodeUnavailable(text) &&
        packet.evidence.geocode?.hasResolvedCoordinate === true
      );
    }
    return false;
  }

  private claimsMissingJobEvidence(text: string): boolean {
    return /jobList\.jobs\s*为空|jobs\s*为空|岗位数据\s*(?:为空|缺失)|无(?:任何)?岗位数据|无(?:任何)?数据支撑|没有(?:任何)?岗位数据|jobList\s*返回(?:结果)?为空/.test(
      text,
    );
  }

  private claimsGeocodeUnavailable(text: string): boolean {
    return /geocode\.candidates\s*为空|candidates\s*为空|地理解析(?:无结果|失败|未成功|无有效)|未能解析|无法解析|无(?:有效)?坐标|位置未能解析/.test(
      text,
    );
  }

  private normalizeDecision(
    decision: SemanticReviewVerdict['decision'],
    findings: SemanticReviewVerdict['findings'],
  ): SemanticReviewVerdict['decision'] {
    const allowed = new Set(findings.map((finding) => finding.repairMode));
    if ((decision === 'replan' || decision === 'block') && !allowed.has('replan')) return 'revise';
    return decision;
  }
}
