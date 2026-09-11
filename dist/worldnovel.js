Object.defineProperty(exports, "__esModule", { value: true });

const { fetchApi } = require("@libs/fetch");
const { NovelStatus } = require("@libs/novelStatus");
const { defaultCover } = require("@libs/defaultCover");
const { storage } = require("@libs/storage");

const SITE = "https://world-novel.fr/";
const CDN = "https://cdn.world-novel.fr/chapitres/";

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
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch (_) {}
    const n = chapterNumberFrom(name) ?? chapterNumberFrom(decoded);
    if (n == null) continue;
    const path = href.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\//, "").split("#")[0];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ name: name || `Chapitre ${n}`, path, chapterNumber: n });
  }
  return out.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function chaptersFromEmbeddedRsc(html, slug) {
  const out = [];
  const seen = new Set();
  const src = String(html || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\u0027/g, "'")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\"/g, '"');

  const re = /\{"id":"([^"]*?(?:Chapitre|Chapter)\s*\d+[^"]*)","title":"([^"]*)","date":"([^"]*)","volumeId":"([^"]+)","volumeDisplayName":"([^"]*)","ts":([0-9]+)\}/gi;
  let m;
  while ((m = re.exec(src))) {
    const id = m[1];
    const title = m[2] || id;
    const volumeId = m[4];
    const volumeName = m[5] || undefined;
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
      scanlator: volumeName,
    });
  }
  return out.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function parseChapterRoute(chapterPath) {
  const path = String(chapterPath || "").replace(/^\//, "");
  const m = path.match(/^lecture\/([^/]+)\/volumes\/([^/]+)\/chapitres\/(.+)$/i);
  if (!m) throw new Error("WorldNovel: chemin de chapitre invalide");
  let slug = m[1], volumeId = m[2], title = m[3];
  try { slug = decodeURIComponent(slug); } catch (_) {}
  try { volumeId = decodeURIComponent(volumeId); } catch (_) {}
  try { title = decodeURIComponent(title); } catch (_) {}
  return { path, slug, volumeId, title };
}

function extractUserId(html) {
  const src = String(html || "");
  const patterns = [
    /(?:["']?userId["']?)\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/i,
    /[?&]userId=([A-Za-z0-9_-]{20,})/i,
    /(?:["']?uid["']?)\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return m[1];
  }
  return null;
}

function decodeBase64Json(value) {
  const raw = decodeURIComponent(String(value || "").replace(/\+/g, "%2B"));
  const json = atob(raw);
  return JSON.parse(json);
}

function decodeObfuscatedChapter(html) {
  const src = String(html || "");
  const metaMatch = src.match(/chapitres\/css\?[^"'<>]*?(?:&|&amp;)meta=([^"'&<>]+)/i);
  if (!metaMatch) throw new Error("WorldNovel: métadonnées d'obfuscation introuvables");

  let meta;
  try { meta = decodeBase64Json(decodeHtml(metaMatch[1])); }
  catch (_) { throw new Error("WorldNovel: métadonnées d'obfuscation invalides"); }

  const visible = new Set(Array.isArray(meta.visible) ? meta.visible : []);
  if (!visible.size) throw new Error("WorldNovel: liste visible vide");

  const bodyMatch = src.match(/<div\b[^>]*class=["'][^"']*\bchapter-obf\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const body = bodyMatch ? bodyMatch[1] : src;

  let text = "";
  const tokenRe = /<span\b[^>]*class=["']([^"']+)["'][^>]*>([\s\S]*?)<\/span>|<br\s*\/?>/gi;
  let m;
  while ((m = tokenRe.exec(body))) {
    if (/^<br/i.test(m[0])) {
      text += "\n";
      continue;
    }
    const classes = String(m[1] || "").split(/\s+/);
    if (!classes.some((c) => visible.has(c))) continue;
    text += decodeHtml(String(m[2] || "").replace(/<[^>]+>/g, ""));
  }

  text = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length < 100) throw new Error("WorldNovel: chapitre décodé trop court");

  const blocks = text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  return blocks.map((block, i) => {
    const safe = block
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    if (i === 0 && /^(?:Chapitre|Chapter)\s+\d+/i.test(block)) return `<h2>${safe}</h2>`;
    return `<p>${safe.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

class WorldNovelPlugin {
  constructor() {
    this.id = "worldnovel-vnh-fix";
    this.name = "WorldNovel (VNH Fix)";
    this.icon = "";
    this.site = SITE;
    this.version = "0.4.1";
    this.pluginSettings = {
      worldNovelUserId: {
        value: "",
        label: "WorldNovel userId (Firebase UID)",
        type: "Text",
      },
    };
  }

  async request(url, referer = SITE, throwOnHttp = true) {
    const r = await fetchApi(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/json",
        "Referer": referer,
      },
    });
    const text = await r.text();
    if (throwOnHttp && !r.ok) throw new Error(`WorldNovel: HTTP ${r.status}`);
    return { ok: r.ok, status: r.status, text, url: r.url || url };
  }

  async popularNovels(pageNo) {
    if (pageNo > 1) return [];
    const { text } = await this.request(this.site);
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
        const { text } = await this.request(url);
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
    const { text } = await this.request(abs(canonicalPath));
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
    const route = parseChapterRoute(chapterPath);
    const chapterUrl = abs(route.path);

    let pageText = "";
    let userId = String(storage.get("worldNovelUserId") || "").trim() || null;
    try {
      const page = await this.request(chapterUrl, SITE, false);
      pageText = page.text || "";
      if (!userId) userId = extractUserId(pageText);
    } catch (_) {}

    const cdnPath = `${route.slug}/${route.volumeId}/${route.title}`;
    const base = `${CDN}?path=${encodeURIComponent(cdnPath)}`;
    const urls = [];
    if (userId) urls.push(`${base}&userId=${encodeURIComponent(userId)}`);
    urls.push(base);

    let lastStatus = 0;
    let lastText = "";
    for (const url of urls) {
      try {
        const res = await this.request(url, chapterUrl, false);
        lastStatus = res.status;
        lastText = res.text || "";
        if (res.ok && /chapter-obf|chapitres\/css\?/i.test(lastText)) {
          return decodeObfuscatedChapter(lastText);
        }
      } catch (_) {}
    }

    if (pageText) {
      const direct = pageText.match(/<div\b[^>]*class=["'][^"']*\bchapter-obf\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
      if (direct) return decodeObfuscatedChapter(pageText);
    }

    if (!userId) {
      throw new Error("WorldNovel: userId manquant. Renseigne-le dans les paramètres du plugin WorldNovel.");
    }
    if (lastStatus === 401 || lastStatus === 403) {
      throw new Error("WorldNovel: accès CDN refusé avec le userId configuré.");
    }
    if (lastText && /userId/i.test(lastText)) {
      throw new Error("WorldNovel: le CDN a refusé le userId configuré.");
    }
    throw new Error(`WorldNovel: impossible de charger le chapitre via le CDN${lastStatus ? ` (HTTP ${lastStatus})` : ""}`);
  }

  resolveUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return abs(String(path || "").replace(/^\//, ""));
  }
}

exports.default = new WorldNovelPlugin();
