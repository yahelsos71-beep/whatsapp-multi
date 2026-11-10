// איפוס סיסמה – מריצים על השרת עצמו (reset-password.bat). לא עובר דרך הרשת.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const DATA_DIR = process.env.HD_DATA || path.join(__dirname, 'data');
let users = [];
try { users = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8')); } catch {}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = []; const waiting = [];
rl.on('line', (l) => { if (waiting.length) waiting.shift()(l.trim()); else lines.push(l.trim()); });
const ask = (q) => { process.stdout.write(q); return lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiting.push(r)); };
(async () => {
  if (!users.length) { console.log('No users found in ' + DATA_DIR); rl.close(); return; }
  console.log('\nUsers (username - role):');
  for (const u of users) console.log('  ' + u.username + '  -  ' + u.role + (u.active === false ? '  (disabled)' : ''));
  const username = (await ask('\nUsername to reset: ')).toLowerCase();
  if (!users.some((u) => u.username === username)) { console.log('User not found.'); rl.close(); return; }
  const password = await ask('New password (at least 4 characters): ');
  if (password.length < 4) { console.log('Too short.'); rl.close(); return; }
  fs.writeFileSync(path.join(DATA_DIR, 'reset-password.json'), JSON.stringify({ username, password }));
  console.log('\nDone. Within a few seconds you can log in as "' + username + '" with the new password.');
  console.log('(If the server is not running - start it with start.bat, the reset is applied on start.)');
  rl.close();
})();
