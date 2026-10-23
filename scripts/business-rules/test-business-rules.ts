import { spawnSync } from 'node:child_process';
import { checkBusinessRules } from './check';
import { selectRuleTests } from './registry';

async function main() {
  const rules = await checkBusinessRules();
  const tests = selectRuleTests(
    rules,
    process.argv.slice(2).filter((arg) => arg !== '--'),
  );
  if (!tests.length) throw new Error('No business rule tests selected');
  console.log(`Running ${tests.length} linked local contract suites; not a live Agent evaluation.`);
  const result = spawnSync(
    'pnpm',
    ['exec', 'jest', '--runTestsByPath', ...tests, '--runInBand', '--watchman=false'],
    {
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
