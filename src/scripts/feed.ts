import type { Category, FeedSource } from '../data/sources';
import { DEFAULT_SOURCES } from '../data/sources';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Article {
    title: string;
    link: string;
    desc: string;
    date: Date;
    source: string;
    cat: Category;
    cve: string | null;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | null;
}

type SourceStatus = 'load' | 'ok' | 'err';

// ─── State ────────────────────────────────────────────────────────────────────

let allArticles: Article[] = [];
let currentFilter: Category | 'all' = 'all';
let currentSearch = '';
let currentPage = 1;
const PAGE_SIZE = 4;
let sources: FeedSource[] = [];
let sourceStatuses: Map<string, SourceStatus> = new Map();
let errorCount = 0;
let lastRefreshTime: Date | null = null;
let isRefreshing = false;

// ─── CORS Proxies ─────────────────────────────────────────────────────────────

// Proxy strategies — tried in order, first success wins
const PROXY_STRATEGIES: Array<{
    buildUrl: (url: string) => string;
    extractText: (json: unknown, rawText: string) => string;
}> = [
        {
            // allorigins /raw returns the body directly (no JSON wrapper), with CORS headers
            buildUrl: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            extractText: (_json, rawText) => rawText,
        },
        {
            // corsproxy.io free tier — updated URL format /?url=
            buildUrl: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
            extractText: (_json, rawText) => rawText,
        },
        {
            // allorigins /get JSON fallback — parse .contents (HTML-encoded inside JSON, needs unescape)
            buildUrl: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
            extractText: (json) => {
                const j = json as { contents?: string };
                const raw = j?.contents ?? '';
                // The XML is HTML-escaped when stored in the JSON wrapper — unescape it
                return raw
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'");
            },
        },
        {
            // thingproxy — open CORS proxy, good fallback
            buildUrl: (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
            extractText: (_json, rawText) => rawText,
        },
    ];

const PROXY_TIMEOUTS = [8000, 8000, 12000, 12000];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCVE(text: string): string | null {
    const m = text.match(/CVE-\d{4}-\d+/i);
    return m ? m[0].toUpperCase() : null;
}

function extractSeverity(text: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | null {
    const t = text.toLowerCase();
    if (/critical|0-day|zero-day|actively exploited/.test(t)) return 'CRITICAL';
    if (/rce|remote code|authentication bypass/.test(t)) return 'HIGH';
    if (/xss|csrf|disclosure/.test(t)) return 'MEDIUM';
    return null;
}

function timeAgo(date: Date): string {
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return 'just now';
}

function getTextContent(el: Element | null): string {
    return el ? (el.textContent?.trim() ?? '') : '';
}

// Extract link — handle both RSS <link>text</link> and Atom <link href="..."/>
function extractLink(item: Element): string {
    // Atom: <link rel="alternate" href="..."/> or <link href="..."/>
    const atomLink = item.querySelector('link[href]');
    if (atomLink) return atomLink.getAttribute('href') ?? '#';

    // RSS: <link>https://...</link>
    const rssLink = item.querySelector('link');
    if (rssLink?.textContent?.trim()) return rssLink.textContent.trim();

    // Fallback: <id> in Atom feeds sometimes contains a URL
    const id = item.querySelector('id');
    if (id?.textContent?.startsWith('http')) return id.textContent.trim();

    return '#';
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseXML(xmlString: string, source: FeedSource): Article[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    const items = Array.from(doc.querySelectorAll('item, entry'));
    const articles: Article[] = [];

    for (const item of items) {
        const title = getTextContent(item.querySelector('title'));
        if (!title) continue;

        // Link: prefer Atom <link href="..."> then RSS <link>text</link>
        const link = extractLink(item);

        // Description
        const desc = getTextContent(
            item.querySelector('description') ??
            item.querySelector('summary') ??
            item.querySelector('content')
        );

        // Date
        const dateStr = getTextContent(
            item.querySelector('pubDate') ??
            item.querySelector('published') ??
            item.querySelector('updated')
        );
        const date = dateStr ? new Date(dateStr) : new Date();

        const combined = title + ' ' + desc;
        const cve = extractCVE(combined);
        const severity = extractSeverity(combined);

        articles.push({
            title,
            link,
            desc,
            date: isNaN(date.getTime()) ? new Date() : date,
            source: source.name,
            cat: source.cat,
            cve,
            severity,
        });
    }

    return articles;
}

// ─── Fetch single feed ────────────────────────────────────────────────────────

async function fetchFeed(source: FeedSource): Promise<Article[]> {
    setSourceStatus(source.url, 'load');

    for (let strategyIndex = 0; strategyIndex < PROXY_STRATEGIES.length; strategyIndex++) {
        const strategy = PROXY_STRATEGIES[strategyIndex];
        try {
            const proxyUrl = strategy.buildUrl(source.url);
            const res = await fetch(proxyUrl, {
                signal: AbortSignal.timeout(PROXY_TIMEOUTS[strategyIndex] ?? 10000),
                headers: { Accept: 'application/xml, text/xml, application/rss+xml, */*' },
            });
            if (!res.ok) continue;

            const rawText = await res.text();

            // Extract XML text — handle JSON-wrapped responses (allorigins /get)
            let xmlText = rawText;
            if (rawText.trimStart().startsWith('{')) {
                try {
                    const json = JSON.parse(rawText);
                    xmlText = strategy.extractText(json, rawText);
                } catch {
                    xmlText = rawText;
                }
            } else {
                xmlText = strategy.extractText(null, rawText);
            }

            if (!xmlText || xmlText.length < 50) continue;

            // Check for XML parse error before handing off
            const probe = new DOMParser().parseFromString(xmlText, 'text/xml');
            if (probe.querySelector('parsererror')) continue;

            const articles = parseXML(xmlText, source);
            if (!articles.length) continue;

            setSourceStatus(source.url, 'ok');
            return articles;
        } catch {
            // try next proxy
        }
    }

    // All proxies failed — try direct (may work for non-CORS-restricted feeds)
    try {
        const res = await fetch(source.url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
            const text = await res.text();
            const articles = parseXML(text, source);
            setSourceStatus(source.url, 'ok');
            return articles;
        }
    } catch {
        // fallthrough
    }

    setSourceStatus(source.url, 'err');
    errorCount++;
    return [];
}

// ─── Fetch all feeds ──────────────────────────────────────────────────────────

// Semaphore: max N concurrent fetches at once, accumulate articles progressively
async function fetchWithConcurrency(
    srcs: FeedSource[],
    concurrency: number,
    onBatchDone: () => void
): Promise<void> {
    const queue = [...srcs];

    async function worker(): Promise<void> {
        while (queue.length > 0) {
            const src = queue.shift();
            if (!src) break;
            const arts = await fetchFeed(src);
            for (const a of arts) {
                if (a.link && !allArticles.some((x) => x.link === a.link)) {
                    allArticles.push(a);
                }
            }
            onBatchDone();
        }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.allSettled(workers);
}

async function fetchAllFeeds(): Promise<void> {
    if (isRefreshing) return;
    isRefreshing = true;
    allArticles = [];
    errorCount = 0;
    currentPage = 1;

    updateRefreshBtn(true);
    showToast('Fetching feeds…', 'ok');

    // Show loading state immediately
    const container = document.getElementById('feed-container');
    if (container) {
        container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-24 text-[var(--color-text-dim)]">
        <div class="text-4xl mb-4">◈</div>
        <p class="text-sm">Fetching feeds…</p>
        <p class="text-xs mt-1 opacity-60">Loading sources<span class="terminal-cursor"></span></p>
      </div>`;
    }

    // Fetch with concurrency=4, render partial results after each source resolves
    await fetchWithConcurrency(sources, 4, () => {
        updateLoadingProgress();
        allArticles.sort((a, b) => b.date.getTime() - a.date.getTime());
        renderFeed();
        updateTicker();
        updateCVEPanel();
    });

    // Final render with complete data
    allArticles.sort((a, b) => b.date.getTime() - a.date.getTime());
    lastRefreshTime = new Date();
    isRefreshing = false;
    updateRefreshBtn(false);
    renderAll();
    updateTicker();
    updateStats();
    showToast(`Loaded ${allArticles.length} articles`, 'ok');
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function getFilteredArticles(): Article[] {
    let list = allArticles;

    if (currentFilter !== 'all') {
        list = list.filter((a) => a.cat === currentFilter);
    }
    if (currentSearch.trim()) {
        const q = currentSearch.toLowerCase();
        list = list.filter(
            (a) =>
                a.title.toLowerCase().includes(q) ||
                a.source.toLowerCase().includes(q) ||
                (a.cve && a.cve.toLowerCase().includes(q))
        );
    }
    return list;
}

function renderAll(): void {
    renderFeed();
    updateCVEPanel();
    updateTrendingTags();
}

function renderFeed(): void {
    const filtered = getFilteredArticles();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    const container = document.getElementById('feed-container');
    if (!container) return;

    if (!filtered.length) {
        container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-24 text-[var(--color-text-dim)]">
        <div class="text-4xl mb-4">◈</div>
        <p class="text-sm">No articles found.</p>
        <p class="text-xs mt-1 opacity-60">Try changing filters or refreshing.</p>
      </div>`;
        renderPagination(0, 1);
        return;
    }

    const countEl = document.getElementById('article-count');
    if (countEl) countEl.textContent = `${filtered.length} articles`;

    container.innerHTML = pageItems.map((art, i) => buildArticleCard(art, start + i)).join('');
    (window as any)._articleMap = filtered;

    // Attach modal open listeners
    container.querySelectorAll<HTMLElement>('[data-article-idx]').forEach((el) => {
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).tagName === 'A') return;
            const idx = Number(el.dataset.articleIdx);
            openModal((window as any)._articleMap[idx]);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const idx = Number(el.dataset.articleIdx);
                openModal((window as any)._articleMap[idx]);
            }
        });
    });

    renderPagination(filtered.length, totalPages);
    updateFilterCounts();
}

