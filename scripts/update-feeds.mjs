import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FEEDS_PATH = path.join(DATA_DIR, 'feeds.json');
const ARTICLES_PATH = path.join(DATA_DIR, 'articles.json');

const USER_AGENT = 'VeilleCG-Bot/1.0 (+https://www.christophe-guillon.com/veille.html)';
const MAX_ARTICLES = 250;
const RETENTION_DAYS = 30;
const REQUEST_TIMEOUT_MS = 10000;

/** Génère un identifiant déterministe FNV-1a 32-bit en hexadécimal */
function hashString(input) {
    let hash = 0x811c9dc5;
    const str = String(input || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Normalise une URL en retirant les paramètres de tracking (utm_*, fbclid, etc.) */
function normalizeUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        const keysToRemove = [];
        parsed.searchParams.forEach((_, key) => {
            const lower = key.toLowerCase();
            if (lower.startsWith('utm_') || lower === 'fbclid' || lower === 'gclid' || lower === 'ref') {
                keysToRemove.push(key);
            }
        });
        keysToRemove.forEach((key) => parsed.searchParams.delete(key));
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function buildFeedId(url) {
    const norm = normalizeUrl(url) || String(url || '').trim().toLowerCase();
    return `feed_${hashString(norm)}`;
}

/** Décode les entités HTML/XML et supprime les balises pour obtenir du texte brut */
function toPlainText(raw, maxLength = 0) {
    if (!raw) return '';
    let text = String(raw)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\s+/g, ' ')
        .trim();

    if (maxLength > 0 && text.length > maxLength) {
        text = text.slice(0, maxLength - 1).trimEnd() + '…';
    }
    return text;
}

function extractTagContent(block, tagNames) {
    for (const tag of tagNames) {
        const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
        const match = block.match(regex);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    return '';
}

function extractLink(block) {
    // Atom avec ou sans préfixe de namespace (<link ...> ou <atom:link ...>)
    const atomAlternate = block.match(/<(?:atom:)?link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
        || block.match(/<(?:atom:)?link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?>/i);
    if (atomAlternate && atomAlternate[1]) return toPlainText(atomAlternate[1]);

    const atomHref = block.match(/<(?:atom:)?link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (atomHref && atomHref[1]) return toPlainText(atomHref[1]);

    // RSS 2.0 : <link>https://...</link> ou <link><![CDATA[https://...]]></link>
    const rssLink = extractTagContent(block, ['link']);
    return toPlainText(rssLink);
}

function isArticleDeepLink(url) {
    try {
        const parsed = new URL(url);
        const pathName = parsed.pathname.replace(/\/+$/, '');
        if (!pathName || pathName === '') return false;
        const segments = pathName.split('/').filter(Boolean);
        if (segments.length <= 2 && /^(tag|tags|category|categories|topic|topics|section|author)$/i.test(segments[0])) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function parseXmlEntries(xmlText, feed) {
    const fetchedAt = new Date().toISOString();
    const itemMatches = xmlText.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
    const articles = [];

    for (const block of itemMatches) {
        const rawLink = extractLink(block);
        const cleanLink = normalizeUrl(rawLink);
        if (!cleanLink || !isArticleDeepLink(cleanLink)) continue;

        const rawTitle = extractTagContent(block, ['title']);
        const rawDesc = extractTagContent(block, ['description', 'summary', 'content:encoded', 'content']);
        const rawDate = extractTagContent(block, ['pubDate', 'published', 'updated', 'dc:date', 'date']);
        const rawSource = extractTagContent(block, ['source']);

        let pubDateISO = null;
        if (rawDate) {
            const parsedTime = Date.parse(toPlainText(rawDate));
            if (!Number.isNaN(parsedTime)) {
                pubDateISO = new Date(parsedTime).toISOString();
            }
        }

        const title = toPlainText(rawTitle, 220) || 'Article sans titre';
        const description = toPlainText(rawDesc, 250);
        const source = toPlainText(rawSource, 80) || feed.name;

        articles.push({
            id: hashString(cleanLink),
            feedId: feed.id,
            feedName: feed.name,
            source,
            title,
            link: cleanLink,
            description,
            pubDate: pubDateISO,
            category: feed.category === 'NoCode' ? 'NoCode' : 'IA',
            fetchedAt
        });
    }

    return articles;
}

function pruneAndSortArticles(articlesList, activeFeedIds) {
    const nowMs = Date.now();
    const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const dedupMap = new Map();

    for (const art of articlesList) {
        if (!art || !art.link) continue;
        if (activeFeedIds && !activeFeedIds.has(art.feedId)) continue;

        const cleanLink = normalizeUrl(art.link);
        if (!cleanLink) continue;

        if (art.pubDate) {
            const pubMs = Date.parse(art.pubDate);
            if (!Number.isNaN(pubMs) && (nowMs - pubMs) > maxAgeMs) continue;
        }

        dedupMap.set(cleanLink, {
            ...art,
            id: art.id || hashString(cleanLink),
            link: cleanLink
        });
    }

    return Array.from(dedupMap.values())
        .sort((a, b) => {
            const timeA = a.pubDate ? Date.parse(a.pubDate) : 0;
            const timeB = b.pubDate ? Date.parse(b.pubDate) : 0;
            if (timeB !== timeA) return timeB - timeA;
            const fetchA = a.fetchedAt ? Date.parse(a.fetchedAt) : 0;
            const fetchB = b.fetchedAt ? Date.parse(b.fetchedAt) : 0;
            return fetchB - fetchA;
        })
        .slice(0, MAX_ARTICLES);
}

async function fetchFeed(feed) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(feed.url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        if (!xml || /^\s*<!doctype\s+html|^\s*<html/i.test(xml)) {
            throw new Error('Réponse HTML reçue au lieu d’un flux XML');
        }
        return parseXmlEntries(xml, feed);
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    await mkdir(DATA_DIR, { recursive: true });

    const feedsRaw = JSON.parse(await readFile(FEEDS_PATH, 'utf-8'));
    const feeds = feedsRaw
        .filter((f) => f && f.url && f.enabled !== false)
        .map((f) => ({
            id: f.id || buildFeedId(f.url),
            name: String(f.name || 'Flux sans nom').trim(),
            url: normalizeUrl(f.url) || f.url.trim(),
            category: f.category === 'NoCode' ? 'NoCode' : 'IA',
            enabled: true
        }));

    let existingArticles = [];
    try {
        existingArticles = JSON.parse(await readFile(ARTICLES_PATH, 'utf-8'));
    } catch {
        existingArticles = [];
    }

    const activeFeedIds = new Set(feeds.map((f) => f.id));
    const collected = [];

    const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed)));
    results.forEach((result, index) => {
        const feed = feeds[index];
        if (result.status === 'fulfilled') {
            console.log(`[OK] ${feed.name} : ${result.value.length} articles`);
            collected.push(...result.value);
        } else {
            console.warn(`[WARN] ${feed.name} (${feed.url}) : ${result.reason?.message || result.reason}`);
        }
    });

    const finalArticles = pruneAndSortArticles([...existingArticles, ...collected], activeFeedIds);
    await writeFile(ARTICLES_PATH, JSON.stringify(finalArticles, null, 2) + '\n', 'utf-8');
    console.log(`[DONE] ${finalArticles.length} articles écrits dans data/articles.json`);
}

main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
});
