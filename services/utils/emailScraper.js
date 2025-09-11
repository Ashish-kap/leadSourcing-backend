// utils/emailScraper.js (ESM)
// Reusable email scraper for Puppeteer. No CLI / no require.
// Usage:
//   import { scrapeEmails } from "./utils/emailScraper.js";
//   const { emails } = await scrapeEmails({ browser, startUrl: "https://site" });

import { fileURLToPath } from "url";

const DEFAULTS = {
  depth: 1,
  max: 6,
  timeout: 20000,
  delay: 300,
  wait: "dom", // dom | load | networkidle
  budget: 20000, // overall ms cap
  perPageLinks: 12, // top-k links per page
  firstOnly: false,
  restrictDomain: false, // keep only emails on the site’s domain
  noDeobfuscate: true, // safer default: only exact + mailto + cfemail
};

// ---------- small utils ----------
const uniq = (arr) => Array.from(new Set(arr));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function joinSpacedSingles(text) {
  return text.replace(/\b(?:[a-z0-9]\s+){2,}[a-z0-9]\b/gi, (m) =>
    m.replace(/\s+/g, "")
  );
}

function safeDeobfuscate(text) {
  let t = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = joinSpacedSingles(t);
  // bracketed forms
  t = t.replace(/\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\}/gi, "@");
  t = t.replace(/\(\s*dot\s*\)|\[\s*dot\s*\]|\{\s*dot\s*\}/gi, ".");
  // standalone tokens
  t = t.replace(/\bat\b/gi, "@");
  t = t.replace(/\bdot\b/gi, ".");
  // remove junk like (remove this)
  t = t.replace(/\(remove.*?\)|\[remove.*?\]|\{remove.*?\}/gi, "");
  return t;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,}/g;

function sameHost(u1, u2) {
  try {
    return new URL(u1).hostname === new URL(u2).hostname;
  } catch {
    return false;
  }
}

function apexOf(hostname) {
  const parts = String(hostname).split(".");
  if (parts.length <= 2) return hostname.toLowerCase();
  return parts.slice(-2).join(".").toLowerCase();
}

function sanitizeEmails(emails, opts) {
  const badTlds = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "ico",
    "css",
    "js",
    "mjs",
    "cjs",
    "map",
    "json",
    "ttf",
    "eot",
    "woff",
    "woff2",
    "pdf",
    "zip",
    "rar",
    "7z",
    "exe",
    "dmg",
    "mp4",
    "mp3",
    "avi",
    "mov",
    "webm",
  ]);
  const restrictSet = opts?.restrictSet;

  return uniq(emails)
    .map((e) => (e || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim())
    .filter(Boolean)
    .map((e) => e.replace(/^mailto:/i, ""))
    .filter((e) => !/[\\/]/.test(e))
    .filter((e) => {
      const [local, domain] = e.split("@");
      if (!local || !domain) return false;
      const tld = domain.toLowerCase().split(".").pop();
      if (!tld || badTlds.has(tld)) return false;
      if (restrictSet) {
        const d = domain.toLowerCase();
        let ok = false;
        for (const suffix of restrictSet) {
          if (d === suffix || d.endsWith("." + suffix)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }
      return true;
    })
    .slice(0, 200);
}

function decodeCf(hex) {
  try {
    const r = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ r);
    }
    return out.includes("@") ? out : null;
  } catch {
    return null;
  }
}

async function extractFromPage(page, { noDeobfuscate, restrictSet }) {
  const fromMailto = await page.$$eval('a[href^="mailto:"]', (as) =>
    as
      .map(
        (a) =>
          (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0]
      )
      .filter(Boolean)
  );

  const visibleText = await page.evaluate(() =>
    document.body ? document.body.innerText : ""
  );
  const text = decodeHtml(visibleText);
  const textBag = noDeobfuscate ? text : safeDeobfuscate(text);
  const textMatches = textBag.match(EMAIL_RE) || [];

  const cfHexes = await page.$$eval("[data-cfemail]", (els) =>
    els.map((e) => e.getAttribute("data-cfemail")).filter(Boolean)
  );
  const cfDecoded = cfHexes.map((h) => decodeCf(h)).filter(Boolean);

  return sanitizeEmails([].concat(fromMailto, textMatches, cfDecoded), {
    restrictSet,
  });
}

