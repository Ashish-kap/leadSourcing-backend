// utils/emailScraper.js (ESM)
// Reusable email scraper for Puppeteer. No CLI / no require.
// Usage:
//   import { scrapeEmails } from "./utils/emailScraper.js";
//   const { emails } = await scrapeEmails({ browser, startUrl: "https://site" });

import { fileURLToPath } from "url";
import logger from "../logger.js";

const DEFAULTS = {
  depth: 1,
  max: 8,
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
  // 1. Extract from mailto links
  const fromMailto = await page.$$eval('a[href^="mailto:"]', (as) =>
    as
      .map(
        (a) =>
          (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0]
      )
      .filter(Boolean)
  );

  // 2. Extract from visible text
  const visibleText = await page.evaluate(() =>
    document.body ? document.body.innerText : ""
  );
  const text = decodeHtml(visibleText);
  const textBag = noDeobfuscate ? text : safeDeobfuscate(text);
  const textMatches = textBag.match(EMAIL_RE) || [];

  // 3. Extract from Cloudflare protected emails
  const cfHexes = await page.$$eval("[data-cfemail]", (els) =>
    els.map((e) => e.getAttribute("data-cfemail")).filter(Boolean)
  );
  const cfDecoded = cfHexes.map((h) => decodeCf(h)).filter(Boolean);

  // 4. Extract from meta tags
  const fromMeta = await page.$$eval('meta[name*="email"], meta[property*="email"], meta[name="contact"], meta[property="contact"]', (metas) =>
    metas.map((m) => m.getAttribute("content")).filter(Boolean)
  );

  // 5. Extract from footer specifically (often contains contact info)
  const footerText = await page.evaluate(() => {
    const footer = document.querySelector("footer, .footer, #footer");
    return footer ? footer.innerText : "";
  });
  const footerMatches = footerText.match(EMAIL_RE) || [];

  // 6. Extract from data attributes and aria-labels
  const fromDataAttrs = await page.evaluate(() => {
    const elements = document.querySelectorAll("[data-email], [data-contact], [aria-label*='email'], [aria-label*='Email'], [aria-label*='contact'], [aria-label*='Contact']");
    const results = [];
    elements.forEach((el) => {
      const dataEmail = el.getAttribute("data-email");
      const dataContact = el.getAttribute("data-contact");
      const ariaLabel = el.getAttribute("aria-label");
      if (dataEmail) results.push(dataEmail);
      if (dataContact) results.push(dataContact);
      if (ariaLabel) results.push(ariaLabel);
    });
    return results;
  });
  const dataAttrMatches = fromDataAttrs.flatMap((str) => str.match(EMAIL_RE) || []);

  // 7. Extract from JSON-LD structured data
  const fromJsonLd = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const results = [];
    scripts.forEach((script) => {
      try {
        const data = JSON.parse(script.textContent || "");
        const findEmails = (obj) => {
          if (!obj || typeof obj !== "object") return;
          if (obj.email) results.push(obj.email);
          if (obj.contactPoint && obj.contactPoint.email) results.push(obj.contactPoint.email);
          Object.values(obj).forEach((val) => {
            if (Array.isArray(val)) val.forEach(findEmails);
            else if (typeof val === "object") findEmails(val);
          });
        };
        findEmails(data);
      } catch {}
    });
    return results;
  });

  return sanitizeEmails(
    [].concat(fromMailto, textMatches, cfDecoded, fromMeta, footerMatches, dataAttrMatches, fromJsonLd),
    { restrictSet }
  );
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
    { key: "contact", w: 150 }, // Highest priority - increased weight
    { key: "contacts", w: 150 },
    { key: "reach", w: 140 }, // New keyword
    { key: "get-in-touch", w: 140 }, // New keyword
    { key: "connect", w: 130 }, // New keyword
    { key: "impressum", w: 120 }, // Increased - common in German sites
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
      // Don't block stylesheets - some sites need CSS for proper DOM rendering
      if (["image", "media", "font"].includes(type))
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
  const visitedList = [];
  const found = new Set();
  const startedAt = Date.now();
  const errors = []; // Track errors for debugging

  // SIMPLIFIED APPROACH: Visit homepage, extract emails, get links, visit high-priority pages
  
  try {
    // Step 1: Visit homepage - extract emails AND get links at the same time
    let homepageLinks = [];
    try {
      logger.info("EMAIL_SCRAPER_START", `Starting scrape for: ${startUrl}`);
      await page.goto(startUrl, { waitUntil, timeout: cfg.timeout });
      await sleep(1000); // 1 second for JS-heavy sites to render
      
      // EXTRACT EMAILS from homepage immediately
      const homepageEmails = await extractFromPage(page, {
        noDeobfuscate: cfg.noDeobfuscate,
        restrictSet: cfg.restrictDomain ? allowSuffixes : null,
      });
      homepageEmails.forEach((e) => found.add(e));
      logger.info("EMAIL_SCRAPER_HOMEPAGE", `Homepage emails found: ${homepageEmails.length} - ${homepageEmails.join(', ')}`);
      
      // Get links for other pages
      homepageLinks = await candidateLinks(page, startUrl, cfg.perPageLinks);
      logger.info("EMAIL_SCRAPER_LINKS", `Links found on homepage: ${homepageLinks.length}`);
      
      visited.add(startUrl);
      visitedList.push(startUrl);
    } catch (err) {
      logger.warn("EMAIL_SCRAPER_ERROR", `Homepage error: ${err.message}`);
      errors.push({
        url: startUrl,
        type: err.name || "UnknownError",
        message: err.message || String(err),
        phase: "homepage",
      });
    }

    // Step 2: Sort links by priority (contact pages first)
    const scoredLinks = homepageLinks.map((url) => {
      const urlL = url.toLowerCase();
      let score = 0;
      if (urlL.includes("contact")) score += 150;
      if (urlL.includes("reach")) score += 140;
      if (urlL.includes("get-in-touch")) score += 140;
      if (urlL.includes("connect")) score += 130;
      if (urlL.includes("impressum")) score += 120;
      if (urlL.includes("support")) score += 70;
      if (urlL.includes("about")) score += 35;
      return { url, score };
    });
    scoredLinks.sort((a, b) => b.score - a.score);

    // Step 3: Build visit queue with top priority pages
    const toVisit = scoredLinks
      .slice(0, cfg.max - 1) // Reserve 1 slot for homepage already visited
      .map(({ url, score }) => ({ 
        url, 
        d: 1, 
        priority: score >= 120 ? "contact" : score >= 60 ? "support" : "normal" 
      }));
    
    logger.info("EMAIL_SCRAPER_PAGES", `Will visit ${toVisit.length} additional pages. Top 3: ${JSON.stringify(toVisit.slice(0, 3).map(p => `${p.url} (${p.priority})`))}`);


    // Step 4: Visit remaining pages in priority order
    while (toVisit.length && visited.size < cfg.max) {
      if (Date.now() - startedAt > cfg.budget) break;
      const { url, d, priority } = toVisit.shift();
      if (visited.has(url)) continue;
      if (!sameHost(url, startUrl)) continue;
      if (!(await robotsAllow(url))) {
        visited.add(url);
        continue;
      }

      let retryCount = 0;
      let pageSuccess = false;
      
      while (retryCount <= 1 && !pageSuccess) {
        try {
          if (retryCount > 0) {
            await sleep(1000); // Wait 1 second before retry
          }
          
          await page.goto(url, { waitUntil, timeout: cfg.timeout });
          await sleep(1000); // 1 second for JS-heavy sites to fully render
          const emails = await extractFromPage(page, {
            noDeobfuscate: cfg.noDeobfuscate,
            restrictSet: cfg.restrictDomain ? allowSuffixes : null,
          });
          emails.forEach((e) => found.add(e));
          logger.info("EMAIL_SCRAPER_PAGE_RESULT", `Page ${url}: found ${emails.length} emails - ${emails.join(', ')}`);
          visitedList.push(url);
          pageSuccess = true;

          if (cfg.firstOnly && found.size) {
            toVisit.length = 0;
            break;
          }

          if (cfg.delay) await sleep(cfg.delay);
        } catch (err) {
          retryCount++;
          
          // Only log error if all retries failed
          if (retryCount > 1) {
            const errorType = err.name || "UnknownError";
            const errorMsg = err.message || String(err);
            errors.push({
              url,
              type: errorType,
              message: errorMsg,
              priority,
              isNavigation: errorMsg.includes("Navigation") || errorMsg.includes("net::"),
              isTimeout: errorMsg.includes("timeout") || errorMsg.includes("Timeout"),
              retriedOnce: true,
            });
          }
          // Continue despite errors - try remaining pages
        }
      }
      
      visited.add(url);
    }
  } finally {
    try {
      await page.close();
    } catch {}
  }

  const emails = Array.from(found).sort((a, b) => a.localeCompare(b));
  logger.info("EMAIL_SCRAPER_COMPLETE", `FINAL RESULT for ${startUrl}`, {
    totalEmails: emails.length,
    emails: emails.join(', '),
    pagesVisited: visitedList.length,
    pagesAttempted: visited.size,
    errors: errors.length,
    durationMs: Date.now() - startedAt
  });
  
  return {
    emails,
    pagesVisited: visitedList.length,
    visited: visitedList,
    errors: errors.length > 0 ? errors : undefined, // Include errors if any occurred
    meta: {
      durationMs: Date.now() - startedAt,
      pagesFailed: errors.length,
      pagesAttempted: visited.size,
    },
  };
}
