import React, { useState } from 'react';
import { api } from './api';
import { flushReading } from './useReadingClock';
import { duration } from './ReadingJournal';

const KEYS = ['coread-human-name', 'coread-ai-name', 'coread-font-size', 'coread-brightness', 'coread-night-mode'];
export default function BackupControls() {
    const [preview, setPreview] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    async function run(action: () => Promise<void>) {
        setBusy(true); setMessage('');
        try { await action(); } catch (e: any) { setMessage(e.message || '操作失败，原数据未改动'); }
        finally { setBusy(false); }
    }
    return <section className="backup-controls" aria-label="备份与恢复">
        <h3>备份与恢复</h3>
        <button disabled={busy} onClick={() => run(async () => {
            await flushReading();
            const settings = Object.fromEntries(KEYS.flatMap(key => localStorage.getItem(key) === null ? [] : [[key, localStorage.getItem(key)]]));
            const backup = await api.backup('export', { settings });
            const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = `coread-${backup.createdAt.slice(0, 10)}.json`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setMessage('备份已导出，请妥善保存。');
        })}>导出 coRead 备份</button>
        <label className="backup-import">导入备份
            <input aria-label="导入备份" type="file" accept=".json,application/json" disabled={busy} onChange={e => {
                const file = e.target.files?.[0]; e.target.value = ''; setPreview(null);
                if (file) void run(async () => {
                    if (file.size > 64 * 1024 * 1024) throw new Error('文件不能超过 64 MiB');
                    const data = JSON.parse(await file.text());
                    await flushReading();
                    setPreview(await api.backup('preview', data));
                });
            }} />
        </label>
        <p className="muted">包含书籍、封面、位置、批注、阅读记录及阅读设置；不包含密钥与隧道配置。最大 64 MiB。</p>
        {preview && <div className="backup-preview" role="region" aria-label="备份预览">
            <strong>恢复预览 · 版本 {preview.schemaVersion}</strong>
            <p>{preview.createdAt}<br />{preview.books} 本书 · {preview.comments} 条批注 · {preview.coversAndImages} 张图片<br />{preview.readingDays} 个阅读日 · {duration(preview.readingSeconds)}</p>
            <p>确认后将替换当前书库及阅读记录。请先导出当前数据；五分钟后预览失效。</p>
            <button disabled={busy} onClick={() => setPreview(null)}>取消</button>
            <button disabled={busy} onClick={() => run(async () => {
                const result = await api.backup('restore', { token: preview.token, confirmed: true });
                localStorage.setItem('coread-library-generation', result.generation);
                for (const key of Object.keys(localStorage)) if (/^(coread-checkpoint:|pagebreaks-|book-\d+-last-seen|coread-reader-owner)/.test(key)) localStorage.removeItem(key);
                for (const key of KEYS) {
                    if (result.settings[key] != null) localStorage.setItem(key, result.settings[key]);
                    else localStorage.removeItem(key);
                }
                // Different cache namespace avoids stale content with reused book identifiers.
                localStorage.setItem('coread-cache-generation', String(Date.now()));
                location.reload();
            })}>确认恢复并替换当前数据</button>
        </div>}
        {message && <p role="status">{message}</p>}
    </section>;
}
