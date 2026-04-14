import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import type {
  EntityExtractionResult,
  InterviewInfo,
  Preferences,
} from '@memory/types/session-facts.types';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 本轮线索段落
 *
 * 把本轮前置高置信识别结果拆成两部分：
 *  - 普通线索：当前轮新增、或与会话记忆不冲突的识别结果；
 *  - 待确认线索：与会话记忆已知信息存在冲突的识别结果。
 *
 * 普通线索可直接辅助 LLM 理解本轮意图；待确认线索提醒 LLM 需要澄清而非覆盖记忆。
 *
 * 原先这段 partition + 渲染逻辑散在 AgentPreparationService，本 section 将其收敛到 prompt 组装层。
 */
export class TurnHintsSection implements PromptSection {
  readonly name = 'turn-hints';

  build(ctx: PromptContext): string {
    const { normalHints, pendingHints } = this.partition(
      ctx.sessionFacts ?? null,
      ctx.highConfidenceFacts ?? null,
    );

    const parts: string[] = [];
    if (normalHints) parts.push(this.renderHighConfidence(normalHints));
    if (pendingHints) parts.push(this.renderPendingConfirmation(pendingHints));
    return parts.join('\n\n');
  }

  /** 把本轮前置高置信识别渲染成单独的 runtime hints。 */
  private renderHighConfidence(facts: EntityExtractionResult): string {
    const lines = formatExtractionFactLines(facts);
    if (lines.length === 0) return '';

    return [
      '[本轮高置信线索]',
      '',
      '以下内容由当前消息前置识别得到，仅用于理解本轮意图，不视为跨轮已确认的会话记忆。',
      '若与[用户档案]、[会话记忆]或候选人当前明示信息冲突，以候选人当前明示信息为准。',
      '若识别出地点线索，行政区域可直接查岗；但商圈、地标、街道、详细地址这类自由位置线索不能直接当区域。只要本轮准备做具体岗位或门店推荐，就应优先先 geocode 获取经纬度，“附近/离我近”只是最明显场景。',
      '',
      '## 当前消息识别结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** 把与会话记忆冲突的当前轮识别结果渲染成待确认线索。 */
  private renderPendingConfirmation(facts: EntityExtractionResult): string {
    const lines = formatExtractionFactLines(facts);
    if (lines.length === 0) return '';

    return [
      '[本轮待确认线索]',
      '',
      '以下内容由当前消息前置识别得到，但与[会话记忆]中的已知信息存在冲突。',
      '这些内容只用于帮助你判断是否需要澄清，不得直接覆盖已确认的会话记忆。',
      '若候选人本轮表达明确，可按当前表达继续；若表达仍有歧义，先做一次简短确认。',
      '',
      '## 当前消息待确认结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** 把当前轮高置信识别拆成“普通线索”和“待确认线索”。 */
  private partition(
    sessionFacts: EntityExtractionResult | null,
    highConfidenceFacts: EntityExtractionResult | null,
  ): {
    normalHints: EntityExtractionResult | null;
    pendingHints: EntityExtractionResult | null;
  } {
    if (!highConfidenceFacts) {
      return { normalHints: null, pendingHints: null };
    }

    if (!sessionFacts) {
      return { normalHints: highConfidenceFacts, pendingHints: null };
    }

    const normalHints = this.createEmptyExtractionResult();
    const pendingHints = this.createEmptyExtractionResult();

    this.partitionScalarField(
      sessionFacts.interview_info.name,
      highConfidenceFacts.interview_info.name,
      (value) => {
        normalHints.interview_info.name = value;
      },
      (value) => {
        pendingHints.interview_info.name = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.phone,
      highConfidenceFacts.interview_info.phone,
      (value) => {
        normalHints.interview_info.phone = value;
      },
      (value) => {
        pendingHints.interview_info.phone = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.gender,
      highConfidenceFacts.interview_info.gender,
      (value) => {
        normalHints.interview_info.gender = value;
      },
      (value) => {
        pendingHints.interview_info.gender = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.age,
      highConfidenceFacts.interview_info.age,
      (value) => {
        normalHints.interview_info.age = value;
      },
      (value) => {
        pendingHints.interview_info.age = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.applied_store,
      highConfidenceFacts.interview_info.applied_store,
      (value) => {
        normalHints.interview_info.applied_store = value;
      },
      (value) => {
        pendingHints.interview_info.applied_store = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.applied_position,
      highConfidenceFacts.interview_info.applied_position,
      (value) => {
        normalHints.interview_info.applied_position = value;
      },
      (value) => {
        pendingHints.interview_info.applied_position = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.interview_time,
      highConfidenceFacts.interview_info.interview_time,
      (value) => {
        normalHints.interview_info.interview_time = value;
      },
      (value) => {
        pendingHints.interview_info.interview_time = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.is_student,
      highConfidenceFacts.interview_info.is_student,
      (value) => {
        normalHints.interview_info.is_student = value;
      },
      (value) => {
        pendingHints.interview_info.is_student = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.education,
      highConfidenceFacts.interview_info.education,
      (value) => {
        normalHints.interview_info.education = value;
      },
      (value) => {
        pendingHints.interview_info.education = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.has_health_certificate,
      highConfidenceFacts.interview_info.has_health_certificate,
      (value) => {
        normalHints.interview_info.has_health_certificate = value;
      },
      (value) => {
        pendingHints.interview_info.has_health_certificate = value;
      },
    );

    this.partitionArrayField(
      sessionFacts.preferences.brands,
      highConfidenceFacts.preferences.brands,
      (value) => {
        normalHints.preferences.brands = value;
      },
      (value) => {
        pendingHints.preferences.brands = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.salary,
      highConfidenceFacts.preferences.salary,
      (value) => {
        normalHints.preferences.salary = value;
      },
      (value) => {
        pendingHints.preferences.salary = value;
      },
    );
    this.partitionArrayField(
      sessionFacts.preferences.position,
      highConfidenceFacts.preferences.position,
      (value) => {
        normalHints.preferences.position = value;
      },
      (value) => {
        pendingHints.preferences.position = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.schedule,
      highConfidenceFacts.preferences.schedule,
      (value) => {
        normalHints.preferences.schedule = value;
      },
      (value) => {
        pendingHints.preferences.schedule = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.city,
      highConfidenceFacts.preferences.city,
      (value) => {
        normalHints.preferences.city = value;
      },
      (value) => {
        pendingHints.preferences.city = value;
      },
    );
    this.partitionArrayField(
      sessionFacts.preferences.district,
      highConfidenceFacts.preferences.district,
      (value) => {
        normalHints.preferences.district = value;
      },
      (value) => {
        pendingHints.preferences.district = value;
      },
    );
    this.partitionArrayField(
      sessionFacts.preferences.location,
      highConfidenceFacts.preferences.location,
      (value) => {
        normalHints.preferences.location = value;
      },
      (value) => {
        pendingHints.preferences.location = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.labor_form,
      highConfidenceFacts.preferences.labor_form,
      (value) => {
        normalHints.preferences.labor_form = value;
      },
      (value) => {
        pendingHints.preferences.labor_form = value;
      },
    );

    return {
      normalHints: this.hasAnyFactLines(normalHints) ? normalHints : null,
      pendingHints: this.hasAnyFactLines(pendingHints) ? pendingHints : null,
    };
  }

  private partitionScalarField<T extends string | boolean | null>(
    previousValue: T,
    currentValue: T,
    onNormal: (value: Exclude<T, null>) => void,
    onPending: (value: Exclude<T, null>) => void,
  ): void {
    if (!this.hasScalarValue(currentValue)) return;
    if (!this.hasScalarValue(previousValue)) {
      onNormal(currentValue as Exclude<T, null>);
      return;
    }
    if (this.isSameScalarValue(previousValue, currentValue)) return;
    onPending(currentValue as Exclude<T, null>);
  }

  private partitionArrayField(
    previousValue: string[] | null,
    currentValue: string[] | null,
    onNormal: (value: string[]) => void,
    onPending: (value: string[]) => void,
  ): void {
    const normalizedCurrent = this.normalizeStringArray(currentValue);
    if (normalizedCurrent.length === 0) return;

    const normalizedPrevious = this.normalizeStringArray(previousValue);
    if (normalizedPrevious.length === 0) {
      onNormal(normalizedCurrent);
      return;
    }
    if (this.isSameStringArray(normalizedPrevious, normalizedCurrent)) return;
    onPending(normalizedCurrent);
  }

  private hasScalarValue(value: string | boolean | null): boolean {
    if (typeof value === 'boolean') return true;
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isSameScalarValue(
    previousValue: string | boolean | null,
    currentValue: string | boolean | null,
  ): boolean {
    if (typeof previousValue === 'boolean' || typeof currentValue === 'boolean') {
      return previousValue === currentValue;
    }
    return String(previousValue).trim() === String(currentValue).trim();
  }

  private normalizeStringArray(values: string[] | null): string[] {
    if (!values?.length) return [];
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
  }

  private isSameStringArray(previousValue: string[], currentValue: string[]): boolean {
    if (previousValue.length !== currentValue.length) return false;
    return previousValue.every((value, index) => value === currentValue[index]);
  }

  private hasAnyFactLines(facts: EntityExtractionResult): boolean {
    return formatExtractionFactLines(facts).length > 0;
  }

  private createEmptyExtractionResult(): EntityExtractionResult {
    return {
      interview_info: this.createEmptyInterviewInfo(),
      preferences: this.createEmptyPreferences(),
      reasoning: '',
    };
  }

  private createEmptyInterviewInfo(): InterviewInfo {
    return {
      name: null,
      phone: null,
      gender: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    };
  }

  private createEmptyPreferences(): Preferences {
    return {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
    };
  }
}
