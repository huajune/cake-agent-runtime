/**
 * 收资表单的持久化编排：loadOrCreate / persist / phone 到达 rebind。
 *
 * 职责边界：本服务**不做任何字段判断**——改表只经 `@resolution/collection` 的写路径
 * 纯函数（CLAUDE.md：memory 只持有事实，不实现字段判断）。这里只管从哪读、写到哪、
 * 人键变了怎么搬家。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  createForm,
  SESSION_CANDIDATE_REF,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { CollectionFormStore } from '../stores/collection-form.store';

export interface CollectionFormScope {
  corpId: string;
  userId: string;
  jobId: number;
}

@Injectable()
export class CollectionFormService {
  private readonly logger = new Logger(CollectionFormService.name);

  constructor(private readonly store: CollectionFormStore) {}

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
  ): Promise<BookingCollectionForm> {
    const candidateRef = normalizeCandidateRef(candidatePhone);

    const currentRef = await this.store.readCurrentCandidateRef(scope);

    const existing =
      (candidateRef !== SESSION_CANDIDATE_REF
        ? await this.store.read({ ...scope, candidateRef })
        : null) ??
      (currentRef ? await this.store.read({ ...scope, candidateRef: currentRef }) : null) ??
      (await this.store.read({ ...scope, candidateRef: SESSION_CANDIDATE_REF }));

    if (!existing) {
      return createForm({ candidateRef, jobId: scope.jobId, contract });
    }
    return this.syncContractSlots(existing, contract);
  }

  async persist(scope: CollectionFormScope, form: BookingCollectionForm): Promise<void> {
    await this.store.write(scope, form);
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
  ): BookingCollectionForm {
    const currentIds = new Set(contract.map((field) => field.labelId));
    const previousIds = Object.keys(form.slots).map(Number);
    const added = contract.filter((field) => !form.slots[field.labelId]);
    const removed = previousIds.filter((labelId) => !currentIds.has(labelId));
    if (added.length === 0 && removed.length === 0) return form;

    const slots: BookingCollectionForm['slots'] = {};
    for (const field of contract) {
      slots[field.labelId] = form.slots[field.labelId] ?? {
        labelId: field.labelId,
        state: 'empty',
        askCount: 0,
      };
    }
    this.logger.log(
      `[collection-form] 契约槽位对齐: added=[${added
        .map((field) => field.labelId)
        .join(',')}], removed=[${removed.join(',')}]`,
    );
    return {
      ...form,
      slots,
      ...(form.lastRecap
        ? { lastRecap: { labelIds: form.lastRecap.labelIds.filter((id) => currentIds.has(id)) } }
        : {}),
      ...(form.configDebts
        ? { configDebts: form.configDebts.filter((debt) => currentIds.has(debt.labelId)) }
        : {}),
    };
  }
}

/** 人键归一：11 位可存手机号才作人键，否则回落会话默认表。 */
function normalizeCandidateRef(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/gu, '');
  return isStorableCandidatePhone(digits) ? digits : SESSION_CANDIDATE_REF;
}
