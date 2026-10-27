// Emergency password reset for when nobody who could reset an account can sign in (e.g. the only owner, with no recovery email).
// Needs Wrangler logged in to the Cloudflare account that owns the D1 database.
//   npm run reset-password -- <username> [--db digiteq] [--local]
// Prints a temporary password; the user must choose a new one at the next sign-in. All their sessions are signed out.
import { execFileSync } from 'node:child_process';
import { hashPassword } from '../server/api.js';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!username) {
  console.error('Usage: npm run reset-password -- <username> [--db digiteq] [--local]');
  process.exit(1);
}
const db = flag('--db') || 'digiteq';
const words = ['kite', 'moon', 'river', 'lamp', 'cloud', 'tiger', 'maple', 'stone', 'pearl', 'cedar', 'comet', 'delta'];
const r = crypto.getRandomValues(new Uint32Array(3));
const password = `${words[r[0] % words.length]}-${1000 + (r[1] % 9000)}-${words[r[2] % words.length]}`;
const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;
const user = sqlText(username);
const sql = `UPDATE users SET password_hash = ${sqlText(await hashPassword(password))}, must_change_password = 1 WHERE username = ${user};
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ${user});
SELECT name, username, role, is_owner FROM users WHERE username = ${user};`;
const out = execFileSync('npx', ['wrangler', 'd1', 'execute', db, args.includes('--local') ? '--local' : '--remote', '--json', '--command', sql], { encoding: 'utf8' });
const rows = JSON.parse(out).flatMap((r) => r.results || []);
if (!rows.length) {
  console.error(`No account with username "${username}" in database "${db}". Nothing was changed.`);
  process.exit(1);
}
console.log(`Password reset for ${rows[0].name} (@${rows[0].username}).`);
console.log(`Temporary password: ${password}`);
console.log('They must choose a new password when they sign in.');
