import { test, expect } from '@playwright/test';

async function openReader(page) {
  await page.goto('/');
  await page.getByText('可靠性测试书', { exact: true }).click();
  await expect(page.getByRole('status')).toContainText('本次阅读');
}
async function closeReader(page) {
  const surface = page.getByTestId('reader-surface');
  const box = await surface.boundingBox();
  await surface.click({ position: { x: Math.floor(box.width / 2), y: 120 } });
  await expect(page.getByRole('button', { name: '关闭书籍' })).toHaveCSS('pointer-events', 'auto');
  await page.getByRole('button', { name: '关闭书籍' }).click();
}
for (const scenario of [
  { name: '手机竖屏', width: 390, height: 844, font: 14 },
  { name: '手机横屏', width: 844, height: 390, font: 14 },
  { name: '桌面', width: 1280, height: 900, font: 14 },
  { name: '字号变化', width: 390, height: 844, font: 22 },
]) test(`浏览器分页语义：${scenario.name}`, async ({ page, request }) => {
  await page.setViewportSize({ width: scenario.width, height: scenario.height });
  await page.addInitScript(font => localStorage.setItem('coread-font-size', String(font)), scenario.font);
  const pageTable = page.waitForRequest(req => req.url().endsWith('/pagination') && req.method() === 'POST');
  await openReader(page);
  const payload = (await pageTable).postDataJSON();
  expect(payload.breaks.length).toBeGreaterThan(1);
  expect(payload.viewport.font_size).toBe(scenario.font);
  await expect.poll(async () => (await (await request.get('/v1/books')).json()).books[0].pagination_source).toBe('browser');
  const book = (await (await request.get('/v1/books')).json()).books[0];
  expect(book.current_paragraph_idx % 3).toBe(0);
  expect(book.current_display_page).toBeGreaterThan(0);
  const detail = await (await request.get(`/v1/books/1?page=${book.current_display_page}`)).json();
  expect(detail.paragraphs.length).toBeGreaterThan(0);
  expect(detail.paragraphs[0].idx).toBe(payload.breaks[book.current_display_page - 1].paragraph_idx);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('窗口缩放重新测量显示页，段落索引保持稳定', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const first = page.waitForRequest(r => r.url().endsWith('/pagination') && r.method() === 'POST');
  await openReader(page);
  const portrait = (await first).postDataJSON();
  const next = page.waitForRequest(r => r.url().endsWith('/pagination') && r.method() === 'POST');
  await page.setViewportSize({ width: 1180, height: 780 });
  const desktop = (await next).postDataJSON();
  expect(desktop.paragraph_ids).toEqual(portrait.paragraph_ids);
  expect(desktop.viewport.width).not.toBe(portrait.viewport.width);
  expect(desktop.breaks.length).not.toBe(portrait.breaks.length);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('计时失焦暂停，刷新不重复，关闭书籍停止', async ({ page, request }) => {
  await openReader(page);
  await page.waitForTimeout(3200);
  expect(await page.getByRole('status').textContent()).not.toContain('本次阅读 0 秒');
  await page.evaluate(() => {
    Object.defineProperties(document, {
      visibilityState: { configurable: true, value: 'hidden' },
      hidden: { configurable: true, value: true },
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
  const paused = await page.getByRole('status').textContent();
  await page.waitForTimeout(2100);
  expect(await page.getByRole('status').textContent()).toBe(paused);
  await page.evaluate(() => {
    Object.defineProperties(document, {
      visibilityState: { configurable: true, value: 'visible' },
      hidden: { configurable: true, value: false },
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
  await closeReader(page);
  await page.getByRole('button', { name: '阅读记录' }).click();
  await expect(page.getByRole('dialog', { name: '阅读记录' })).toBeVisible();
  const stats = await (await request.get('/v1/reading-stats')).json();
  await page.waitForTimeout(1200);
  expect((await (await request.get('/v1/reading-stats')).json()).total_seconds).toBe(stats.total_seconds);
  await page.reload(); await page.waitForTimeout(1000);
  expect((await (await request.get('/v1/reading-stats')).json()).total_seconds).toBe(stats.total_seconds);
});
test('深色统计与备份预览可取消，手机布局不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.addInitScript(() => localStorage.setItem('coread-night-mode', 'true'));
  await page.goto('/');
  await page.getByRole('button', { name: '阅读记录' }).click();
  await expect(page.locator('.reading-calendar button')).toHaveCount(84);
  await expect(page.locator('.reliability-overlay')).toHaveClass(/dark/);
  await expect(page.locator('.reliability-panel')).toHaveCSS('background-color', 'rgb(36, 33, 43)');
  await page.getByRole('button', { name: '关闭阅读记录' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 coRead 备份' }).click();
  const exported = await download;
  await page.getByLabel('导入备份', { exact: true }).setInputFiles(await exported.path());
  await expect(page.getByRole('region', { name: '备份预览' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('region', { name: '备份预览' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
