const BASE = window.location.origin;

// 共读室关门锁 owner key（task-1786030476040-meb33p）：与 app 端同 key，锁定期彤宝的 web 端照常放行
const ROOM_OWNER_KEY = 'xk-room-owner-f47ac10b58d2e619a3c4';

async function request(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-owner-key': ROOM_OWNER_KEY },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  fetchBooks: () => request('/v1/books'),
  fetchBookDetail: (bookId: number, page = 1) =>
    // 统一坐标制：服务端固定分页（BOOK_PER_PAGE），不再传 per_page
    request(`/v1/books/${bookId}?page=${page}`),
  fetchBookSlice: (bookId: number, start = 0, count = 30) =>
    request(`/v1/books/${bookId}/slice?start=${start}&count=${count}`),
  addBookComment: (bookId: number, data: any) =>
    request(`/v1/books/${bookId}/comment`, { method: 'POST', body: JSON.stringify(data) }),
  deleteBookComment: (commentId: number) =>
    request(`/v1/books/comment/${commentId}`, { method: 'DELETE' }),
  updateBookProgress: (bookId: number, page: number) =>
    request(`/v1/books/${bookId}/progress`, { method: 'PATCH', body: JSON.stringify({ page }) }),
  createBook: (data: any) =>
    request('/v1/books', { method: 'POST', body: JSON.stringify(data) }),
  // 二进制直传：文件原始字节直接做body，不再base64进JSON（省33%传输+双端编解码）
  uploadBookFile: (file: Blob, title: string, format: string) =>
    request(`/v1/books?${new URLSearchParams({ title, format })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-owner-key': ROOM_OWNER_KEY },
      body: file,
    }),
  touchBookOpen: (bookId: number) =>
    request(`/v1/books/${bookId}/open`, { method: 'POST' }),
  recordReadingTime: (bookId: number, seconds: number, readingDate: string) =>
    request(`/v1/books/${bookId}/reading-time`, {
      method: 'POST', keepalive: true,
      body: JSON.stringify({ seconds, reading_date: readingDate }),
    }),
  markBookFinished: (bookId: number, finishedDate: string) =>
    request(`/v1/books/${bookId}/finish`, {
      method: 'POST', body: JSON.stringify({ finished_date: finishedDate }),
    }),
  fetchReadingStats: (today: string) =>
    request(`/v1/reading-stats?today=${encodeURIComponent(today)}`),
  addReadingNote: (data: { content: string; book_id?: number; reading_date?: string; from_who?: string }) =>
    request('/v1/reading-notes', { method: 'POST', body: JSON.stringify(data) }),
  deleteBook: (bookId: number) =>
    request(`/v1/books/${bookId}`, { method: 'DELETE' }),
  fetchBookToc: (bookId: number) =>
    request(`/v1/books/${bookId}/toc`),
  exportBook: async (bookId: number, format = 'epub') => {
    const res = await fetch(`${BASE}/v1/books/${bookId}/export?format=${format}`, { headers: { 'x-owner-key': ROOM_OWNER_KEY } });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
  imageUrl: (bookId: number, filename: string) =>
    `${BASE}/v1/book-images/${bookId}/${filename}`,
  wishlistUrl: () => `${BASE}/v1/reading-wishlist`,
};
