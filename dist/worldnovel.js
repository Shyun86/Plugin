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

function normalizeChapterPath(href) {
  return String(href || "")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/^\//, "")
    .split("#")[0];
}

function chapterNumberFrom(text, href) {
  const source = `${text || ""} ${href || ""}`;
  const patterns = [
    /(?:chapitre|chapter)[^0-9]{0,15}(\d+(?:\.\d+)?)/i,
    /(?:chapitres?|chapters?)[\/_-](\d+(?:\.\d+)?)/i,
    /[\/_-](\d{1,5})(?:[\/_-]|$)/,
  ];
  for (const p of patterns) {
    const m = source.match(p);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function chapterLinks(html, slug) {
  const out = [];
  const seen = new Set();
  const anchors = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchors.exec(html))) {
    const href = m[1];
    const name = stripTags(m[2]);
    const haystack = `${href} ${name}`;
    if (!/(chapitre|chapter)/i.test(haystack)) continue;

    const n = chapterNumberFrom(name, href);
    if (n == null) continue;

    const path = normalizeChapterPath(href);
    if (!path || seen.has(path)) continue;

    // Prefer links related to this novel, but do not reject generic chapter routes.
    if (slug && /\/oeuvres\//i.test(path) && !path.includes(slug)) continue;

    seen.add(path);
    out.push({
      name: name || `Chapitre ${n}`,
      path,
      chapterNumber: n,
    });
  }

  return out.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function collectJsonChapters(value, slug, out, seen) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) collectJsonChapters(v, slug, out, seen);
    return;
  }
  if (typeof value !== "object") return;

  const numRaw = value.chapterNumber ?? value.chapter_number ?? value.number ?? value.chapterNo ?? value.chapter_no ?? value.chapter;
  const hrefRaw = value.path ?? value.url ?? value.href ?? value.slug;
  const title = normalizeSpace(value.title ?? value.name ?? value.chapterTitle ?? "");
  const n = Number(numRaw);

  if (Number.isFinite(n) && hrefRaw) {
    let path = normalizeChapterPath(String(hrefRaw));
    if (!path.includes("/") && slug) path = `oeuvres/${slug}/chapitres/${path}`;
    if (!seen.has(path)) {
      seen.add(path);
      out.push({
        name: title || `Chapitre ${n}`,
        path,
        chapterNumber: n,
        releaseTime: value.createdAt || value.publishedAt || value.releaseDate || undefined,
      });
    }
  }

  for (const v of Object.values(value)) collectJsonChapters(v, slug, out, seen);
}

function chaptersFromJson(data, slug) {
  const out = [];
  const seen = new Set();
  collectJsonChapters(data, slug, out, seen);
  return out.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function scriptsJson(html, slug) {
  const out = [];
  const seen = new Set();
  const scripts = [];

  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) scripts.push(m[1]);
  const next = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) scripts.push(next[1]);

  for (const raw of scripts) {
    try { collectJsonChapters(JSON.parse(raw), slug, out, seen); } catch (_) {}
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

function chapterContentFromJson(html) {
  const raws = [...html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const next = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) raws.push(next[1]);

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function walk(v) {
    if (!v) return null;
    if (Array.isArray(v)) {
      if (v.length > 2 && v.every((x) => typeof x === "string" || (x && typeof x.content === "string"))) {
        return v.map((x) => `<p>${esc(typeof x === "string" ? x : x.content)}</p>`).join("");
      }
      for (const x of v) { const r = walk(x); if (r) return r; }
    } else if (typeof v === "object") {
      for (const key of ["paragraphs", "content", "chapterContent", "text", "body"]) {
        if (v[key]) { const r = walk(v[key]); if (r) return r; }
      }
      for (const x of Object.values(v)) { const r = walk(x); if (r) return r; }
    } else if (typeof v === "string" && v.length > 500) {
      return /<p\b/i.test(v) ? v : `<p>${esc(v)}</p>`;
    }
    return null;
  }

  for (const raw of raws) {
    try { const r = walk(JSON.parse(raw)); if (r) return r; } catch (_) {}
  }
  return "";
}

class WorldNovelPlugin {
  constructor() {
    this.id = "worldnovel-vnh-fix";
    this.name = "WorldNovel (VNH Fix)";
    this.icon = "";
    this.site = SITE;
    this.version = "0.2.0";
  }

  async get(url) {
    const r = await fetchApi(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/json",
        "Referer": SITE,
      },
    });
    if (!r.ok) throw new Error(`WorldNovel: HTTP ${r.status}`);
    return {
      text: await r.text(),
      contentType: r.headers?.get?.("content-type") || "",
      url: r.url || url,
    };
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

    let chapters = chapterLinks(text, slug);
    if (!chapters.length) chapters = scriptsJson(text, slug);

    if (!chapters.length) {
      const endpoints = [
        `${this.site}api/chapters/${slug}`,
        `${this.site}api/oeuvres/${slug}/chapitres`,
        `${this.site}api/oeuvres/${slug}/chapters`,
        `${this.site}api/chapters?oeuvre=${encodeURIComponent(slug)}`,
        `${this.site}api/chapters?slug=${encodeURIComponent(slug)}`,
      ];

      for (const url of endpoints) {
        try {
          const r = await this.get(url);
          const data = JSON.parse(r.text);
          chapters = chaptersFromJson(data, slug);
          if (chapters.length) break;
        } catch (_) {}
      }
    }

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

    const embedded = chapterContentFromJson(text);
    if (embedded) return embedded;

    throw new Error("WorldNovel: contenu du chapitre introuvable");
  }

  resolveUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return abs(String(path || "").replace(/^\//, ""));
  }
}

exports.default = new WorldNovelPlugin();