async function candidateLinks(page, baseUrl, limit = 8) {
  const links = await page.$$eval("a[href]", (as) =>
    as.map((a) => a.getAttribute("href")).filter(Boolean)
  );
  const normalized = links
    .map((href) => {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((u) => sameHost(u, baseUrl))
    .filter(
      (u) =>
        !u.match(
          /#|\.(jpg|jpeg|png|webp|gif|svg|pdf|zip|rar|7z|dmg|exe|mp4|mp3|avi)(\?.*)?$/i
        )
    );

  const weights = [
    { key: "contact", w: 100 },
    { key: "contacts", w: 100 },
    { key: "impressum", w: 90 },
    { key: "support", w: 70 },
    { key: "help", w: 65 },
    { key: "team", w: 40 },
    { key: "about", w: 35 },
    { key: "privacy", w: 20 },
    { key: "legal", w: 20 },
  ];
  const scored = normalized.map((u) => {
    const urlL = u.toLowerCase();
    let score = 0;
    for (const { key, w } of weights) if (urlL.includes(key)) score += w;
    return { url: u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return uniq(scored.map((s) => s.url)).slice(0, limit);
}

export async function scrapeEmails({ browser, startUrl, options = {} }) {
  if (!browser) throw new Error("scrapeEmails: missing Puppeteer browser");
  if (!startUrl) throw new Error("scrapeEmails: missing startUrl");

  const cfg = { ...DEFAULTS, ...options };
  const start = new URL(startUrl);
  const allowSuffixes = new Set([
    start.hostname.toLowerCase(),
    apexOf(start.hostname),
  ]);

  const waitMap = {
    dom: "domcontentloaded",
    load: "load",
    networkidle: "networkidle2",
    networkidle2: "networkidle2",
  };
  const waitUntil =
    waitMap[String(cfg.wait).toLowerCase()] || "domcontentloaded";

  async function robotsAllow(url) {
    if (!cfg.respectRobots) return true;
    try {
      const robotsUrl = `${start.origin}/robots.txt`;
      const res = await fetch(robotsUrl);
      if (!res.ok) return true;
      const text = await res.text();
      const lines = text.split(/\r?\n/);
      let applies = false;
      const dis = [];
      for (const line of lines) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;
        const [kRaw, vRaw] = l.split(":");
        if (!vRaw) continue;
        const k = kRaw.trim().toLowerCase();
        const v = vRaw.trim();
        if (k === "user-agent") applies = v === "*";
        else if (applies && k === "disallow") dis.push(v);
      }
      const path = new URL(url).pathname || "/";
      return !dis.some((d) => d && path.startsWith(d));
    } catch {
      return true;
    }
  }

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(cfg.timeout);
  page.setDefaultTimeout(cfg.timeout);

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    try {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type))
        return req.abort();
      if (cfg.blockThirdParty) {
        const u = new URL(req.url());
        if (
          u.hostname !== start.hostname &&
          [
            "script",
            "xhr",
            "fetch",
            "eventsource",
            "websocket",
            "manifest",
            "other",
          ].includes(type)
        ) {
          return req.abort();
        }
      }
      return req.continue();
    } catch {
      return req.continue();
    }
  });

  const visited = new Set();
  const toVisit = [{ url: startUrl, d: 0 }];
  const visitedList = [];
  const found = new Set();
  const startedAt = Date.now();

  try {
    while (toVisit.length && visited.size < cfg.max) {
      if (Date.now() - startedAt > cfg.budget) break;
      const { url, d } = toVisit.shift();
      if (visited.has(url)) continue;
      if (!sameHost(url, startUrl)) continue;
      if (!(await robotsAllow(url))) {
        visited.add(url);
        continue;
      }

      try {
        await page.goto(url, { waitUntil, timeout: cfg.timeout });
        await sleep(250);
        const emails = await extractFromPage(page, {
          noDeobfuscate: cfg.noDeobfuscate,
          restrictSet: cfg.restrictDomain ? allowSuffixes : null,
        });
        emails.forEach((e) => found.add(e));
        visitedList.push(url);

        if (cfg.firstOnly && found.size) {
          toVisit.length = 0;
          break;
        }

        if (d < cfg.depth) {
          const links = await candidateLinks(page, url, cfg.perPageLinks);
          for (const l of links)
            if (!visited.has(l) && toVisit.length + visited.size < cfg.max)
              toVisit.push({ url: l, d: d + 1 });
        }
        if (cfg.delay) await sleep(cfg.delay);
      } catch (_) {
        // ignore page-level errors
      } finally {
        visited.add(url);
      }
    }
  } finally {
    try {
      await page.close();
    } catch {}
  }

  const emails = Array.from(found).sort((a, b) => a.localeCompare(b));
  return {
    emails,
    pagesVisited: visitedList.length,
    visited: visitedList,
    meta: { durationMs: Date.now() - startedAt },
  };
}
