import { exportBackup, previewBackup, restoreBackup, MAX_BACKUP_BYTES } from './backup.mjs';

export async function handleBackupRequest(req, res) {
  if (!['/v1/backup/export', '/v1/backup/preview', '/v1/backup/restore'].includes(req.url)) return false;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // Deliberately outside the legacy wildcard-CORS API; browsers must use same-origin JSON.
  if (req.method !== 'POST' || req.headers['x-coread-backup'] !== '1' ||
      !String(req.headers['content-type'] || '').startsWith('application/json')) {
    send(403, { error: 'Same-origin backup request required' }); return true;
  }
  try {
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      send(403, { error: 'Cross-origin backup request rejected' }); return true;
    }
    if (Number(req.headers['content-length']) > MAX_BACKUP_BYTES) throw Object.assign(new Error('Backup exceeds 64 MiB'), { status: 413 });
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BACKUP_BYTES) throw Object.assign(new Error('Backup exceeds 64 MiB'), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON backup'), { status: 400 }); }
    if (req.url.endsWith('/export')) send(200, exportBackup(body.settings));
    else if (req.url.endsWith('/preview')) send(200, previewBackup(body));
    else send(200, restoreBackup(body.token, body.confirmed));
  } catch (error) { send(error.status || 400, { error: error.status ? error.message : 'Backup operation failed; original data was preserved' }); }
  return true;
}
