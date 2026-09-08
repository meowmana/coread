import { useEffect, useRef, useState } from 'react';
import { ReadingClock } from './reading-clock.mjs';
import { api } from './api';

const PREFIX = 'coread-checkpoint:';
const LEASE = 'coread-reader-owner';
let syncing: Promise<void> | null = null;
export function flushReading() {
    if (syncing) return syncing;
    syncing = (async () => {
        const keys = Object.keys(localStorage).filter(key => key.startsWith(PREFIX));
        for (const key of keys) {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            try {
                const value = JSON.parse(raw);
                await api.recordReadingCheckpoint(value.book_id, value);
                // Do not erase a newer checkpoint while an older request is in flight.
                if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
            } catch (e: any) {
                if (e.status === 409) window.dispatchEvent(new Event('coread-library-changed'));
                throw new Error(e.status === 409 ? '书库已经恢复，请刷新后继续阅读' : '时长已保存在此浏览器，联网后会自动同步');
            }
        }
    })().finally(() => { syncing = null; });
    return syncing;
}

export function useReadingClock(bookId: number | null, enabled: boolean) {
    const [seconds, setSeconds] = useState(0);
    const [error, setError] = useState('');
    const bookRef = useRef<number | null>(null);
    const totalRef = useRef(0);
    useEffect(() => {
        if (bookRef.current !== bookId) { bookRef.current = bookId; totalRef.current = 0; setSeconds(0); }
        const sync = () => { void flushReading().then(() => setError('')).catch(e => setError(e.message)); };
        sync();
        if (!bookId || !enabled) return;
        const owner = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let generation = localStorage.getItem('coread-library-generation');
        let disposed = false;
        let invalidated = false;
        api.readingState().then(state => {
            if (disposed) return;
            if (generation && generation !== state.generation) { invalidated = true; setError('书库已经恢复，请刷新后继续阅读'); return; }
            generation = state.generation;
            localStorage.setItem('coread-library-generation', generation!);
        }).catch(() => {});
        const clock = new ReadingClock(owner, bookId, (value: any) => {
            localStorage.setItem(`${PREFIX}${owner}:${value.reading_date}`, JSON.stringify({ ...value, generation }));
        });
        const base = totalRef.current;
        let active = false;
        let ticks = 0;
        const pause = () => {
            try { clock.pause(Date.now()); totalRef.current = base + clock.total / 1000; setSeconds(totalRef.current); }
            catch { setError('无法保存计时，请允许浏览器本地存储'); }
            active = false;
            try { if (JSON.parse(localStorage.getItem(LEASE) || 'null')?.owner === owner) localStorage.removeItem(LEASE); } catch {}
            sync();
        };
        const tick = () => {
            if (invalidated || !generation || document.visibilityState !== 'visible' || !document.hasFocus()) { pause(); return; }
            try {
                const now = Date.now();
                const lease = JSON.parse(localStorage.getItem(LEASE) || 'null');
                if (lease && lease.owner !== owner && lease.until > now) { clock.last = null; active = false; return; }
                localStorage.setItem(LEASE, JSON.stringify({ owner, until: now + 2500 }));
                if (!active) { clock.resume(now); active = true; }
                clock.sample(now);
                totalRef.current = base + clock.total / 1000;
                setSeconds(totalRef.current);
                if (++ticks % 5 === 0) sync();
            } catch { clock.last = null; active = false; setError('无法保存计时，请允许浏览器本地存储'); }
        };
        const visibility = () => document.visibilityState === 'visible' ? tick() : pause();
        const invalidate = () => { invalidated = true; clock.last = null; active = false; setError('书库已经恢复，请刷新后继续阅读'); };
        const ownership = (event: StorageEvent) => {
            if (event.key === LEASE && event.newValue && JSON.parse(event.newValue).owner !== owner) {
                // Discard the unconfirmed slice when another window takes ownership.
                clock.last = null; active = false;
            }
        };
        tick();
        const timer = window.setInterval(tick, 1000);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('blur', pause);
        window.addEventListener('focus', tick);
        window.addEventListener('pagehide', pause);
        window.addEventListener('pageshow', tick);
        window.addEventListener('online', tick);
        window.addEventListener('storage', ownership);
        window.addEventListener('coread-pause', pause);
        window.addEventListener('coread-library-changed', invalidate);
        return () => {
            disposed = true;
            clearInterval(timer); pause();
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('blur', pause);
            window.removeEventListener('focus', tick);
            window.removeEventListener('pagehide', pause);
            window.removeEventListener('pageshow', tick);
            window.removeEventListener('online', tick);
            window.removeEventListener('storage', ownership);
            window.removeEventListener('coread-pause', pause);
            window.removeEventListener('coread-library-changed', invalidate);
        };
    }, [bookId, enabled]);
    return { seconds, error };
}
