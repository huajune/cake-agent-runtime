#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_BADCASES = 'tmp/badcases-20260427-20260428-context.json';
const DEFAULT_CURATED = 'tmp/curated-badcase-dataset-draft-20260428.json';
const DEFAULT_OUT = 'tmp/curated-badcase-dataset-draft-20260428-trace-enriched.json';
const DEFAULT_SUMMARY = 'tmp/badcase-trace-memory-coverage-20260429.json';

function parseArgs(argv) {
  const args = {
    badcases: DEFAULT_BADCASES,
    curated: DEFAULT_CURATED,
    out: DEFAULT_OUT,
    summary: DEFAULT_SUMMARY,
    check: false,
    minTraceCoverage: 1,
    minMemoryCoverage: 1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--badcases' && value) {
      args.badcases = value;
      i += 1;
    } else if (key === '--curated' && value) {
      args.curated = value;
      i += 1;
    } else if (key === '--out' && value) {
      args.out = value;
      i += 1;
    } else if (key === '--summary' && value) {
      args.summary = value;
      i += 1;
    } else if (key === '--min-trace-coverage' && value) {
      args.minTraceCoverage = Number(value);
      i += 1;
    } else if (key === '--min-memory-coverage' && value) {
      args.minMemoryCoverage = Number(value);
      i += 1;
    } else if (key === '--check') {
      args.check = true;
    } else if (key === '--help' || key === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/backfill-badcase-trace-memory.js [options]

Options:
  --badcases <file>             Badcase context JSON, default ${DEFAULT_BADCASES}
  --curated <file>              Curated dataset payload JSON, default ${DEFAULT_CURATED}
  --out <file>                  Enriched payload output, default ${DEFAULT_OUT}
  --summary <file>              Coverage summary output, default ${DEFAULT_SUMMARY}
  --check                       Fail when coverage is below thresholds
  --min-trace-coverage <0..1>   Required trace coverage for --check, default 1
  --min-memory-coverage <0..1>  Required memory fixture coverage for --check, default 1
`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeList(...values) {
  const result = [];
  const push = (value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    for (const part of String(value).split(/[\s,，;；|]+/)) {
      const trimmed = part.trim();
      if (trimmed && !result.includes(trimmed)) result.push(trimmed);
    }
  };
  for (const value of values) push(value);
  return result;
}

function compact(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, entryValue]) => [key, compact(entryValue)])
      .filter(([, entryValue]) => entryValue !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function mergeTrace(...traces) {
  const merged = {};
  for (const trace of traces) {
    if (!trace || typeof trace !== 'object') continue;
    merged.badcaseIds = normalizeList(merged.badcaseIds, trace.badcaseIds);
    merged.goodcaseIds = normalizeList(merged.goodcaseIds, trace.goodcaseIds);
    merged.badcaseRecordIds = normalizeList(merged.badcaseRecordIds, trace.badcaseRecordIds);
    merged.chatIds = normalizeList(merged.chatIds, trace.chatIds);
    merged.anchorMessageIds = normalizeList(merged.anchorMessageIds, trace.anchorMessageIds);
    merged.relatedMessageIds = normalizeList(merged.relatedMessageIds, trace.relatedMessageIds);
    merged.messageProcessingIds = normalizeList(
      merged.messageProcessingIds,
      trace.messageProcessingIds,
    );
    merged.traceIds = normalizeList(merged.traceIds, trace.traceIds);
    merged.executionIds = normalizeList(merged.executionIds, trace.executionIds);
    merged.batchIds = normalizeList(merged.batchIds, trace.batchIds);
    merged.notes = normalizeList(merged.notes, trace.notes);
    merged.raw = compact({ ...(merged.raw || {}), ...(trace.raw || {}) });
  }
  return compact(merged) || null;
}

function buildBadcaseIndex(payload) {
  const cases = Array.isArray(payload?.cases) ? payload.cases : [];
  const byBadcaseId = new Map();
  const byChatId = new Map();

  for (const item of cases) {
    if (item.badcaseId) byBadcaseId.set(item.badcaseId, item);
    if (item.chatId) {
      const list = byChatId.get(item.chatId) || [];
      list.push(item);
      byChatId.set(item.chatId, list);
    }
  }

  return { cases, byBadcaseId, byChatId };
}

function contextToTrace(context) {
  if (!context) return null;

  const processingIds = normalizeList(
    context.processingRecords?.map((record) => record.messageId || record.traceId),
  );
  const relatedMessageIds = normalizeList(
    context.context?.map((message) => message.messageId || message.id),
  );

  return mergeTrace({
    badcaseIds: normalizeList(context.badcaseId),
    badcaseRecordIds: normalizeList(context.record_id),
    chatIds: normalizeList(context.chatId),
    anchorMessageIds: normalizeList(context.anchor?.messageId),
    relatedMessageIds,
    messageProcessingIds: processingIds,
    traceIds: normalizeList(
      context.processingRecords?.map((record) => record.traceId).filter(Boolean),
    ),
    raw: {
      sourceRecord: {
        badcaseId: context.badcaseId,
        recordId: context.record_id,
        status: context.status,
        priority: context.priority,
        submittedAt: context.submittedAt,
        title: context.title,
        category: context.category,
      },
      anchor: context.anchor,
      processingSummary: summarizeProcessingRecords(context.processingRecords),
    },
  });
}

function summarizeProcessingRecords(records) {
  if (!Array.isArray(records)) return undefined;
  return records.map((record) =>
    compact({
      time: record.time,
      messageId: record.messageId,
      traceId: record.traceId,
      messagePreview: record.messagePreview,
      replyPreview: record.replyPreview,
      status: record.status,
      flags: record.flags,
      stage: record.stage,
      totalDuration: record.totalDuration,
      tools: Array.isArray(record.tools)
        ? record.tools.map((tool) =>
            compact({
              name: tool.name || tool.toolName,
              status: tool.status,
              args: tool.args,
              resultCount: tool.resultCount,
            }),
          )
        : undefined,
      error: record.error,
    }),
  );
}

function buildMemoryFixtureDraft(contexts) {
  const validContexts = contexts.filter(Boolean);
  if (validContexts.length === 0) return null;

  const lastContext = validContexts[validContexts.length - 1];
  const allProcessing = validContexts.flatMap((item) =>
    Array.isArray(item.processingRecords) ? item.processingRecords : [],
  );
  const lastProcessing = [...allProcessing].reverse().find((record) => record.stage);
  const jobIds = normalizeList(
    allProcessing.flatMap((record) =>
      Array.isArray(record.tools) ? record.tools.flatMap((tool) => tool.args?.jobIdList || []) : [],
    ),
  );

  return (
    compact({
      currentStage: lastProcessing?.stage || null,
      sessionFacts: {
        source: 'badcase-context-backfill',
        badcaseIds: normalizeList(validContexts.map((item) => item.badcaseId)),
        chatIds: normalizeList(validContexts.map((item) => item.chatId)),
        candidateName: lastContext.candidateName,
        managerName: lastContext.managerName,
        anchorUserMessage: lastContext.anchor?.content || lastContext.userMessage,
        sourceMemoryConfidence: 'draft_from_badcase_context',
      },
      facts: {
        candidateName: lastContext.candidateName,
        managerName: lastContext.managerName,
        lastUserMessage: lastContext.anchor?.content || lastContext.userMessage,
      },
      presentedJobs: jobIds.map((jobId) => ({
        jobId: Number.isNaN(Number(jobId)) ? jobId : Number(jobId),
        source: 'processing.toolArgs.jobIdList',
      })),
      procedural: {
        currentStage: lastProcessing?.stage || null,
      },
    }) || null
  );
}

function buildMemoryAssertionsDraft(contexts) {
  const trace = mergeTrace(...contexts.map(contextToTrace));
  if (!trace) return null;
  return compact({
    sourceTraceRequired: true,
    shouldPreserve: ['currentStage', 'sessionFacts', 'presentedJobs'],
    sourceBadcaseIds: trace.badcaseIds,
    sourceAnchorMessageIds: trace.anchorMessageIds,
  });
}

function contextsForCase(item, index) {
  const ids = normalizeList(item.sourceBadCaseIds, item.sourceTrace?.badcaseIds);
  const contexts = ids.map((id) => index.byBadcaseId.get(id)).filter(Boolean);
  if (contexts.length > 0) return contexts;

  const chatIds = normalizeList(item.sourceChatIds, item.chatId, item.sourceTrace?.chatIds);
  return chatIds.flatMap((chatId) => index.byChatId.get(chatId) || []);
}

function enrichCase(item, index) {
  const contexts = contextsForCase(item, index);
  const contextTrace = mergeTrace(...contexts.map(contextToTrace));
  const directTrace = mergeTrace({
    badcaseIds: normalizeList(item.sourceBadCaseIds),
    chatIds: normalizeList(item.sourceChatIds, item.chatId),
    badcaseRecordIds: normalizeList(item.sourceRecordIds),
    anchorMessageIds: normalizeList(item.sourceAnchorMessageIds),
    relatedMessageIds: normalizeList(item.sourceRelatedMessageIds),
    messageProcessingIds: normalizeList(item.sourceMessageProcessingIds),
    traceIds: normalizeList(item.sourceTraceIds),
  });
  const sourceTrace = mergeTrace(item.sourceTrace, directTrace, contextTrace);
  const memorySetup = item.memorySetup || buildMemoryFixtureDraft(contexts);
  const memoryAssertions = item.memoryAssertions || buildMemoryAssertionsDraft(contexts);

  return compact({
    ...item,
    sourceRecordIds: normalizeList(item.sourceRecordIds, sourceTrace?.badcaseRecordIds),
    sourceChatIds: normalizeList(item.sourceChatIds, sourceTrace?.chatIds),
    sourceAnchorMessageIds: normalizeList(
      item.sourceAnchorMessageIds,
      sourceTrace?.anchorMessageIds,
    ),
    sourceRelatedMessageIds: normalizeList(
      item.sourceRelatedMessageIds,
      sourceTrace?.relatedMessageIds,
    ),
    sourceMessageProcessingIds: normalizeList(
      item.sourceMessageProcessingIds,
      sourceTrace?.messageProcessingIds,
    ),
    sourceTraceIds: normalizeList(item.sourceTraceIds, sourceTrace?.traceIds),
    sourceTrace,
    memorySetup,
    memoryAssertions,
  });
}

function enrichCuratedPayload(curated, index) {
  const scenarioCases = curated.scenarioImportPayload?.cases || [];
  const conversationCases = curated.conversationImportPayload?.cases || [];

  return {
    ...curated,
    scenarioImportPayload: {
      ...curated.scenarioImportPayload,
      cases: scenarioCases.map((item) => enrichCase(item, index)),
    },
    conversationImportPayload: {
      ...curated.conversationImportPayload,
      cases: conversationCases.map((item) => enrichCase(item, index)),
    },
  };
}

function hasTrace(item) {
  const trace = item.sourceTrace || {};
  return Boolean(
    normalizeList(
      trace.badcaseIds,
      trace.badcaseRecordIds,
      trace.chatIds,
      trace.anchorMessageIds,
      trace.messageProcessingIds,
      item.sourceBadCaseIds,
      item.sourceChatIds,
      item.sourceAnchorMessageIds,
    ).length,
  );
}

function hasMemory(item) {
  return Boolean(item.memorySetup && item.memoryAssertions);
}

function summarizeCoverage(enriched, sourceCaseCount) {
  const scenarioCases = enriched.scenarioImportPayload?.cases || [];
  const conversationCases = enriched.conversationImportPayload?.cases || [];
  const allCases = [
    ...scenarioCases.map((item) => ({
      type: 'scenario',
      id: item.caseId,
      title: item.caseName,
      item,
    })),
    ...conversationCases.map((item) => ({
      type: 'conversation',
      id: item.validationId,
      title: item.validationTitle,
      item,
    })),
  ];

  const traced = allCases.filter(({ item }) => hasTrace(item));
  const withMemory = allCases.filter(({ item }) => hasMemory(item));

  return {
    generatedAt: new Date().toISOString(),
    sourceBadcaseCount: sourceCaseCount,
    totals: {
      scenario: scenarioCases.length,
      conversation: conversationCases.length,
      all: allCases.length,
    },
    coverage: {
      trace: ratio(traced.length, allCases.length),
      memory: ratio(withMemory.length, allCases.length),
    },
    counts: {
      withTrace: traced.length,
      withMemory: withMemory.length,
      missingTrace: allCases.length - traced.length,
      missingMemory: allCases.length - withMemory.length,
    },
    missingTrace: allCases
      .filter(({ item }) => !hasTrace(item))
      .map(({ type, id, title }) => ({ type, id, title })),
    missingMemory: allCases
      .filter(({ item }) => !hasMemory(item))
      .map(({ type, id, title }) => ({ type, id, title })),
  };
}

function ratio(count, total) {
  return total === 0 ? 1 : Number((count / total).toFixed(4));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const badcasePayload = readJson(args.badcases);
  const curatedPayload = readJson(args.curated);
  const index = buildBadcaseIndex(badcasePayload);
  const enriched = enrichCuratedPayload(curatedPayload, index);
  const summary = summarizeCoverage(enriched, index.cases.length);

  writeJson(args.out, enriched);
  writeJson(args.summary, summary);

  console.log(
    JSON.stringify(
      {
        output: args.out,
        summary: args.summary,
        coverage: summary.coverage,
        counts: summary.counts,
      },
      null,
      2,
    ),
  );

  if (
    args.check &&
    (summary.coverage.trace < args.minTraceCoverage ||
      summary.coverage.memory < args.minMemoryCoverage)
  ) {
    console.error(
      `Coverage check failed: trace=${summary.coverage.trace}, memory=${summary.coverage.memory}`,
    );
    process.exit(1);
  }
}

main();