function renderPagination(total: number, totalPages: number): void {
    const feedContainer = document.getElementById('feed-container');
    const parent = feedContainer?.parentElement;
    if (!parent) return;

    let bar = document.getElementById('pagination-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'pagination-bar';
        parent.appendChild(bar);
    }

    if (totalPages <= 1) {
        bar.innerHTML = '';
        return;
    }

    // Build page number list: always show first, last, current ±2, with ellipsis
    const pages: (number | '...')[] = [];
    for (let p = 1; p <= totalPages; p++) {
        if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2) {
            pages.push(p);
        } else if (pages[pages.length - 1] !== '...') {
            pages.push('...');
        }
    }

    const btnClass = (p: number) =>
        `page-btn${p === currentPage ? ' active' : ''}`;

    bar.innerHTML = `
    <div class="pagination">
      <button class="page-nav" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>
        ← PREV
      </button>
      <div class="page-numbers">
        ${pages.map(p =>
        p === '...'
            ? `<span class="page-ellipsis">…</span>`
            : `<button class="${btnClass(p as number)}" onclick="goToPage(${p})">${p}</button>`
    ).join('')}
      </div>
      <button class="page-nav" onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>
        NEXT →
      </button>
    </div>
    <div class="page-info">
      page ${currentPage} of ${totalPages} · ${total} total
    </div>
  `;
}

