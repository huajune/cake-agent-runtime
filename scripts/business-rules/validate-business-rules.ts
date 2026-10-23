import { checkBusinessRules } from './check';

checkBusinessRules().then(
  (rules) => console.log(`Business rules: ${rules.length} rules across 7 topics validated.`),
  (error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
