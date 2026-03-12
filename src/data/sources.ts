// src/data/sources.ts
export type Category = 'ai' | 'sec' | 'bb';

export interface FeedSource {
    name: string;
    url: string;
    cat: Category;
}

export const DEFAULT_SOURCES: FeedSource[] = [
    // ── AI / Research ──────────────────────────────────────────────
    {
        // MIT News AI section — correct feed path (NOT /topic/artificial-intelligence2/feed)
        name: 'MIT AI News',
        url: 'https://news.mit.edu/rss/topic/artificial-intelligence2',
        cat: 'ai',
    },
    {
        // HuggingFace blog — feed.xml exists but link tag is broken; use raw feed anyway
        name: 'Hugging Face Blog',
        url: 'https://huggingface.co/blog/feed.xml',
        cat: 'ai',
    },
    {
        // ArXiv CS.AI — official RSS, stable
        name: 'ArXiv CS.AI',
        url: 'https://rss.arxiv.org/rss/cs.AI',
        cat: 'ai',
    },
    {
        // Google Research Blog — correct URL (NOT blog.google/technology/ai/rss/)
        name: 'Google Research Blog',
        url: 'https://research.google/blog/rss',
        cat: 'ai',
    },
    {
        // VentureBeat AI — high-volume, reliable
        name: 'VentureBeat AI',
        url: 'https://venturebeat.com/category/ai/feed/',
        cat: 'ai',
    },

    // ── Cybersecurity ───────────────────────────────────────────────
    {
        // Krebs on Security — standard WordPress feed, works fine
        name: 'Krebs on Security',
        url: 'https://krebsonsecurity.com/feed/',
        cat: 'sec',
    },
    {
        // The Hacker News — FeedBurner was discontinued; use direct feed
        name: 'The Hacker News',
        url: 'https://thehackernews.com/feeds/posts/default',
        cat: 'sec',
    },
    {
        // BleepingComputer — standard feed, works fine
        name: 'BleepingComputer',
        url: 'https://www.bleepingcomputer.com/feed/',
        cat: 'sec',
    },
    {
        // NVD XML feed deprecated April 2023; replaced with Dark Reading
        name: 'Dark Reading',
        url: 'https://www.darkreading.com/rss.xml',
        cat: 'sec',
    },
    {
        // SANS Internet Stormcast — daily security digest
        name: 'SANS ISC Diary',
        url: 'https://isc.sans.edu/rssfeed_full.xml',
        cat: 'sec',
    },

    // ── Bug Bounty / PoC ────────────────────────────────────────────
    {
        // Exploit-DB — RSS exists and is public
        name: 'Exploit-DB',
        url: 'https://www.exploit-db.com/rss.xml',
        cat: 'bb',
    },
    {
        // HackerOne .rss endpoint was removed; use PortSwigger instead
        name: 'PortSwigger Research',
        url: 'https://portswigger.net/research/rss',
        cat: 'bb',
    },
    {
        // DFIR Report — incident response, IOCs, PoC write-ups
        name: 'The DFIR Report',
        url: 'https://thedfirreport.com/feed/',
        cat: 'bb',
    },
    {
        // Sekoia Blog — threat intel and CVE analysis
        name: 'Sekoia Threat Intel',
        url: 'https://blog.sekoia.io/feed/',
        cat: 'bb',
    },
];
