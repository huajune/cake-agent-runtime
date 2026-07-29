import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuApiService } from '@infra/feishu/services/api.service';

interface FeishuResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

interface WikiNode {
  obj_type: string;
  obj_token: string;
  title: string;
  space_id: string;
}

interface DocxBlock {
  block_id: string;
  parent_id?: string;
  block_type: number;
  children?: string[];
  [key: string]: unknown;
}

export interface BadcaseGovernanceDocumentItem {
  recordId: string;
  badcaseId?: string;
  title?: string;
  category?: string;
  status: string;
  batchId?: string;
  evidenceSummary?: string;
}

export interface BadcaseGovernanceDocumentUpdate {
  items: BadcaseGovernanceDocumentItem[];
  occurredAt?: Date;
}

@Injectable()
export class BadcaseGovernanceDocumentService {
  private readonly logger = new Logger(BadcaseGovernanceDocumentService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly feishuApi: FeishuApiService,
  ) {}

  async checkAccess(): Promise<{
    success: boolean;
    title: string;
    documentId: string;
    blockCount: number;
    insertionIndex: number;
  }> {
    const document = await this.loadDocument();
    return {
      success: true,
      title: document.node.title,
      documentId: document.documentId,
      blockCount: document.blocks.length,
      insertionIndex: document.insertionIndex,
    };
  }

