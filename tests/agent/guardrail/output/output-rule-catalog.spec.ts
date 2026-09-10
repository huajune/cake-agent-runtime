import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, posix, resolve } from 'path';
import * as ts from 'typescript';
import {
  createOutputRuleFinding,
  getOutputRule,
  OUTPUT_RULE_CATALOG,
  type OutputRuleCatalogMetadata,
  type OutputRuleId,
} from '@agent/guardrail/output/output-rule-catalog';
import { deriveRulePolicy } from '@agent/guardrail/output/output-rule.types';

const ROOT = resolve(__dirname, '../../../..');
const RULES = 'agent/guardrail/output/rules';
const SERVICE = `${RULES}/hard-rules.service.ts`;
type Registration = Pick<OutputRuleCatalogMetadata, 'source' | 'entrypoint'> & { id: string };
type Sources = ReadonlyMap<string, string>;

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

/** Read executable declarations and service call sites independently of catalog IDs. */
function validateExecutionCatalog(sources: Sources, catalog: readonly Registration[]): string[] {
  const errors: string[] = [];
  const parsed = new Map(
    [...sources].map(([path, content]) => [
      path,
      ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true),
    ]),
  );
  const service = parsed.get(SERVICE)!;
  const imports = new Map<string, string>();
  for (const statement of service.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const source = posix.normalize(join(dirname(SERVICE), `${statement.moduleSpecifier.text}.ts`));
    for (const binding of bindings.elements) {
      imports.set(binding.name.text, `${source}#${(binding.propertyName ?? binding.name).text}`);
    }
  }

  const wired = new Set<string>();
  const factCollections: string[] = [];
  let runsFactRules = false;
  visit(service, (node) => {
    if (
      ts.isPropertyDeclaration(node) &&
      node.name.getText(service) === 'rules' &&
      node.initializer
    ) {
      visit(node.initializer, (child) => {
        if (ts.isSpreadElement(child) && ts.isIdentifier(child.expression)) {
          factCollections.push(child.expression.text);
        }
      });
    }
    if (!ts.isMethodDeclaration(node) || node.name.getText(service) !== 'check' || !node.body)
      return;
    visit(node.body, (child) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const symbol = imports.get(child.expression.text);
        if (symbol) wired.add(symbol);
      }
      if (ts.isForOfStatement(child) && child.expression.getText(service) === 'this.rules') {
        visit(child.statement, (statement) => {
          if (
            ts.isCallExpression(statement) &&
            statement.expression.getText(service) === 'createOutputRuleFinding' &&
            statement.arguments[0]?.getText(service) === 'rule.ruleId'
          ) {
            runsFactRules = true;
          }
        });
      }
    });
  });
  if (runsFactRules) {
    for (const collection of factCollections) {
      const symbol = imports.get(collection);
      if (symbol) wired.add(symbol);
    }
  }

  const declarations = new Map<string, Set<string>>();
  const register = (id: string, source: string, node: ts.Node) => {
    let owner: ts.Node = node;
    while (owner.parent && !ts.isFunctionDeclaration(owner) && !ts.isVariableDeclaration(owner)) {
      owner = owner.parent;
    }
    const entrypoint =
      ts.isFunctionDeclaration(owner) || ts.isVariableDeclaration(owner)
        ? owner.name?.getText()
        : '';
    const key = `${source}#${entrypoint}`;
    const origins = declarations.get(id) ?? new Set<string>();
    origins.add(key);
    declarations.set(id, origins);
    if (!wired.has(key)) errors.push(`Unwired output rule: ${id} (${key})`);
  };

  for (const [source, file] of parsed) {
    if (source === SERVICE) continue;
    visit(file, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file) === 'createOutputRuleFinding'
      ) {
        const id = node.arguments[0];
        if (id && ts.isStringLiteral(id)) register(id.text, source, node);
        else errors.push(`Non-literal detector rule ID: ${source}`);
      }
      if (!ts.isObjectLiteralExpression(node)) return;
      const fields = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map((field) => [field.name.getText(file), field]),
      );
      for (const field of [
        'action',
        'severity',
        'allowFailOpen',
        'feedbackPolicy',
        'feedbackToGenerator',
        'repairMode',
      ]) {
        if (fields.has(field)) errors.push(`Detector overrides catalog ${field}: ${source}`);
      }
      const id = fields.get('ruleId')?.initializer;
      if (!id) return;
      if (!fields.has('keywords')) errors.push(`Finding bypasses catalog binding: ${source}`);
      if (ts.isStringLiteral(id)) register(id.text, source, node);
      else errors.push(`Non-literal FactRule ID: ${source}`);
    });
  }

  const catalogIds = new Set(catalog.map((rule) => rule.id));
  if (catalogIds.size !== catalog.length) errors.push('Duplicate catalog IDs');
  for (const id of declarations.keys()) {
    if (!catalogIds.has(id)) errors.push(`Missing catalog metadata: ${id}`);
  }
  for (const rule of catalog) {
    const origins = declarations.get(rule.id);
    if (!origins) errors.push(`Orphan catalog metadata: ${rule.id}`);
    else if (origins.size !== 1 || !origins.has(`${rule.source}#${rule.entrypoint}`)) {
      errors.push(`Catalog execution source mismatch: ${rule.id}`);
    }
  }
  return [...new Set(errors)];
}