function goToPage(page: number): void {
    const filtered = getFilteredArticles();
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    renderFeed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateLoadingProgress(): void {
    const done = sources.filter((s) => {
        const st = sourceStatuses.get(s.url);
        return st === 'ok' || st === 'err';
    }).length;
    const total = sources.length;
    const el = document.getElementById('article-count');
    if (el && done < total) {
        el.textContent = `${allArticles.length} articles · loading ${done}/${total} sources…`;
    }
}

function severityColor(s: Article['severity']): string {
    if (s === 'CRITICAL') return 'var(--color-red)';
    if (s === 'HIGH') return 'var(--color-amber)';
    if (s === 'MEDIUM') return 'var(--color-cyan)';
    return 'transparent';
}

function catBadgeStyle(cat: Category): string {
    if (cat === 'ai') return 'color:var(--color-cyan);border-color:var(--color-cyan)';
    if (cat === 'sec') return 'color:var(--color-red);border-color:var(--color-red)';
    return 'color:var(--color-amber);border-color:var(--color-amber)';
}

function catLabel(cat: Category): string {
    if (cat === 'ai') return 'AI';
    if (cat === 'sec') return 'SEC';
    return 'BUG BOUNTY';
}

function borderColor(cat: Category): string {
    if (cat === 'ai') return 'var(--color-cyan)';
    if (cat === 'sec') return 'var(--color-red)';
    return 'var(--color-amber)';
}

function buildArticleCard(a: Article, i: number): string {
    const truncDesc = a.desc.replace(/<[^>]*>/g, '').slice(0, 160);
    const bColor = borderColor(a.cat);

    return `
  <article
    class="article-card relative cursor-pointer select-none"
    data-article-idx="${i}"
    tabindex="0"
    role="button"
    aria-label="Read: ${escapeHtml(a.title)}"
    style="
      background:var(--color-bg2);
      border:1px solid var(--color-border);
      border-left:3px solid ${bColor};
      padding:14px 16px;
      margin-bottom:8px;
      border-radius:2px;
      transition:transform .15s ease, border-color .15s ease;
    "
    onmouseenter="this.style.transform='translateX(2px)';this.style.borderLeftColor='${bColor}';this.style.borderColor='var(--color-border2)'"
    onmouseleave="this.style.transform='';this.style.borderColor='var(--color-border)'"
  >
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      <span style="${catBadgeStyle(a.cat)};border:1px solid;font-size:10px;padding:0 5px;border-radius:2px;font-weight:700;letter-spacing:.05em">${catLabel(a.cat)}</span>
      ${a.cve ? `<span style="color:var(--color-amber);font-size:10px;font-weight:700">${escapeHtml(a.cve)}</span>` : ''}
      ${a.severity ? `<span style="background:${severityColor(a.severity)};color:#000;font-size:9px;font-weight:800;padding:0 5px;border-radius:2px;letter-spacing:.08em">${a.severity}</span>` : ''}
      <span class="ml-auto" style="color:var(--color-text-dim);font-size:11px">${escapeHtml(a.source)}</span>
      <span style="color:var(--color-text-dim);font-size:11px">${timeAgo(a.date)}</span>
    </div>
    <h2 style="color:var(--color-text-bright);font-size:13px;font-weight:600;line-height:1.4;margin-bottom:6px">${escapeHtml(a.title)}</h2>
    ${truncDesc ? `<p style="color:var(--color-text-dim);font-size:12px;line-height:1.5;margin-bottom:8px">${escapeHtml(truncDesc)}${a.desc.length > 160 ? '…' : ''}</p>` : ''}
    ${a.link ? `<a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--color-green-dim);font-size:11px;text-decoration:none;letter-spacing:.05em" onclick="event.stopPropagation()">→ OPEN ARTICLE</a>` : ''}
  </article>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(a: Article): void {
    const existing = document.getElementById('article-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'article-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', a.title);
    modal.style.cssText = `
    position:fixed;inset:0;z-index:10000;
    background:rgba(0,0,0,.85);
    display:flex;align-items:center;justify-content:center;padding:24px;
    animation:fade-in .15s ease;
  `;

    modal.innerHTML = `
    <div style="
      background:var(--color-bg2);
      border:1px solid var(--color-border2);
      border-left:3px solid ${borderColor(a.cat)};
      max-width:640px;width:100%;max-height:80vh;
      overflow-y:auto;padding:24px;border-radius:2px;position:relative;
    ">
      <button id="modal-close" aria-label="Close modal"
        style="position:absolute;top:12px;right:12px;background:none;border:1px solid var(--color-border2);
        color:var(--color-text-dim);cursor:pointer;font-family:var(--font-mono);font-size:12px;padding:2px 8px;border-radius:2px;"
      >ESC ✕</button>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <span style="${catBadgeStyle(a.cat)};border:1px solid;font-size:10px;padding:0 5px;border-radius:2px;font-weight:700">${catLabel(a.cat)}</span>
        ${a.cve ? `<span style="color:var(--color-amber);font-size:10px;font-weight:700">${escapeHtml(a.cve)}</span>` : ''}
        ${a.severity ? `<span style="background:${severityColor(a.severity)};color:#000;font-size:9px;font-weight:800;padding:0 5px;border-radius:2px">${a.severity}</span>` : ''}
      </div>
      <h2 style="color:var(--color-text-bright);font-size:15px;font-weight:700;line-height:1.4;margin-bottom:8px">${escapeHtml(a.title)}</h2>
      <div style="color:var(--color-text-dim);font-size:12px;margin-bottom:12px">${escapeHtml(a.source)} · ${timeAgo(a.date)} · ${a.date.toLocaleDateString()}</div>
      <div style="color:var(--color-text);font-size:13px;line-height:1.7;margin-bottom:16px">${escapeHtml(a.desc.replace(/<[^>]*>/g, ''))}</div>
      ${a.link ? `<a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer"
        style="display:inline-block;border:1px solid var(--color-green-dim);color:var(--color-green-dim);
        padding:6px 14px;font-family:var(--font-mono);font-size:12px;text-decoration:none;border-radius:2px;
        letter-spacing:.05em">→ OPEN ARTICLE</a>` : ''}
    </div>`;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector<HTMLButtonElement>('#modal-close');
    closeBtn?.focus();

    const close = () => modal.remove();

    closeBtn?.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
}

// ─── Ticker ───────────────────────────────────────────────────────────────────

function updateTicker(): void {
    const el = document.getElementById('ticker-content');
    if (!el) return;
    const titles = allArticles.slice(0, 15).map((a) => escapeHtml(a.title));
    el.innerHTML = titles.map((t) => `<span class="ticker-item">${t}</span>`).join(
        '<span style="margin:0 24px;color:var(--color-green-dim)">◆</span>'
    );
}

// ─── Filter counts ────────────────────────────────────────────────────────────

function updateFilterCounts(): void {
    const counts: Record<string, number> = { all: allArticles.length, ai: 0, sec: 0, bb: 0 };
    for (const a of allArticles) counts[a.cat]++;
    (['all', 'ai', 'sec', 'bb'] as const).forEach((k) => {
        const el = document.getElementById(`count-${k}`);
        if (el) el.textContent = String(counts[k]);
    });
}

// ─── CVE Panel ────────────────────────────────────────────────────────────────

function updateCVEPanel(): void {
    const panel = document.getElementById('cve-panel');
    if (!panel) return;

    const severity: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0 };
    for (const a of allArticles) {
        if (a.severity) severity[a.severity]++;
    }
    const total = severity.CRITICAL + severity.HIGH + severity.MEDIUM || 1;

    const rows = [
        { label: 'CRITICAL', color: 'var(--color-red)', count: severity.CRITICAL },
        { label: 'HIGH', color: 'var(--color-amber)', count: severity.HIGH },
        { label: 'MEDIUM', color: 'var(--color-cyan)', count: severity.MEDIUM },
    ];

    panel.innerHTML = rows.map((r) => {
        const pct = Math.round((r.count / total) * 100);
        return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
        <span style="color:${r.color}">${r.label}</span>
        <span style="color:var(--color-text-dim)">${r.count}</span>
      </div>
      <div style="height:4px;background:var(--color-border);border-radius:2px;overflow:hidden">
        <div style="height:100%;background:${r.color};border-radius:2px;width:${pct}%;transition:width .4s ease"></div>
      </div>
    </div>`;
    }).join('');
}

