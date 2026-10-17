const fs = require('node:fs');
const crypto = require('node:crypto');

function writeJson(file, value, io = fs) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const transient = new Set(['UNKNOWN', 'EBUSY', 'EACCES', 'EPERM']);
  try {
    // Never truncate the last completed checkpoint before its replacement exists.
    io.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(temporary, file); return; }
      catch (error) {
        if (!transient.has(error.code) || attempt >= 4) throw error;
        // Brief, bounded retries for Windows virus scanners/file watchers.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    // Concrete temporary file only; never remove directories or prior results.
    try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
module.exports = { writeJson };
