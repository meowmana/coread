import React, { useState } from 'react';
import { localDay } from './reading-clock.mjs';
import './reliability.css';

export function duration(seconds: number) {
    const s = Math.floor(seconds || 0);
    return s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分` : s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

export default function ReadingJournal({ stats, loading, dark, close }: any) {
    const [selected, setSelected] = useState(localDay(Date.now()));
    const today = new Date(); today.setHours(12, 0, 0, 0);
    // Exactly twelve calendar weeks including this week, Monday first.
    const first = new Date(today);
    first.setDate(first.getDate() - (first.getDay() + 6) % 7 - 77);
    const days = Array.from({ length: 84 }, (_, index) => {
        const date = new Date(first); date.setDate(date.getDate() + index);
        const key = localDay(date.getTime());
        return { key, future: date > today, seconds: stats?.daily?.find((row: any) => row.reading_date === key)?.seconds || 0 };
    });
    const selectedRows = stats?.by_day?.filter((row: any) => row.reading_date === selected) || [];
    return <div className={`reliability-overlay ${dark ? 'dark' : ''}`} onClick={close}>
        <section className="reliability-panel" role="dialog" aria-modal="true" aria-label="阅读记录" onClick={e => e.stopPropagation()}>
            <header><h2>阅读记录</h2><button onClick={close} aria-label="关闭阅读记录">×</button></header>
            {loading ? <p>正在整理阅读足迹…</p> : !stats ? <p>暂时无法读取记录，请重试。</p> : <>
                <div className="journal-summary">
                    <div>今日<strong>{duration(stats.today_seconds)}</strong></div>
                    <div>累计<strong>{duration(stats.total_seconds)}</strong></div>
                    <div>连续<strong>{stats.currentStreak} 天</strong></div>
                </div>
                <h3>最近 12 周</h3>
                <div className="reading-calendar" aria-label="最近十二周阅读日历">
                    {days.map(day => <button key={day.key} disabled={day.future} aria-pressed={selected === day.key}
                        aria-label={`${day.key}，${duration(day.seconds)}`} title={`${day.key} · ${duration(day.seconds)}`}
                        data-level={day.seconds === 0 ? 0 : day.seconds < 600 ? 1 : day.seconds < 1800 ? 2 : day.seconds < 3600 ? 3 : 4}
                        onClick={() => setSelected(day.key)} />)}
                </div>
                <p className="muted">{days[0].key} — {localDay(today.getTime())} · 颜色越深，阅读越久</p>
                <h3>{selected} · {duration(selectedRows.reduce((sum: number, row: any) => sum + row.seconds, 0))}</h3>
                {selectedRows.length ? <ul>{selectedRows.map((row: any) => <li key={row.book_id}><span>{row.title}</span><strong>{duration(row.seconds)}</strong></li>)}</ul> : <p className="muted">这一天还没有阅读记录。</p>}
                <h3>书籍详情</h3>
                {stats.books.length ? stats.books.map((book: any) => <details key={book.id} className="journal-book">
                    <summary>{book.title} · {duration(book.total_seconds)}</summary>
                    <dl><dt>首次阅读</dt><dd>{book.first_read_at || '暂无记录'}</dd>
                        <dt>最近阅读</dt><dd>{book.last_read_at?.slice(0, 10) || '暂无记录'}</dd>
                        <dt>累计时长</dt><dd>{duration(book.total_seconds)}</dd>
                        <dt>完成日期</dt><dd>{book.finished_at || '尚未完成'}</dd></dl>
                </details>) : <p className="muted">打开一本书，开始记录阅读。</p>}
                <h3>共读批注</h3>
                {stats.notes.length ? stats.notes.map((note: any) => <article key={note.id} className="journal-book"><small>{note.from_who} · {note.book_title || note.reading_date || '阅读记录'}</small><p>{note.content}</p></article>) : <p className="muted">暂无阅读批注。</p>}
            </>}
        </section>
    </div>;
}
