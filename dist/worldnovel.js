Object.defineProperty(exports, "__esModule", { value: true });

const { fetchApi } = require("@libs/fetch");
const { NovelStatus } = require("@libs/novelStatus");
const { defaultCover } = require("@libs/defaultCover");

const SITE = "https://world-novel.fr/";
const normalizeSpace = s => String(s || "").replace(/\s+/g, " ").trim();

function abs(url) {
  if (!url) return defaultCover;
  try { return new URL(url, SITE).href; } catch (_) { return url; }
}

function stripTags(s) {
  return normalizeSpace(String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"));
}

function novelLinks(html) {
  const out = [], seen = new Set();
  const re = /<a\b[^>]*href=["'](?:https?:\/\/[^"']+)?\/oeuvres\/([^\/"'#?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const path = decodeURIComponent(m[1]);
    const name = stripTags(m[2]);
    if (!name || seen.has(path)) continue;
    seen.add(path);
    out.push({ name, path });
  }
  return out;
}

function labelValue(html, label) {
  const plain = stripTags(html);
  const re = new RegExp(label + "\\s*:\\s*([^:]{1,120}?)(?=Auteur\\s*:|Traducteur\\s*:|Genre\\s*:|Lectures|Critiques|Favoris|Classement|Chapitres|$)", "i");
  const m = plain.match(re);
  return m ? normalizeSpace(m[1]) : undefined;
}

function metadata(html) {
  const title = stripTags((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  const cover = (html.match(/<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1]
    || (html.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/i) || [])[1];
  const desc = (html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i) || [])[1];
  return {
    name: title || "Untitled",
    author: labelValue(html, "Auteur"),
    artist: labelValue(html, "Traducteur"),
    genres: labelValue(html, "Genre"),
    cover: cover ? abs(cover) : defaultCover,
    summary: desc ? stripTags(desc) : undefined,
  };
}

function chapterLinks(html, novelSlug) {
  const out = [], seen = new Set();
  const anchors = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchors.exec(html))) {
    const href = m[1];
    const name = stripTags(m[2]);
    if (!href || !name || !/chapitre|chapter/i.test(name + " " + href)) continue;
    if (novelSlug && !href.includes(novelSlug)) continue;
    const numM = name.match(/(?:chapitre|chapter)\s*(\d+(?:\.\d+)?)/i) || href.match(/(?:chapitres?|chapters?|chapter)[\/-]?(\d+(?:\.\d+)?)/i);
    if (!numM) continue;
    const chapterNumber = Number(numM[1]);
    if (!Number.isFinite(chapterNumber)) continue;
    const path = href.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ name, path, chapterNumber });
  }
  return out.sort((a,b) => a.chapterNumber - b.chapterNumber);
}

function collectJsonChapters(value, novelSlug, out, seen) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const v of value) collectJsonChapters(v, novelSlug, out, seen);
    return;
  }
  if (typeof value !== "object") return;
  const rawNum = value.chapterNumber ?? value.chapter_number ?? value.number ?? value.chapter;
  const n = Number(rawNum);
  const rawSlug = value.slug ?? value.path ?? value.url ?? value.href;
  const title = normalizeSpace(value.title ?? value.name ?? "");
  if (Number.isFinite(n) && rawSlug) {
    let p = String(rawSlug).replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
    if (!p.includes("/")) p = `oeuvres/${novelSlug}/chapitres/${p}`;
    if (!seen.has(p)) {
      seen.add(p);
      out.push({ name: title || `Chapitre ${n}`, path: p, chapterNumber: n, releaseTime: value.createdAt || value.publishedAt || undefined });
    }
  }
  for (const v of Object.values(value)) collectJsonChapters(v, novelSlug, out, seen);
}

function chaptersFromJson(data, novelSlug) {
  const out = [], seen = new Set();
  collectJsonChapters(data, novelSlug, out, seen);
  return out.sort((a,b) => a.chapterNumber - b.chapterNumber);
}

function scriptsJson(html, novelSlug) {
  const out = [], seen = new Set();
  const re = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { collectJsonChapters(JSON.parse(m[1]), novelSlug, out, seen); } catch (_) {}
  }
  const next = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) { try { collectJsonChapters(JSON.parse(next[1]), novelSlug, out, seen); } catch (_) {} }
  return out.sort((a,b) => a.chapterNumber - b.chapterNumber);
}