  async appendUpdate(update: BadcaseGovernanceDocumentUpdate): Promise<{
    success: boolean;
    skipped: boolean;
    dryRun: boolean;
    eventId: string;
    error?: string;
  }> {
    if (update.items.length === 0) {
      return { success: true, skipped: true, dryRun: true, eventId: '' };
    }

    const eventId = this.buildEventId(update.items);
    const writeEnabled =
      this.configService.get<string>('BADCASE_GOVERNANCE_DOC_SYNC_ENABLED', 'false') === 'true';
    try {
      const document = await this.loadDocument();
      if (document.blocks.some((block) => this.readBlockText(block).includes(eventId))) {
        return { success: true, skipped: true, dryRun: !writeEnabled, eventId };
      }

      const children = this.buildUpdateBlocks(update, eventId);
      if (!writeEnabled) {
        this.logger.log(
          `[BadcaseGovernanceDoc] dry-run event=${eventId} items=${update.items.length} index=${document.insertionIndex}`,
        );
        return { success: true, skipped: false, dryRun: true, eventId };
      }

      const response = await this.feishuApi.post<FeishuResponse<Record<string, unknown>>>(
        `/docx/v1/documents/${document.documentId}/blocks/${document.documentId}/children`,
        {
          index: document.insertionIndex,
          children,
        },
        { params: { document_revision_id: -1 } },
      );
      if (response.data.code !== 0) {
        throw new Error(`${response.data.code} ${response.data.msg}`);
      }
      this.logger.log(
        `[BadcaseGovernanceDoc] 已追加治理进展 event=${eventId} items=${update.items.length}`,
      );
      return { success: true, skipped: false, dryRun: false, eventId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[BadcaseGovernanceDoc] 更新失败 event=${eventId}: ${message}`);
      return { success: false, skipped: false, dryRun: !writeEnabled, eventId, error: message };
    }
  }

  private async loadDocument(): Promise<{
    node: WikiNode;
    documentId: string;
    blocks: DocxBlock[];
    insertionIndex: number;
  }> {
    const wikiToken = this.configService
      .get<string>('FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN', '')
      .trim();
    if (!wikiToken) {
      throw new Error('缺少 FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN');
    }
    const nodeResponse = await this.feishuApi.get<FeishuResponse<{ node: WikiNode }>>(
      '/wiki/v2/spaces/get_node',
      { params: { token: wikiToken } },
    );
    const node = nodeResponse.data.data?.node;
    if (nodeResponse.data.code !== 0 || !node || node.obj_type !== 'docx') {
      throw new Error(
        `Wiki 节点无法解析为 docx: ${nodeResponse.data.code} ${nodeResponse.data.msg}`,
      );
    }

    const blocks = await this.getAllBlocks(node.obj_token);
    const root = blocks.find((block) => block.block_id === node.obj_token);
    const sectionFour = blocks.find(
      (block) =>
        block.parent_id === node.obj_token &&
        block.block_type === 4 &&
        this.readBlockText(block).startsWith('四、'),
    );
    if (!root?.children || !sectionFour) {
      throw new Error('未找到文档根块或“四、”章节，无法确定安全插入位置');
    }
    const insertionIndex = root.children.indexOf(sectionFour.block_id);
    if (insertionIndex < 0) {
      throw new Error('“四、”章节不在文档根块 children 中');
    }
    return {
      node,
      documentId: node.obj_token,
      blocks,
      insertionIndex,
    };
  }

  private async getAllBlocks(documentId: string): Promise<DocxBlock[]> {
    const blocks: DocxBlock[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.feishuApi.get<
        FeishuResponse<{ items: DocxBlock[]; has_more?: boolean; page_token?: string }>
      >(`/docx/v1/documents/${documentId}/blocks`, {
        params: {
          page_size: 500,
          document_revision_id: -1,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (response.data.code !== 0) {
        throw new Error(`读取文档块失败: ${response.data.code} ${response.data.msg}`);
      }
      blocks.push(...(response.data.data?.items || []));
      pageToken = response.data.data?.has_more ? response.data.data.page_token : undefined;
    } while (pageToken);
    return blocks;
  }

  private buildUpdateBlocks(
    update: BadcaseGovernanceDocumentUpdate,
    eventId: string,
  ): Array<Record<string, unknown>> {
    const occurredAt = update.occurredAt || new Date();
    const dateParts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(occurredAt);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      dateParts.find((item) => item.type === type)?.value || '';
    const dateTitle = `${part('month')} 月 ${part('day')} 日 ${part('hour')}:${part('minute')}`;
    const displayedItems = update.items.slice(0, 40);
    const blocks: Array<Record<string, unknown>> = [
      this.heading3Block(`${dateTitle}：BadCase 治理更新`),
      this.textBlock('本次更新：'),
      ...displayedItems.map((item) => this.bulletBlock(this.formatItem(item))),
    ];
    if (update.items.length > displayedItems.length) {
      blocks.push(
        this.bulletBlock(
          `另有 ${update.items.length - displayedItems.length} 条记录，详见对应测试批次。`,
        ),
      );
    }
    blocks.push(this.textBlock(`治理事件ID：${eventId}`));
    return blocks;
  }

  private formatItem(item: BadcaseGovernanceDocumentItem): string {
    const identity = item.badcaseId || item.recordId;
    const type = item.category || '未分类';
    const title = item.title ? `｜${item.title}` : '';
    const batch = item.batchId ? `；批次 ${item.batchId}` : '';
    const evidence = item.evidenceSummary ? `；${item.evidenceSummary}` : '';
    return `${type}｜${identity}${title}：${item.status}${batch}${evidence}`;
  }

  private buildEventId(items: BadcaseGovernanceDocumentItem[]): string {
    const source = items
      .map(
        (item) =>
          `${item.recordId}:${item.status}:${item.batchId || ''}:${item.evidenceSummary || ''}`,
      )
      .sort()
      .join('|');
    return `bcg-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
  }

  private readBlockText(block: DocxBlock): string {
    const typed = block as Record<string, unknown>;
    for (const key of [
      'text',
      'heading1',
      'heading2',
      'heading3',
      'heading4',
      'heading5',
      'heading6',
      'bullet',
      'ordered',
    ]) {
      const data = typed[key] as
        | { elements?: Array<{ text_run?: { content?: string } }> }
        | undefined;
      if (data?.elements) {
        return data.elements.map((element) => element.text_run?.content || '').join('');
      }
    }
    return '';
  }

  private heading3Block(content: string): Record<string, unknown> {
    return {
      block_type: 5,
      heading3: { elements: [this.textElement(content)] },
    };
  }

  private textBlock(content: string): Record<string, unknown> {
    return {
      block_type: 2,
      text: { elements: content ? [this.textElement(content)] : [] },
    };
  }

  private bulletBlock(content: string): Record<string, unknown> {
    return {
      block_type: 12,
      bullet: { elements: [this.textElement(content)] },
    };
  }

  private textElement(content: string): Record<string, unknown> {
    return {
      text_run: {
        content,
        text_element_style: {},
      },
    };
  }
}
