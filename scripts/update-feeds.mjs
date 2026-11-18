import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FEEDS_PATH = path.join(DATA_DIR, 'feeds.json');
const ARTICLES_PATH = path.join(DATA_DIR, 'articles.json');

const USER_AGENT = 'VeilleCG-Bot/1.0 (+https://www.christophe-guillon.com/veille.html)';
const MAX_ARTICLES = 250;
const RETENTION_DAYS = 30;
const REQUEST_TIMEOUT_MS = 10000;
const FETCH_CONCURRENCY = 5;

/**
 * Génère un identifiant déterministe FNV-1a 32-bit en hexadécimal (8 caractères).
 * Identique à l'implémentation de veille.html pour garantir la cohérence des IDs.
 */
function hashString(input) {
    let hash = 0x811c9dc5;
    const str = String(input || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Normalise une URL http(s) en supprimant l'ancre et les paramètres de suivi (utm_*, fbclid, etc.).
 */
function normalizeUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '';
        }
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

/**
 * Construit un identifiant de flux stable à partir de son URL normalisée.
 */
function buildFeedId(url) {
    const norm = normalizeUrl(url) || String(url || '').trim().toLowerCase();
    return `feed_${hashString(norm)}`;
}

/**
 * Décode les entités HTML/XML (y compris doublement encodées) puis supprime
 * toutes les balises HTML pour produire un texte brut sécurisé.
 */
function toPlainText(raw, maxLength = 0) {
    if (!raw) return '';
    let text = String(raw)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, dec) => {
            const code = Number(dec);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
        })
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (maxLength > 0 && text.length > maxLength) {
        text = text.slice(0, maxLength - 1).trimEnd() + '…';
    }
    return text;
}

/**
 * Extrait le contenu brut de la première balise trouvée parmi tagNames.
 */
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

/**
 * Extrait l'URL cible d'une entrée RSS 2.0 ou Atom (avec ou sans préfixe atom:).
 */
function extractLink(block) {
    const atomAlternate = block.match(/<(?:atom:)?link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
        || block.match(/<(?:atom:)?link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?>/i);
    if (atomAlternate && atomAlternate[1]) {
        return toPlainText(atomAlternate[1]);
    }

    const atomHref = block.match(/<(?:atom:)?link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (atomHref && atomHref[1]) {
        return toPlainText(atomHref[1]);
    }

    const rssLink = extractTagContent(block, ['link']);
    return toPlainText(rssLink);
}

/**
 * Vérifie que l'URL pointe vers un article profond et non une page d'accueil ou d'index de rubrique.
 */
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

/**
 * Parse les entrées <item> (RSS) ou <entry> (Atom) selon le schéma de données cible.
 */
function parseXmlEntries(xmlText, feed) {
    const fetchedAt = new Date().toISOString();
    const maxFutureMs = Date.now() + 24 * 60 * 60 * 1000;
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

        // Date ISO 8601 valide, ou null si absente / invalide / aberrante (> 24 h dans le futur)
        let pubDateISO = null;
        if (rawDate) {
            const parsedTime = Date.parse(toPlainText(rawDate));
            if (!Number.isNaN(parsedTime) && parsedTime <= maxFutureMs) {
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

/**
 * Déduplique par lien normalisé, retire les flux supprimés/désactivés, neutralise les dates
 * futures aberrantes, purge les articles de plus de 30 jours et trie par pubDate décroissant
 * avant de tronquer à MAX_ARTICLES.
 */
function pruneAndSortArticles(articlesList, activeFeedsById) {
    const nowMs = Date.now();
    const maxFutureMs = nowMs + 24 * 60 * 60 * 1000;
    const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const dedupMap = new Map();

    for (const art of articlesList) {
        if (!art || !art.link) continue;
        if (activeFeedsById && !activeFeedsById.has(art.feedId)) continue;

        const cleanLink = normalizeUrl(art.link);
        if (!cleanLink) continue;

        let validPubDate = art.pubDate || null;
        if (validPubDate) {
            const pubMs = Date.parse(validPubDate);
            if (Number.isNaN(pubMs) || pubMs > maxFutureMs) {
                validPubDate = null;
            } else if ((nowMs - pubMs) > maxAgeMs) {
                continue;
            }
        }

        const currentFeed = activeFeedsById ? activeFeedsById.get(art.feedId) : null;

        dedupMap.set(cleanLink, {
            ...art,
            id: art.id || hashString(cleanLink),
            feedName: currentFeed ? currentFeed.name : art.feedName,
            category: currentFeed ? currentFeed.category : (art.category === 'NoCode' ? 'NoCode' : 'IA'),
            link: cleanLink,
            pubDate: validPubDate
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

/**
 * Télécharge un flux RSS/Atom avec User-Agent identifiable et timeout de 10 s.
 */
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
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const xml = await res.text();
        if (!xml || /^\s*<!doctype\s+html|^\s*<html/i.test(xml)) {
            throw new Error('Réponse HTML reçue au lieu d’un flux XML');
        }
        return parseXmlEntries(xml, feed);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Point d'entrée principal exécuté par GitHub Actions.
 */
async function main() {
    await mkdir(DATA_DIR, { recursive: true });

    const feedsRaw = JSON.parse(await readFile(FEEDS_PATH, 'utf-8'));
    const feeds = feedsRaw
        .filter((f) => f && f.url && f.enabled !== false)
        .map((f) => {
            const cleanUrl = normalizeUrl(f.url) || String(f.url).trim();
            return {
                id: f.id || buildFeedId(cleanUrl),
                name: String(f.name || 'Flux sans nom').trim(),
                url: cleanUrl,
                category: f.category === 'NoCode' ? 'NoCode' : 'IA',
                enabled: true
            };
        });

    let existingArticles = [];
    try {
        existingArticles = JSON.parse(await readFile(ARTICLES_PATH, 'utf-8'));
        if (!Array.isArray(existingArticles)) existingArticles = [];
    } catch {
        existingArticles = [];
    }

    const activeFeedsById = new Map(feeds.map((f) => [f.id, f]));
    const collected = [];

    for (let i = 0; i < feeds.length; i += FETCH_CONCURRENCY) {
        const batch = feeds.slice(i, i + FETCH_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((feed) => fetchFeed(feed)));
        results.forEach((result, idx) => {
            const feed = batch[idx];
            if (result.status === 'fulfilled') {
                console.log(`[OK] ${feed.name} : ${result.value.length} article(s)`);
                collected.push(...result.value);
            } else {
                console.warn(`[WARN] ${feed.name} (${feed.url}) : ${result.reason?.message || result.reason}`);
            }
        });
    }

    const finalArticles = pruneAndSortArticles([...existingArticles, ...collected], activeFeedsById);
    await writeFile(ARTICLES_PATH, JSON.stringify(finalArticles, null, 2) + '\n', 'utf-8');
    console.log(`[DONE] ${finalArticles.length} articles écrits dans data/articles.json`);
}

main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
});
