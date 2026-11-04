// מטעין: בוחר את הגרסה החדשה ביותר של קבצי התוכנה
// (המובנית, או עדכון שהורד אוטומטית) ומפעיל אותה.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ver = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version || 0; } catch { return 0; } };
const BUILTIN = __dirname;
const UPDATE_DIR = path.join(app.getPath('appData'), 'WhatsAppMulti-User', 'app-update');

let dir = BUILTIN;
if (ver(UPDATE_DIR) > ver(BUILTIN) && fs.existsSync(path.join(UPDATE_DIR, 'app-main.js'))) dir = UPDATE_DIR;
global.APP_DIR = dir;
global.BUILTIN_DIR = BUILTIN;
global.UPDATE_DIR = UPDATE_DIR;
try {
  require(path.join(dir, 'app-main.js'));
} catch (e) {
  // עדכון פגום – חוזרים לגרסה המובנית
  if (dir !== BUILTIN) { global.APP_DIR = BUILTIN; require(path.join(BUILTIN, 'app-main.js')); }
  else throw e;
}
