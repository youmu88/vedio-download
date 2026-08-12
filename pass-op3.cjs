const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const crypto = require('crypto');
const op = process.argv[2];
const db = new DatabaseSync('data/vd.db');
if (op === 'backup') {
  const row = db.prepare('SELECT salt, hash FROM private_pass WHERE id=1').get();
  fs.writeFileSync('/tmp/private-pass-backup3.json', JSON.stringify(row));
  console.log('备份 OK');
} else if (op === 'reset') {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('1234', salt, 64).toString('hex');
  db.prepare('INSERT OR REPLACE INTO private_pass (id, salt, hash) VALUES (1,?,?)').run(salt, hash);
  console.log('重置 1234 OK');
} else if (op === 'restore') {
  const saved = JSON.parse(fs.readFileSync('/tmp/private-pass-backup3.json', 'utf-8'));
  db.prepare('INSERT OR REPLACE INTO private_pass (id, salt, hash) VALUES (1,?,?)').run(saved.salt, saved.hash);
  console.log('恢复 OK');
}
db.close();
