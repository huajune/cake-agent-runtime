/**
 * 收资表单的持久化编排：loadOrCreate / persist / phone 到达 rebind。
 *
 * 职责边界：本服务**不重做任何字段判定**——改表只经 `@resolution/collection` 的写路径
 * 纯函数（CLAUDE.md：memory 只持有事实，不实现字段判断）。这里只编排从哪读、写到哪、
 * 人键变了怎么搬家，以及已落定交集字段如何回流 sessionFacts。
 */

import { Injectable, Logger } from '@nestjs/common';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { sessionFactValue, type SessionInterviewInfo } from '@memory/short-term/short-term.types';
import {
  contractFieldsEqual,
  createForm,
  migrateAskTracking,
  reconcileAskLimitEscalation,
  reconcileExplicitCandidateRouting,
  SESSION_CANDIDATE_REF,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import type { CandidateFieldKey } from '@resolution/candidate/types';
import type { CandidateFactField } from '@resolution/candidate/types';
import { CollectionFormStore } from './collection-form.store';
import { findFieldForCandidateFact } from './proposal-intake';

export interface CollectionFormScope {
  corpId: string;
  userId: string;
  /** 当前托管账号的稳定企微身份（wecomUserId）；收资单据隔离维度。 */
  botUserId: string;
  jobId: number;
}

export interface CollectionFormLoadOptions {
  /**
   * 上层已确认本次是代他人报名时显式标记。此时即使主候选人的手机号仍未知，
   * 也绝不能复用 session 默认表单；否则追加候选人的资料会污染当前联系人。
   */
  candidateScope?: 'additional';
}

type ProgressCandidateField = Exclude<CandidateFieldKey, 'supplementAnswers'>;
type ProgressInterviewField = Extract<
  keyof SessionInterviewInfo,
  | 'name'
  | 'phone'
  | 'age'
  | 'gender'
  | 'education'
  | 'has_health_certificate'
  | 'household_register_province'
  | 'height'
  | 'weight'
>;

/** CandidateFieldKey 与 interview_info 的语义交集；新增候选字段时必须显式裁定去向。 */
const COLLECTION_PROGRESS_FACT_MAPPING = {
  name: { factField: 'name', interviewField: 'name' },
  phone: { factField: 'phone', interviewField: 'phone' },
  age: { factField: 'age', interviewField: 'age' },
  gender: { factField: 'gender', interviewField: 'gender' },
  education: { factField: 'education', interviewField: 'education' },
  healthCert: {
    factField: 'healthCertificate',
    interviewField: 'has_health_certificate',
  },
  householdProvince: {
    factField: 'householdProvince',
    interviewField: 'household_register_province',
  },
  height: { factField: 'height', interviewField: 'height' },
  weight: { factField: 'weight', interviewField: 'weight' },
} as const satisfies Record<
  ProgressCandidateField,
  { factField: CandidateFactField; interviewField: ProgressInterviewField }
>;

@Injectable()
export class CollectionFormService {
  private readonly logger = new Logger(CollectionFormService.name);

  constructor(
    private readonly store: CollectionFormStore,
    private readonly sessionState: SessionStateService,
  ) {}

  /**
   * 取当前表单；没有就按契约开一张空表。
   *
   * 读取顺序是显式人键 → 当前指针 → 'session' 默认表。booking 不再接收手机号裸字段，
   * 因而必须能仅凭会话与岗位定位到 rebind 后的人键表。
   *
   * **契约漂移的处理**：读回来的表单可能是按旧契约开的（运营中途改了配置）。
   * 契约里新增的槽位补进来；已消失的槽位从办理态移除。否则 `verdictOf` 会被一个
   * 已不属于当前契约的 empty 槽位永久卡住，或把已删除标签误带进提交 payload。
   */
  async loadOrCreate(
    scope: CollectionFormScope,
    contract: readonly ContractFieldDef[],
    candidatePhone?: string | null,
    options?: CollectionFormLoadOptions,
  ): Promise<BookingCollectionForm> {
    const candidateRef = normalizeCandidateRef(candidatePhone);
    const currentRef = await this.store.readCurrentCandidateRef(scope);
    const explicitlyAdditional =
      options?.candidateScope === 'additional' && candidateRef !== SESSION_CANDIDATE_REF;

    let existing: BookingCollectionForm | null = null;
    if (candidateRef !== SESSION_CANDIDATE_REF) {
      existing = await this.store.read({ ...scope, candidateRef });
      if (
        !existing &&
        !explicitlyAdditional &&
        (!currentRef || currentRef === SESSION_CANDIDATE_REF)
      ) {
        // 第一个候选人往往先填姓名/年龄、后给手机号；此时延续 session
        // 默认表单，后续 rebind 到手机号，不丢已收资料。
        existing = await this.store.read({ ...scope, candidateRef: SESSION_CANDIDATE_REF });
      }
    } else {
      existing =
        (currentRef ? await this.store.read({ ...scope, candidateRef: currentRef }) : null) ??
        (await this.store.read({ ...scope, candidateRef: SESSION_CANDIDATE_REF }));
    }

    if (!existing) {
      const created = createForm({ candidateRef, jobId: scope.jobId, contract });
      const isAdditionalCandidate =
        explicitlyAdditional ||
        (candidateRef !== SESSION_CANDIDATE_REF &&
          currentRef != null &&
          currentRef !== SESSION_CANDIDATE_REF &&
          currentRef !== candidateRef);
      return isAdditionalCandidate ? { ...created, candidateScope: 'additional' } : created;
    }
    let routed =
      candidateRef !== SESSION_CANDIDATE_REF
        ? reconcileExplicitCandidateRouting(existing)
        : existing;
    if (explicitlyAdditional && routed.candidateScope !== 'additional') {
      routed = { ...routed, candidateScope: 'additional' };
    }
    const persistedContract = routed.contractSnapshot?.fields;
    return this.syncContractSlots(
      migrateAskTracking(routed),
      persistedContract ?? contract,
      persistedContract,
    );
  }

  /**
   * 纯“查询报名表单”路径更新契约快照。
   *
   * 同 labelId 的定义发生变化时也要重开该槽，避免把旧选项下的答案带进新契约；
   * 未变化的槽位保留，候选人不必重填整张表。
   */
  refreshContractSnapshot(
    form: BookingCollectionForm,
    contract: readonly ContractFieldDef[],
  ): BookingCollectionForm {
    const previousContract = form.contractSnapshot?.fields;
    if (previousContract && contractFieldsEqual(previousContract, contract)) return form;

    let synced = this.syncContractSlots(form, contract, previousContract);
    if (!previousContract && synced.lastRecap) {
      const { lastRecap: _legacyRecap, ...withoutLegacyRecap } = synced;
      synced = withoutLegacyRecap;
    }
    return {
      ...synced,
      contractSnapshot: { fields: cloneContractFields(contract) },
    };
  }

  async persist(scope: CollectionFormScope, form: BookingCollectionForm): Promise<void> {
    await this.store.write(scope, form);
  }

  /**
   * 把本轮经公证落定的交集槽位逐格回流 sessionFacts。
   *
   * 必须在表单 rebind/persist 前 await：若 facts 写失败，本轮不落表，重试仍会重新
   * 公证并回流；已成功的同值格由 facts 舱守卫保留旧信封，不会刷新 extractedAt。
   */
  async saveFinalizedProgressFacts(
    scope: CollectionFormScope & { sessionId: string },
    form: BookingCollectionForm,
    contract: readonly ContractFieldDef[],
    finalizedFields: readonly ContractFieldDef[],
    extractedAt = new Date().toISOString(),
  ): Promise<void> {
    const finalizedIds = new Set(finalizedFields.map((field) => field.labelId));

    for (const [index, field] of contract.entries()) {
      if (!finalizedIds.has(field.labelId)) continue;
      const slot = form.slots[field.labelId];
      if (slot?.state !== 'filled' || !slot.value?.value) continue;

      const mapping = Object.values(COLLECTION_PROGRESS_FACT_MAPPING).find(
        ({ factField }) =>
          findFieldForCandidateFact(contract, factField)?.labelId === field.labelId,
      );
      if (!mapping) continue;

      await this.sessionState.saveCollectionProgressFact(
        scope.corpId,
        scope.userId,
        scope.sessionId,
        mapping.interviewField,
        sessionFactValue(slot.value.value, {
          confidence: 'medium',
          source: slot.value.producer,
          evidence: `收资表单第 ${index + 1} 格落定（${field.labelTitle}，labelId=${field.labelId}）`,
          extractedAt,
        }),
      );
    }
  }

  /**
   * 手机号到达时把 'session' 默认表搬到人键表（D1）。
   *
   * 搬家而非重开：候选人往往是先答了姓名年龄、最后才给手机号，重开等于前面全白问。
   * 旧 key 写完新 key 后删，中间崩了最坏是留一份孤儿 session 表，随 TTL 过期。
   */
  async rebindToPhone(
    scope: CollectionFormScope,
    form: BookingCollectionForm,
    phone: string,
  ): Promise<BookingCollectionForm> {
    const candidateRef = normalizeCandidateRef(phone);
    if (candidateRef === SESSION_CANDIDATE_REF || form.candidateRef === candidateRef) {
      return form;
    }
    const previousRef = form.candidateRef;
    const rebound: BookingCollectionForm = { ...form, candidateRef };
    await this.store.write(scope, rebound);
    await this.store.remove({ ...scope, candidateRef: previousRef });
    this.logger.log(
      `[collection-form] 人键 rebind: ${previousRef} → ${candidateRef} (job=${scope.jobId})`,
    );
    return rebound;
  }

  /** 按最新契约对齐办理槽位；仍在契约内的已有槽位一格不动。 */
  private syncContractSlots(
    form: BookingCollectionForm,
    contract: readonly ContractFieldDef[],
    previousContract?: readonly ContractFieldDef[],
  ): BookingCollectionForm {
    const currentIds = new Set(contract.map((field) => field.labelId));
    const previousIds = Object.keys(form.slots).map(Number);
    const added = contract.filter((field) => !form.slots[field.labelId]);
    const removed = previousIds.filter((labelId) => !currentIds.has(labelId));
    const previousFieldsById = new Map(
      (previousContract ?? []).map((field) => [field.labelId, field]),
    );
    const changed = previousContract
      ? contract.filter((field) => {
          const previous = previousFieldsById.get(field.labelId);
          return previous ? !contractFieldsEqual([previous], [field]) : false;
        })
      : [];
    const changedIds = new Set(changed.map((field) => field.labelId));
    const contractOrderChanged = previousContract
      ? previousContract.map((field) => field.labelId).join(',') !==
        contract.map((field) => field.labelId).join(',')
      : false;
    const semanticMarkerChanged = contract.some(
      (field) => form.slots[field.labelId]?.systemField !== field.systemField,
    );
    if (
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      !contractOrderChanged &&
      !semanticMarkerChanged
    ) {
      return form;
    }

    const slots: BookingCollectionForm['slots'] = {};
    for (const field of contract) {
      const existing = form.slots[field.labelId];
      if (!existing || changedIds.has(field.labelId)) {
        slots[field.labelId] = {
          labelId: field.labelId,
          ...(field.systemField ? { systemField: field.systemField } : {}),
          state: 'empty',
          askCount: 0,
        };
        continue;
      }
      const { systemField: _previousSystemField, ...rest } = existing;
      slots[field.labelId] = {
        ...rest,
        ...(field.systemField ? { systemField: field.systemField } : {}),
      };
    }
    this.logger.log(
      `[collection-form] 契约槽位对齐: added=[${added
        .map((field) => field.labelId)
        .join(',')}], changed=[${changed
        .map((field) => field.labelId)
        .join(',')}], removed=[${removed.join(',')}], reordered=${contractOrderChanged}`,
    );
    const { lastRecap: _staleRecap, ...formWithoutRecap } = form;
    return reconcileAskLimitEscalation({
      ...formWithoutRecap,
      slots,
      ...(form.configDebts
        ? {
            configDebts: form.configDebts.filter(
              (debt) => currentIds.has(debt.labelId) && !changedIds.has(debt.labelId),
            ),
          }
        : {}),
    });
  }
}

function cloneContractFields(contract: readonly ContractFieldDef[]): ContractFieldDef[] {
  return contract.map((field) => ({
    ...field,
    acceptedOptions: field.acceptedOptions.map((option) => ({ ...option })),
    rejectedOptions: field.rejectedOptions.map((option) => ({ ...option })),
    valueSpec: field.valueSpec
      ? {
          ...field.valueSpec,
          genderRanges: field.valueSpec.genderRanges.map((range) => ({ ...range })),
        }
      : field.valueSpec,
  }));
}

/** 人键归一：11 位可存手机号才作人键，否则回落会话默认表。 */
function normalizeCandidateRef(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/gu, '');
  return isStorableCandidatePhone(digits) ? digits : SESSION_CANDIDATE_REF;
}