function chapterContent(html) {
  const article = (html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || [])[1];
  const main = (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || [])[1];
  let body = article || main || html;
  body = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:nav|footer|aside)\b[\s\S]*?<\/(?:nav|footer|aside)>/gi, "");
  const candidates = [...body.matchAll(/<(?:h1|h2|p)\b[^>]*>[\s\S]*?<\/(?:h1|h2|p)>/gi)]
    .map(x => x[0]).filter(x => stripTags(x).length > 0);
  return candidates.join("");
}

function chapterContentFromJson(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const next = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) scripts.push(next[1]);
  const escape = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  function find(v) {
    if (!v) return null;
    if (Array.isArray(v)) {
      if (v.length > 2 && v.every(x => typeof x === "string" || (x && typeof x.content === "string"))) {
        return v.map(x => `<p>${escape(typeof x === "string" ? x : x.content)}</p>`).join("");
      }
      for (const x of v) { const f = find(x); if (f) return f; }
    } else if (typeof v === "object") {
      for (const key of ["paragraphs","content","chapterContent","text"]) {
        if (v[key]) { const f = find(v[key]); if (f) return f; }
      }
      for (const x of Object.values(v)) { const f = find(x); if (f) return f; }
    } else if (typeof v === "string" && v.length > 500) {
      return /<p\b/i.test(v) ? v : `<p>${escape(v)}</p>`;
    }
    return null;
  }
  for (const raw of scripts) { try { const f = find(JSON.parse(raw)); if (f) return f; } catch (_) {} }
  return "";
}

class WorldNovelPlugin {
  constructor() {
    this.id = "worldnovel-vnh-fix";
    this.name = "WorldNovel (VNH Fix)";
    this.icon = "";
    this.site = SITE;
    this.version = "0.1.0";
  }

  async get(url) {
    const r = await fetchApi(url, { headers: { "Accept": "text/html,application/xhtml+xml,application/json" } });
    if (!r.ok) throw new Error(`WorldNovel: HTTP ${r.status}. Ouvre le site dans WebView puis réessaie.`);
    return { text: await r.text(), contentType: r.headers?.get?.("content-type") || "", url: r.url || url };
  }

  async popularNovels(pageNo) {
    if (pageNo > 1) return [];
    const { text } = await this.get(this.site);
    return novelLinks(text).map(n => ({ ...n, cover: defaultCover }));
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
        const found = novelLinks(text).filter(n => n.name.toLowerCase().includes(searchTerm.toLowerCase()));
        if (found.length) return found.map(n => ({ ...n, cover: defaultCover }));
      } catch (_) {}
    }
    if (/shadow\s*slave/i.test(searchTerm)) return [{ name: "Shadow Slave", path: "shadow-slave", cover: defaultCover }];
    return [];
  }

  async parseNovel(novelPath) {
    const slug = novelPath.replace(/^oeuvres\//, "").split("/")[0];
    const { text } = await this.get(`${this.site}oeuvres/${slug}`);
    const m = metadata(text);
    let chapters = chapterLinks(text, slug);
    if (!chapters.length) chapters = scriptsJson(text, slug);

    if (!chapters.length) {
      const endpoints = [
        `${this.site}api/chapters/${slug}`,
        `${this.site}api/oeuvres/${slug}/chapitres`,
        `${this.site}api/oeuvres/${slug}/chapters`,
        `${this.site}api/chapters?oeuvre=${encodeURIComponent(slug)}`,
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
      path: slug,
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
    const path = chapterPath.replace(/^\//, "");
    const { text } = await this.get(abs(path));
    const direct = chapterContent(text);
    if (stripTags(direct).length > 300) return direct;
    const embedded = chapterContentFromJson(text);
    if (embedded) return embedded;
    throw new Error("WorldNovel: contenu du chapitre introuvable. Le site charge probablement le texte via une API encore à identifier.");
  }

  resolveUrl(path) {
    if (/^https?:\/\//.test(path)) return path;
    if (path.startsWith("oeuvres/")) return abs(path);
    return abs(`oeuvres/${path}`);
  }
}

exports.default = new WorldNovelPlugin();
