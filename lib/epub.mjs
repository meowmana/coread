import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export function smartSplit(text) {
  const lines = text.split('\n');
  const indented = lines.filter(l => /^[　　]{1,2}/.test(l) || /^  /.test(l)).length;
  const nonEmpty = lines.filter(l => l.trim()).length;

  if (nonEmpty > 0 && indented > nonEmpty * 0.2) {
    const result = [];
    let buf = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { if (buf.trim()) { result.push(buf.trim()); buf = ''; } continue; }
      const isChapter = /^第[\d一二三四五六七八九十百千万]+[章节回]/.test(trimmed);
      const isIndented = /^[　　]{1,2}/.test(line) || /^  /.test(line);
      if ((isChapter || isIndented) && buf.trim()) { result.push(buf.trim()); buf = ''; }
      buf += (buf ? '\n' : '') + trimmed.replace(/^[　　]+/, '');
    }
    if (buf.trim()) result.push(buf.trim());
    return result.filter(p => p.length > 1);
  }

  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 1);
}

export function parseEpub(base64Data) {
  const AdmZip = require('adm-zip');
  const buf = Buffer.isBuffer(base64Data) ? base64Data : Buffer.from(base64Data, 'base64');
  const zip = new AdmZip(buf);

  const containerXml = zip.readAsText('META-INF/container.xml') || '';
  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  const opfPath = opfMatch ? opfMatch[1] : '';
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const epubImageMap = new Map();
  const imageEntries = zip.getEntries().filter(e => /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(e.entryName));
  for (const entry of imageEntries) {
    const fname = entry.entryName.split('/').pop();
    if (fname) epubImageMap.set(entry.entryName, fname);
  }

  const opfXml = opfPath ? zip.readAsText(opfPath) || '' : '';

  const manifest = {};
  const manifestRe = /<item\s([^>]*)\/?\s*>/g;
  let m;
  while ((m = manifestRe.exec(opfXml)) !== null) {
    const attrs = m[1];
    const id = (attrs.match(/id="([^"]*)"/)||[])[1];
    const href = (attrs.match(/href="([^"]*)"/)||[])[1];
    const type = (attrs.match(/media-type="([^"]*)"/)||[])[1];
    if (id && href && type) manifest[id] = { href, type };
  }

  const spineRefs = [];
  const spineRe = /<itemref\s[^>]*idref="([^"]*)"/g;
  while ((m = spineRe.exec(opfXml)) !== null) spineRefs.push(m[1]);

  const tocPageIds = new Set();
  const guideRe = /<reference\s[^>]*type="toc"[^>]*href="([^"]*)"/gi;
  while ((m = guideRe.exec(opfXml)) !== null) {
    const tocHref = m[1].split('#')[0];
    const tocId = Object.entries(manifest).find(([_, v]) => v.href === tocHref || decodeURIComponent(v.href) === tocHref);
    if (tocId) tocPageIds.add(tocId[0]);
  }
  for (const [id] of Object.entries(manifest)) {
    const attrs = opfXml.match(new RegExp(`<item[^>]*id="${id}"[^>]*`));
    if (attrs && /properties\s*=\s*"[^"]*nav[^"]*"/.test(attrs[0])) tocPageIds.add(id);
  }

  let epubCoverFile = null;
  const coverMeta = opfXml.match(/<meta\s[^>]*name="cover"[^>]*content="([^"]*)"/);
  if (coverMeta) {
    const coverId = coverMeta[1];
    const coverItem = manifest[coverId];
    if (coverItem && /image/i.test(coverItem.type)) {
      epubCoverFile = opfDir + decodeURIComponent(coverItem.href);
    }
  }
  if (!epubCoverFile) {
    const coverItem = Object.entries(manifest).find(([id, item]) => /cover/i.test(id) && /image/i.test(item.type));
    if (coverItem) epubCoverFile = opfDir + decodeURIComponent(coverItem[1].href);
  }

  const tocChapters = [];
  const ncxItem = Object.values(manifest).find(x => x.type === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxXml = zip.readAsText(opfDir + ncxItem.href) || '';
    const navRe = /<navPoint[^>]*>[\s\S]*?<text>([^<]*)<\/text>[\s\S]*?<content\s+src="([^"]*)"[\s\S]*?<\/navPoint>/g;
    while ((m = navRe.exec(ncxXml)) !== null) tocChapters.push({ title: m[1].trim(), src: m[2].split('#')[0] });
  }
  const tocSrcSet = new Set(tocChapters.map(c => c.src));

  const paragraphs = [];
  for (const ref of spineRefs) {
    if (tocPageIds.has(ref)) continue;
    const item = manifest[ref];
    if (!item || !item.type.includes('html')) continue;
    const filePath = opfDir + decodeURIComponent(item.href);
    const html = zip.readAsText(filePath) || '';

    const linkCount = (html.match(/<a\s/gi) || []).length;
    const plainLen = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
    if (linkCount > 5 && plainLen < linkCount * 30) continue;

    const hrefBase = item.href.split('/').pop() || item.href;
    if (tocSrcSet.has(hrefBase) || tocSrcSet.has(item.href)) {
      const ch = tocChapters.find(c => c.src === hrefBase || c.src === item.href);
      if (ch && ch.title) paragraphs.push('# ' + ch.title);
    }

    const htmlWithImgMarkers = html.replace(/<image\s[^>]*xlink:href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi, (_, src) => {
      const fname = decodeURIComponent(src).split('/').pop();
      let matched = null;
      for (const [, f] of epubImageMap) { if (f === fname) { matched = fname; break; } }
      return matched ? `\n\n[IMG:${matched}]\n\n` : '';
    }).replace(/<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, src) => {
      const decoded = decodeURIComponent(src);
      const resolvedSrc = decoded.startsWith('/') || decoded.startsWith('http') ? decoded : opfDir + decoded;
      const normSrc = resolvedSrc.replace(/^\.\//, '').replace(/\/\.\//g, '/');
      let matchedFile = null;
      for (const [epubPath, fname] of epubImageMap) {
        if (epubPath === normSrc || epubPath.endsWith('/' + decoded.split('/').pop()) || decoded.split('/').pop() === fname) {
          matchedFile = fname; break;
        }
      }
      return matchedFile ? `\n\n[IMG:${matchedFile}]\n\n` : '';
    });

    const text = htmlWithImgMarkers
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<title[\s\S]*?<\/title>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .trim();
    if (text) paragraphs.push(...smartSplit(text));
  }

  const EPUB_JUNK = /^(Cover|封面|插图|导航|书名页|制作信息|Contents|[A-Z0-9]{3,10}(-\d+)?)$/;
  const cleaned = paragraphs
    .filter(p => !EPUB_JUNK.test(p.trim()))
    .filter((p, i, a) => i === 0 || p.trim() !== a[i - 1].trim());

  return { paragraphs: cleaned, zip, epubImageMap, epubCoverFile, opfDir };
}

export function extractImages(zip, epubImageMap, paragraphs) {
  const usedImages = new Set();
  for (const p of paragraphs) {
    const m = p.match(/\[IMG:([^\]]+)\]/);
    if (m) usedImages.add(m[1]);
  }
  const images = new Map();
  for (const [epubPath, fname] of epubImageMap) {
    if (usedImages.has(fname)) {
      try {
        const entry = zip.getEntry(epubPath);
        if (entry) images.set(fname, entry.getData());
      } catch {}
    }
  }
  return images;
}

export function extractCover(zip, epubCoverFile) {
  if (!epubCoverFile) return null;
  try {
    const entry = zip.getEntry(epubCoverFile);
    if (entry) {
      const ext = epubCoverFile.split('.').pop() || 'jpg';
      return { name: `cover.${ext}`, data: entry.getData() };
    }
  } catch {}
  return null;
}
