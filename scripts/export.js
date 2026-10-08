import { exportByField } from '../audit-operations.js';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [input, output, field = 'audit_status', ...extra] = args.filter(arg => arg !== '--dry-run');
if (!input || !output || extra.length) {
  console.error('Usage: npm run export -- INPUT_FOLDER NEW_OUTPUT_FOLDER [YAML_FIELD] [--dry-run]\nDefault field: audit_status. Originals are preserved; marked blocks and the field are removed from copies.');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await exportByField(input, output, field, { dryRun }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
