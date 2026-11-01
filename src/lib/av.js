'use strict';
// Optional malware scan (EMAIL-008). Set AV_COMMAND, for example "clamscan --no-summary".
// Without it files are stored as "not_scanned" and the interface says so; nothing pretends to be scanned.
const { execFile } = require('child_process');
const config = require('../config');

function scan(filePath) {
  return new Promise((resolve) => {
    if (!config.avCommand) return resolve('not_scanned');
    const parts = config.avCommand.split(/\s+/).filter(Boolean);
    execFile(parts[0], [...parts.slice(1), filePath], { timeout: 60000 }, (err) => {
      if (!err) return resolve('clean');
      if (err.code === 1) return resolve('infected');
      console.error('[av] scanner error:', err.message);
      return resolve('not_scanned');
    });
  });
}
module.exports = { scan };