// ─── Trending tags ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'it', 'this',
    'that', 'are', 'was', 'be', 'has', 'had', 'by', 'from', 'with', 'as', 'will', 'can',
    'not', 'its', 'but', 'have', 'new', 'more', 'how', 'what', 'when', 'who', 'all', 'one',
    'also', 'been', 'they', 'their', 'our', 'your', 'about', 'than', 'just', 'we', 'you',
    'he', 'she', 'after', 'over', 'may', 'could', 'would', 'should', 'do', 'does', 'did',
    'between', 'into', 'up', 'out', 'if', 'so', 'any', 'get', 'use', 'now', 'no', 'via',
    'using', 'see', 'says', 'data', 'two', 'three',
]);

function updateTrendingTags(): void {
    const el = document.getElementById('trending-tags');
    if (!el) return;

    const freq = new Map<string, number>();
    for (const a of allArticles) {
        const words = (a.title + ' ' + a.desc)
            .toLowerCase()
            .replace(/<[^>]*>/g, '')
            .match(/[a-z][a-z0-9-]{2,}/g) ?? [];
        for (const w of words) {
            if (!STOP_WORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
        }
    }

    const top20 = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

    el.innerHTML = top20.map(([word, count]) => `
    <button
      style="background:var(--color-bg3);border:1px solid var(--color-border);color:var(--color-text-dim);
      font-family:var(--font-mono);font-size:11px;padding:2px 8px;border-radius:2px;cursor:pointer;
      transition:color .15s,border-color .15s"
      onmouseenter="this.style.color='var(--color-green)';this.style.borderColor='var(--color-green-dim)'"
      onmouseleave="this.style.color='var(--color-text-dim)';this.style.borderColor='var(--color-border)'"
      onclick="window.__setSearch('${escapeHtml(word)}')"
    >${escapeHtml(word)} <span style="opacity:.5">${count}</span></button>
  `).join('');
}

// ─── Sources list ─────────────────────────────────────────────────────────────

function renderSourcesList(): void {
    const el = document.getElementById('sources-list');
    if (!el) return;

    el.innerHTML = sources.map((s, i) => {
        const status = sourceStatuses.get(s.url) ?? 'load';
        const dotColor = status === 'ok' ? 'var(--color-green)' : status === 'err' ? 'var(--color-red)' : 'var(--color-amber)';
        const blink = status === 'load' ? 'animation:blink 1s infinite' : '';
        const catColor = s.cat === 'ai' ? 'var(--color-cyan)' : s.cat === 'sec' ? 'var(--color-red)' : 'var(--color-amber)';
        const retryBtn = status === 'err'
            ? `<button class="retry-btn" onclick="window.__retrySingle(${i})" title="Retry">⟳</button>`
            : '';
        return `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--color-border)">
      <span style="width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0;${blink}"></span>
      <span style="color:var(--color-text-dim);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span style="color:${catColor};font-size:9px;font-weight:700;flex-shrink:0">${s.cat.toUpperCase()}</span>
      ${retryBtn}
    </div>`;
    }).join('');

    const okCount = sources.filter((s) => (sourceStatuses.get(s.url) ?? 'load') === 'ok').length;
    const statEl = document.getElementById('stat-sources');
    if (statEl) statEl.textContent = String(okCount);
}

function setSourceStatus(url: string, status: SourceStatus): void {
    sourceStatuses.set(url, status);
    renderSourcesList();
}

async function retrySingle(index: number): Promise<void> {
    const src = sources[index];
    if (!src) return;
    sourceStatuses.set(src.url, 'load');
    renderSourcesList();
    const arts = await fetchFeed(src);
    for (const a of arts) {
        if (!allArticles.some((x) => x.link === a.link)) allArticles.push(a);
    }
    allArticles.sort((a, b) => b.date.getTime() - a.date.getTime());
    renderAll();
    updateStats();
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function updateStats(): void {
    const setEl = (id: string, val: string) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    setEl('stat-total', String(allArticles.length));
    setEl('stat-sources', String(sources.length));
    setEl('stat-errors', String(errorCount));
    setEl('stat-time', lastRefreshTime ? lastRefreshTime.toLocaleTimeString() : '—');
}

// ─── Refresh button ───────────────────────────────────────────────────────────

function updateRefreshBtn(loading: boolean): void {
    const btn = document.getElementById('refresh-btn');
    if (!btn) return;
    btn.textContent = loading ? '⟳ REFRESHING…' : '⟳ REFRESH';
    (btn as HTMLButtonElement).disabled = loading;
    btn.style.opacity = loading ? '0.5' : '1';
}

// ─── Toast ────────────────────────────────────────────────────────────────────

export function showToast(msg: string, type: 'ok' | 'error'): void {
    const t = document.createElement('div');
    t.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:20000;
    background:${type === 'ok' ? 'var(--color-bg3)' : '#2a0a0a'};
    border:1px solid ${type === 'ok' ? 'var(--color-border2)' : 'var(--color-red)'};
    color:${type === 'ok' ? 'var(--color-green)' : 'var(--color-red)'};
    font-family:var(--font-mono);font-size:12px;padding:8px 16px;border-radius:2px;
    animation:toast-in .2s ease;
  `;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}

// ─── Custom sources persistence ───────────────────────────────────────────────

const LS_KEY = '0xfeed_sources';

function loadCustomSources(): FeedSource[] {
    try {
        return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as FeedSource[];
    } catch {
        return [];
    }
}

function saveCustomSources(custom: FeedSource[]): void {
    localStorage.setItem(LS_KEY, JSON.stringify(custom));
}

export function addCustomSource(name: string, url: string, cat: Category): boolean {
    if (!name || !url) return false;
    if (sources.some((s) => s.url === url)) return false;
    try { new URL(url); } catch { return false; }

    const src: FeedSource = { name, url, cat };
    sources.push(src);
    sourceStatuses.set(url, 'load');

    const custom = loadCustomSources().filter((s) => !DEFAULT_SOURCES.some((d) => d.url === s.url));
    custom.push(src);
    saveCustomSources(custom);

    renderSourcesList();
    fetchFeed(src).then((arts) => {
        for (const a of arts) {
            if (!allArticles.some((x) => x.link === a.link)) allArticles.push(a);
        }
        allArticles.sort((a, b) => b.date.getTime() - a.date.getTime());
        renderAll();
        updateTicker();
        updateStats();
        showToast(`Added source: ${name}`, 'ok');
    });
    return true;
}

// ─── Filter & search wiring ───────────────────────────────────────────────────

function wireFilters(): void {
    (['all', 'ai', 'sec', 'bb'] as const).forEach((f) => {
        const btn = document.getElementById(`filter-${f}`);
        if (!btn) return;
        btn.addEventListener('click', () => setFilter(f));
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f); }
        });
    });
}

function setFilter(f: Category | 'all'): void {
    currentFilter = f;
    currentPage = 1;
    document.querySelectorAll<HTMLElement>('[data-filter]').forEach((btn) => {
        const active = btn.dataset.filter === f;
        btn.style.color = active ? 'var(--color-green)' : 'var(--color-text-dim)';
        btn.style.borderColor = active ? 'var(--color-green-dim)' : 'var(--color-border)';
        btn.style.background = active ? 'var(--color-green-dark)' : 'transparent';
        btn.setAttribute('aria-pressed', String(active));
    });
    renderAll();
}

function wireSearch(): void {
    const input = document.getElementById('search-input') as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener('input', () => {
        currentSearch = input.value;
        currentPage = 1;
        renderAll();
    });
}

function wireRefresh(): void {
    const btn = document.getElementById('refresh-btn');
    if (!btn) return;
    btn.addEventListener('click', () => { refreshAll(); });
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refreshAll(); }
    });
}

export function refreshAll(): void {
    sourceStatuses.clear();
    fetchAllFeeds();
}

// Retry single source — callable from inline onclick in sources list
(window as unknown as Record<string, unknown>).__retrySingle = (index: number) => {
    retrySingle(index);
};

// Search callable from trending tags
(window as unknown as Record<string, unknown>).__setSearch = (q: string) => {
    currentSearch = q;
    currentPage = 1;
    const input = document.getElementById('search-input') as HTMLInputElement | null;
    if (input) input.value = q;
    renderAll();
};

// Pagination — callable from inline onclick in pagination bar
(window as any).goToPage = goToPage;

// ─── Mobile UI ────────────────────────────────────────────────────────────────

function mobileSetFilter(filter: string, btn: HTMLElement): void {
    // Update mobile nav active state via CSS class
    document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Delegate to wired desktop filter button (hidden on mobile but still functional)
    const desktopBtn = document.getElementById(`filter-${filter}`) as HTMLElement | null;
    if (desktopBtn) {
        desktopBtn.click();
    } else {
        setFilter(filter as Category | 'all');
    }
}

function toggleMobileDrawer(): void {
    const drawer = document.getElementById('mobile-drawer');
    if (drawer?.classList.contains('open')) closeMobileDrawer();
    else openMobileDrawer();
}

function openMobileDrawer(): void {
    document.getElementById('mobile-drawer')?.classList.add('open');
    document.getElementById('mobile-drawer-overlay')?.classList.add('open');
    document.body.style.overflow = 'hidden';
    syncMobileStats();
}

function closeMobileDrawer(): void {
    document.getElementById('mobile-drawer')?.classList.remove('open');
    document.getElementById('mobile-drawer-overlay')?.classList.remove('open');
    document.body.style.overflow = '';
}

function syncMobileStats(): void {
    const map: Array<[string, string]> = [
        ['stat-total', 'mob-stat-loaded'],
        ['stat-sources', 'mob-stat-sources'],
        ['stat-errors', 'mob-stat-errors'],
        ['stat-time', 'mob-stat-refresh'],
    ];
    map.forEach(([srcId, dstId]) => {
        const src = document.getElementById(srcId)?.textContent ?? '—';
        const dst = document.getElementById(dstId);
        if (dst) dst.textContent = src;
    });
}

function addCustomSourceMobile(): void {
    const errEl = document.getElementById('mob-form-error') as HTMLElement | null;
    const mName = (document.getElementById('mob-src-name') as HTMLInputElement)?.value.trim() ?? '';
    const mUrl = (document.getElementById('mob-src-url') as HTMLInputElement)?.value.trim() ?? '';
    const mCat = ((document.getElementById('mob-src-cat') as HTMLSelectElement)?.value ?? 'ai') as Category;

    if (!mName || !mUrl) {
        if (errEl) { errEl.textContent = 'Name and URL required.'; errEl.style.display = 'block'; }
        return;
    }

    const ok = addCustomSource(mName, mUrl, mCat);
    if (!ok) {
        if (errEl) { errEl.textContent = 'Source already exists or URL is invalid.'; errEl.style.display = 'block'; }
        return;
    }

    (document.getElementById('mob-src-name') as HTMLInputElement).value = '';
    (document.getElementById('mob-src-url') as HTMLInputElement).value = '';
    if (errEl) errEl.style.display = 'none';
}

// Expose mobile functions to window for inline onclick handlers
(window as any).mobileSetFilter = mobileSetFilter;
(window as any).toggleMobileDrawer = toggleMobileDrawer;
(window as any).closeMobileDrawer = closeMobileDrawer;
(window as any).addCustomSourceMobile = addCustomSourceMobile;



async function testProxies(): Promise<void> {
    const testUrl = 'https://thehackernews.com/feeds/posts/default';
    for (const strategy of PROXY_STRATEGIES) {
        try {
            const res = await fetch(strategy.buildUrl(testUrl), {
                signal: AbortSignal.timeout(5000),
            });
            console.log(`[proxy test] ${strategy.buildUrl('TEST')} → ${res.status}`);
        } catch (e) {
            console.warn(`[proxy test] ${strategy.buildUrl('TEST')} → FAILED`, e);
        }
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initFeed(): Promise<void> {
    // Merge defaults + custom sources, dedup by URL
    const custom = loadCustomSources();
    const merged = [...DEFAULT_SOURCES];
    for (const c of custom) {
        if (!merged.some((s) => s.url === c.url)) merged.push(c);
    }
    sources = merged;

    for (const s of sources) sourceStatuses.set(s.url, 'load');

    renderSourcesList();
    wireFilters();
    wireSearch();
    wireRefresh();
    setFilter('all');
    updateStats();

    if (import.meta.env.DEV) await testProxies();

    fetchAllFeeds();

    // Auto-refresh every 5 minutes
    setInterval(fetchAllFeeds, 5 * 60 * 1000);
}
