Object.defineProperty(exports, "__esModule", { value: true });

const { fetchApi } = require("@libs/fetch");
const { NovelStatus } = require("@libs/novelStatus");
const { defaultCover } = require("@libs/defaultCover");

const SITE = "https://world-novel.fr/";
const normalizeSpace = (s) => String(s || "").replace(/\s+/g, " ").trim();

function abs(url) {
  if (!url) return defaultCover;
  try { return new URL(url, SITE).href; } catch (_) { return url; }
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(s) {
  return normalizeSpace(
    decodeHtml(String(s || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "))
  );
}

function metaContent(html, key) {
  const a = html.match(new RegExp(`<meta\\b[^>]*(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i"));
  const b = html.match(new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i"));
  return decodeHtml((a || b || [])[1] || "");
}

function novelLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']*\/oeuvres\/([^\/"'#?]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = decodeURIComponent(m[2]);
    const path = `oeuvres/${slug}`;
    const name = stripTags(m[3]);
    if (!name || seen.has(path)) continue;
    seen.add(path);
    out.push({ name, path });
  }
  return out;
}

function labelValue(html, label) {
  const plain = stripTags(html);
  const re = new RegExp(`${label}\\s*:\\s*(.+?)(?=Auteur\\s*:|Traducteur\\s*:|Genre\\s*:|Lectures|Critiques|Favoris|Classement|Chapitres|Afficher plus|$)`, "i");
  const m = plain.match(re);
  return m ? normalizeSpace(m[1]) : undefined;
}

function metadata(html, slug) {
  let title = metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (title) title = title.replace(/\s*[-|]\s*(?:Web Novel FR|Victorian Novel House).*$/i, "").trim();

  if (!title || /victorian novel house/i.test(title)) {
    const headings = [...html.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean)
      .filter((x) => !/victorian novel house/i.test(x));
    title = headings[0] || slug.replace(/-/g, " ");
  }

  const cover = metaContent(html, "og:image") || metaContent(html, "twitter:image") ||
    ((html.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/i) || [])[1]);
  const desc = metaContent(html, "description") || metaContent(html, "og:description");

  return {
    name: title,
    author: labelValue(html, "Auteur"),
    artist: labelValue(html, "Traducteur"),
    genres: labelValue(html, "Genre"),
    cover: cover ? abs(cover) : defaultCover,
    summary: desc ? stripTags(desc) : undefined,
  };
}

function chapterNumberFrom(text) {
  const m = String(text || "").match(/(?:chapitre|chapter)\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function chapterLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const name = stripTags(m[2]);
    if (!/(chapitre|chapter)/i.test(`${href} ${name}`)) continue;
    const n = chapterNumberFrom(name) ?? chapterNumberFrom(decodeURIComponent(href));
    if (n == null) continue;
    const path = href.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\//, "").split("#")[0];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ name: name || `Chapitre ${n}`, path, chapterNumber: n });
  }
  return out.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

// New VNH/WorldNovel pages embed volume/chapter data in Next.js RSC payloads.
// In the HTML source the JSON is usually escaped, e.g. {\"volumeId\":\"...\", ...}.
function chaptersFromEmbeddedRsc(html, slug) {
  const out = [];
  const seen = new Set();

  // Normalize escaped JSON-like strings enough for robust field matching.
  const src = String(html || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\u0027/g, "'")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\"/g, '"');

  // Actual shape observed on world-novel.fr:
  // {"id":"Chapitre 3000 – ...","title":"...","date":"23/05/2026",
  //  "volumeId":"AZ...","volumeDisplayName":"Volume 11 - ...","ts":177...}
  const re = /\{"id":"([^"]*?(?:Chapitre|Chapter)\s*\d+[^"]*)","title":"([^"]*)","date":"([^"]*)","volumeId":"([^"]+)","volumeDisplayName":"([^"]*)","ts":([0-9]+)\}/gi;
  let m;

  while ((m = re.exec(src))) {
    const id = m[1];
    const title = m[2] || id;
    const date = m[3] || undefined;
    const volumeId = m[4];
    const volumeName = m[5] || undefined;
    const ts = Number(m[6]);
    const n = chapterNumberFrom(title) ?? chapterNumberFrom(id);
    if (n == null) continue;

    const encodedTitle = encodeURIComponent(id).replace(/'/g, "%27");
    const path = `lecture/${slug}/volumes/${encodeURIComponent(volumeId)}/chapitres/${encodedTitle}`;
    if (seen.has(path)) continue;
    seen.add(path);

    out.push({
      name: title,
      path,
      chapterNumber: n,
      releaseTime: Number.isFinite(ts) ? ts : date,
      scanlator: volumeName,
    });
  }

  return out.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function chapterContent(html) {
  const article = (html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || [])[1];
  const main = (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || [])[1];
  let body = article || main || html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:nav|footer|aside)\b[\s\S]*?<\/(?:nav|footer|aside)>/gi, "");
  return [...body.matchAll(/<(?:h1|h2|p)\b[^>]*>[\s\S]*?<\/(?:h1|h2|p)>/gi)]
    .map((m) => m[0])
    .filter((x) => stripTags(x).length > 0)
    .join("");
}

class WorldNovelPlugin {
  constructor() {
    this.id = "worldnovel-vnh-fix";
    this.name = "WorldNovel (VNH Fix)";
    this.icon = "";
    this.site = SITE;
    this.version = "0.3.0";
  }

  async get(url) {
    const r = await fetchApi(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/json",
        "Referer": SITE,
      },
    });
    if (!r.ok) throw new Error(`WorldNovel: HTTP ${r.status}`);
    return { text: await r.text(), url: r.url || url };
  }

  async popularNovels(pageNo) {
    if (pageNo > 1) return [];
    const { text } = await this.get(this.site);
    return novelLinks(text).map((n) => ({ ...n, cover: defaultCover }));
  }

  async searchNovels(searchTerm, pageNo = 1) {
    if (pageNo > 1) return [];
    const q = encodeURIComponent(searchTerm);
    const candidates = [
      `${this.site}oeuvres?search=${q}`,
      `${this.site}recherche?q=${q}`,
      `${this.site}?search=${q}`,
      `${this.site}?s=${q}`,
    ];

    for (const url of candidates) {
      try {
        const { text } = await this.get(url);
        const found = novelLinks(text).filter((n) => n.name.toLowerCase().includes(searchTerm.toLowerCase()));
        if (found.length) return found.map((n) => ({ ...n, cover: defaultCover }));
      } catch (_) {}
    }

    if (/shadow\s*slave/i.test(searchTerm)) {
      return [{ name: "Shadow Slave", path: "oeuvres/shadow-slave", cover: defaultCover }];
    }
    return [];
  }

  async parseNovel(novelPath) {
    const clean = String(novelPath || "").replace(/^\//, "");
    const slug = clean.replace(/^oeuvres\//, "").split("/")[0];
    const canonicalPath = `oeuvres/${slug}`;
    const { text } = await this.get(abs(canonicalPath));
    const m = metadata(text, slug);

    let chapters = chaptersFromEmbeddedRsc(text, slug);
    if (!chapters.length) chapters = chapterLinks(text);

    return {
      path: canonicalPath,
      name: m.name,
      cover: m.cover || defaultCover,
      summary: m.summary,
      author: m.author,
      artist: m.artist,
      genres: m.genres,
      status: NovelStatus.Ongoing,
      chapters,
    };
  }

  async parseChapter(chapterPath) {
    const path = String(chapterPath || "").replace(/^\//, "");
    const { text } = await this.get(abs(path));
    const direct = chapterContent(text);
    if (stripTags(direct).length > 300) return direct;
    throw new Error("WorldNovel: contenu du chapitre chargé dynamiquement; endpoint CDN à intégrer ensuite");
  }

  resolveUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return abs(String(path || "").replace(/^\//, ""));
  }
}

exports.default = new WorldNovelPlugin();
