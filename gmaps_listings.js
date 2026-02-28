// gmaps_listings.js – Browserless /function: extract listing URLs from Google Maps SEARCH results.
// Used by listingUrl.js and by scraper when using /function for discovery.
//
// context:
//   url (required)   – Google Maps search URL (e.g. https://www.google.com/maps/search/keyword+in+City+Country?gl=IN&hl=en)
//   maxResults       – max listing count to return (default 100)
//   maxScrolls       – max scroll steps in results panel (default 25)
//   scrollWaitMs     – ms to wait between scrolls (default 500)
//   panelWaitMs      – ms to wait after scroll before extraction (default 1200)
//   hl, gl           – locale (default "en", "IN")

export default async function ({ page, context }) {
  const cfg = {
    url: null,
    maxResults: 100,
    maxScrolls: 25,
    scrollWaitMs: 500,
    panelWaitMs: 1200,
    waitMs: null,
    hl: "en",
    gl: "IN",
    ...(context || {}),
  };
  if (cfg.waitMs != null) cfg.scrollWaitMs = cfg.waitMs;

  const _logs = [];
  const log = (event, msg, payload = {}) => _logs.push({ event, msg, payload });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const finish = (data) => ({
    data: { ...data, _logs },
    type: "application/json",
  });

  if (!cfg.url) {
    return finish({ error: "No url provided", listings: [], listingUrls: [], listingCount: 0 });
  }

  let finalUrl = cfg.url;
  try {
    const u = new URL(cfg.url);
    if (cfg.hl) u.searchParams.set("hl", cfg.hl);
    if (cfg.gl) u.searchParams.set("gl", cfg.gl);
    finalUrl = u.toString();
  } catch (_) {}

  try {
    await page.setViewport({ width: 1365, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    // Block heavy resource types to reduce memory (same as gmaps_reviews / browserlessContentClient / googleMapsScraper)
    const BLOCKED_RESOURCE_TYPES = ["image", "font", "media", "stylesheet"];
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (BLOCKED_RESOURCE_TYPES.includes(type)) {
        req.abort().catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    });

    // IMPORTANT: Consent cookies + pre-warm (same as gmaps_reviews). If listing/review data is missing,
    // limited view, or wrong DOM — keep this block. Visit google.com first so Maps gets full DOM.
    try {
      await page.setCookie(
        { name: "CONSENT", value: "PENDING+987", domain: ".google.com", path: "/" },
        { name: "SOCS", value: "CAISHAgCEhJnd3NfMjAyNDAyMDctMF9SQzIaAmVuIAEaBgiA_LyuBg", domain: ".google.com", path: "/" },
      );
      log("COOKIES_SET", { consent: true });
    } catch (e) {
      log("COOKIES_SET_FAIL", { error: e.message });
    }

    // Pre-warm session via google.com (same as gmaps_reviews) so Maps gets full DOM / review counts
    try {
      await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1500);
      await page.evaluate(() => {
        const labels = ["Accept all", "I agree", "Agree", "Accept", "Reject all"];
        const btns = Array.from(document.querySelectorAll("button"));
        const hit = btns.find((b) => labels.includes((b.innerText || "").replace(/\s+/g, " ").trim()));
        if (hit) hit.click();
      }).catch(() => {});
      await sleep(1000);
      log("PREWARM", { url: "google.com" });
    } catch (e) {
      log("PREWARM_FAIL", { error: e.message });
    }

    log("NAV", "goto", { finalUrl });
    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);

    const maybeBlocked = await page.evaluate(() => {
      const t = (document.body?.innerText || "").toLowerCase();
      return t.includes("unusual traffic") || t.includes("/sorry/") || t.includes("detected unusual traffic");
    });
    if (maybeBlocked) {
      const screenshot = await page.screenshot({ encoding: "base64" }).catch(() => null);
      return finish({
        error: "Possibly blocked by Google (unusual traffic / sorry page).",
        url: finalUrl,
        screenshot,
        listings: [],
        listingUrls: [],
        listingCount: 0,
      });
    }

    await page.evaluate(() => {
      const candidates = ["Accept all", "I agree", "Agree", "Accept"];
      const btns = Array.from(document.querySelectorAll("button"));
      const b = btns.find((x) => candidates.includes((x.innerText || "").trim()));
      if (b) b.click();
    }).catch(() => {});
    await sleep(900);

    try {
      await page.waitForSelector(".Nv2PK", { timeout: 8000 });
    } catch (_) {}

    await page.evaluate(
      async (maxSteps, scrollWaitMs) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const scroller =
          document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd[role="feed"]') ||
          document.querySelector('.m6QErb[role="feed"]') ||
          document.querySelector('[role="feed"]') ||
          document.querySelector(".m6QErb") ||
          document.body;
        for (let i = 0; i < maxSteps; i++) {
          scroller.scrollBy(0, 2000);
          await sleep(scrollWaitMs);
        }
      },
      cfg.maxScrolls,
      cfg.scrollWaitMs
    );

    await sleep(cfg.panelWaitMs);

    const listings = await page.evaluate((maxResults) => {
      return Array.from(document.querySelectorAll(".Nv2PK"))
        .map((listing) => {
          const anchor = listing.querySelector("a.hfpxzc");
          const url = anchor ? anchor.href : null;
          if (!url) return null;

          const ratingElement = listing.querySelector('.ZkP5Je[role="img"]');
          const ratingText = ratingElement?.getAttribute("aria-label") || "";
          const ratingMatch = ratingText.match(/(\d+\.?\d*)\s+stars?/i);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          let reviewCount = 0;
          const reviewMatch = ratingText.match(/(\d{1,3}(?:,\d{3})*|\d+)\s+[Rr]eviews?/);
          if (reviewMatch) {
            reviewCount = parseInt(reviewMatch[1].replace(/,/g, ""), 10);
          } else {
            const reviewCountElement = listing.querySelector('.UY7F9[aria-hidden="true"]');
            const reviewCountText = reviewCountElement?.textContent?.trim() || "";
            const parenMatch = reviewCountText.match(/\((\d{1,3}(?:,\d{3})*|\d+)\)/);
            if (parenMatch) reviewCount = parseInt(parenMatch[1].replace(/,/g, ""), 10);
          }

          const nameElement = listing.querySelector(".qBF1Pd");
          const businessName = nameElement?.textContent?.trim() || "Unknown Business";

          return { url, rating, reviewCount, businessName };
        })
        .filter(Boolean)
        .slice(0, maxResults);
    }, cfg.maxResults);

    const listingUrls = listings.map((l) => l.url);

    log("LISTINGS_EXTRACTED", "Listings from search results", {
      count: listings.length,
      sampleUrl: listingUrls[0] || null,
    });

    return finish({
      url: finalUrl,
      listingCount: listings.length,
      listings,
      listingUrls,
    });
  } catch (err) {
    const screenshot = await page.screenshot({ encoding: "base64" }).catch(() => null);
    return finish({
      error: err?.message || String(err),
      url: finalUrl,
      screenshot,
      listings: [],
      listingUrls: [],
      listingCount: 0,
    });
  }
}