const sources: Sources = new Map(
  readdirSync(join(ROOT, 'src', RULES), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => [`${RULES}/${file}`, readFileSync(join(ROOT, 'src', RULES, file), 'utf8')]),
);

describe('output catalog binds actual rule execution', () => {
  it('every detector/FactRule is registered, every entry is wired, and source/test evidence exists', () => {
    expect(validateExecutionCatalog(sources, OUTPUT_RULE_CATALOG)).toEqual([]);
    for (const rule of OUTPUT_RULE_CATALOG) {
      expect(existsSync(join(ROOT, 'src', rule.source))).toBe(true);
      expect(existsSync(join(ROOT, rule.verification))).toBe(true);
    }
  });

  it('rejects a new detector and a new FactRule without metadata', () => {
    const altered = new Map(sources);
    altered.set(
      `${RULES}/new.rule.ts`,
      `export function detectNew() { return createOutputRuleFinding('new_detector', 'hit'); }
       export const NEW_RULES: FactRule[] = [{ ruleId: 'new_fact', label: 'hit', keywords: /x/ }];`,
    );
    expect(validateExecutionCatalog(altered, OUTPUT_RULE_CATALOG)).toEqual(
      expect.arrayContaining([
        'Missing catalog metadata: new_detector',
        'Missing catalog metadata: new_fact',
      ]),
    );
  });

  it('rejects orphan metadata and wrong source declarations', () => {
    const altered = OUTPUT_RULE_CATALOG.map((rule) =>
      rule.id === 'invalid_model_output' ? { ...rule, entrypoint: 'neverCalled' } : rule,
    );
    expect(
      validateExecutionCatalog(sources, [
        ...altered,
        { id: 'orphan', source: SERVICE, entrypoint: 'check' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        'Catalog execution source mismatch: invalid_model_output',
        'Orphan catalog metadata: orphan',
      ]),
    );
  });

  it('rejects imported detectors or FactRule collections removed from actual dispatch', () => {
    const altered = new Map(sources);
    altered.set(
      SERVICE,
      sources
        .get(SERVICE)!
        .replace('detectInvalidModelOutput(text)', 'null')
        .replace('...FALSE_PROMISE_RULES', ''),
    );
    const errors = validateExecutionCatalog(altered, OUTPUT_RULE_CATALOG);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Unwired output rule: invalid_model_output'),
        expect.stringContaining('Unwired output rule: quota_promise'),
      ]),
    );
  });

  it('rejects a detector or FactRule attempting to override catalog actions/default policy', () => {
    const altered = new Map(sources);
    altered.set(
      `${RULES}/drift.rule.ts`,
      `
      export function detectDrift() {
        return { ...createOutputRuleFinding('invalid_model_output', 'hit'), action: 'observe' };
      }
      export const DRIFT_RULES = [{ ruleId: 'quota_promise', label: 'hit', keywords: /x/, action: 'repair' }];
    `,
    );
    expect(validateExecutionCatalog(altered, OUTPUT_RULE_CATALOG)).toContain(
      `Detector overrides catalog action: ${RULES}/drift.rule.ts`,
    );
  });

  it('looks up only registered literal IDs and fails closed for untyped callers', () => {
    const rejectsArbitraryString: string extends OutputRuleId ? false : true = true;
    expect(rejectsArbitraryString).toBe(true);
    expect(() => {
      // @ts-expect-error Unknown detector IDs must also fail during type checking.
      return createOutputRuleFinding('missing_rule', 'hit');
    }).toThrow('Unregistered output rule: missing_rule');
    expect(() => {
      // @ts-expect-error Catalog lookup has no string fallback.
      return getOutputRule('missing_rule');
    }).toThrow('Unregistered output rule: missing_rule');
  });

  it('binds all default policy fields and allows only declared per-hit feedback', () => {
    for (const rule of OUTPUT_RULE_CATALOG) {
      expect(createOutputRuleFinding(rule.id, 'evidence')).toEqual({
        ruleId: rule.id,
        label: 'evidence',
        action: rule.action,
        ...deriveRulePolicy(rule.action),
        allowFailOpen: rule.allowFailOpen,
        severity: rule.severity,
        dataSensitivity: rule.dataSensitivity,
        feedbackPolicy: rule.feedbackPolicy,
        feedbackToGenerator: rule.feedbackToGenerator,
        repairToolNames: rule.repairToolNames,
      });
    }
    expect(
      createOutputRuleFinding('booking_receipt_mismatch', 'evidence', '本次实际时间'),
    ).toMatchObject({
      feedbackToGenerator: '本次实际时间',
      action: getOutputRule('booking_receipt_mismatch').action,
    });
    expect(() => {
      // @ts-expect-error Static feedback rules cannot supply per-hit policy text.
      return createOutputRuleFinding('human_service_phrase_leak', 'evidence', 'replacement');
    }).toThrow('Output rule does not allow per-hit feedback: human_service_phrase_leak');
  });

  it('keeps the six former hard-stop rules explicit while default repair policy remains independent', () => {
    const strictRules = [
      'invalid_model_output',
      'internal_output_leak',
      'meta_narration_reply',
      'discriminatory_screening_leak',
      'sensitive_origin_probe',
      'quota_promise',
    ];
    expect(
      OUTPUT_RULE_CATALOG.filter((rule) => !rule.allowFailOpen).map((rule) => rule.id),
    ).toEqual(strictRules);
    for (const rule of OUTPUT_RULE_CATALOG) {
      expect(['observe', 'repair', 'replan']).toContain(rule.action);
      if (strictRules.includes(rule.id)) {
        expect(rule).toMatchObject({ action: 'repair', severity: 'P0', allowFailOpen: false });
      } else {
        expect(rule.allowFailOpen).toBe(true);
      }
    }
    expect(deriveRulePolicy('repair')).toEqual({
      currentReplySendable: false,
      repairMode: 'rewrite',
    });
  });

  it('rejects detector attempts to relax catalog fail-open policy', () => {
    const altered = new Map(sources);
    altered.set(
      `${RULES}/relax.rule.ts`,
      `export function detectRelaxed() {
        return { ...createOutputRuleFinding('quota_promise', 'hit'), allowFailOpen: true };
      }`,
    );
    expect(validateExecutionCatalog(altered, OUTPUT_RULE_CATALOG)).toContain(
      `Detector overrides catalog allowFailOpen: ${RULES}/relax.rule.ts`,
    );
  });
});
