import { exportByField } from '../audit-operations.js';
const [input, output, field = 'audit_status', ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) {
  console.error('Usage: npm run export -- INPUT_FOLDER NEW_OUTPUT_FOLDER [YAML_FIELD]\nDefault field: audit_status. Originals are preserved; the field is removed from copies.');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await exportByField(input, output, field), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
