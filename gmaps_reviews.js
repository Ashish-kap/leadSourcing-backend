// gmaps_reviews.js (Browserless Function API - Puppeteer)
// Extracts Google Maps reviews via the /function endpoint.
//
// context:
//   url (required)          - Google Maps place URL
//   maxReviews (default 50) - max reviews to return
//   maxScrolls (default 25) - scroll iterations
//   scrollWaitMs (default 900)
//   sort (default null)     - "newest" | "highest" | "lowest" | "relevant" | null
//   negativeOnly (false)    - keep only 1-2 star
//   reviewTimeRangeYears    - only reviews within last N years
//   hl / gl                 - locale overrides
//   debug (true)            - include _logs in response
//   screenshotOnError (false)

export default async function ({ page, context }) {
  const cfg = {
    url: null,
    maxReviews: 10,
    maxScrolls: 25,
    scrollWaitMs: 900,
    negativeOnly: false,
    reviewTimeRangeYears: null,
    sort: null,
    hl: "en",
    gl: "IN",
    debug: true,
    screenshotOnError: false,
    ...(context || {}),
  };

  const _logs = [];
  const log = (event, payload = {}) => {
    _logs.push({ event, at: new Date().toISOString(), ...payload });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const finish = (data) => ({
    data: { ...data, _logs: cfg.debug ? _logs : undefined },
    type: "application/json",
  });

  if (!cfg.url) {
    return finish({ error: "No url provided in context.url", reviews: [], reviewCount: 0 });
  }

  // Strip authuser param (meaningless without sign-in, can trigger limited view)
  let navUrl = cfg.url;
  try {
    const u = new URL(cfg.url);
    u.searchParams.delete("authuser");
    if (cfg.hl) u.searchParams.set("hl", cfg.hl);
    if (cfg.gl) u.searchParams.set("gl", cfg.gl);
    navUrl = u.toString();
  } catch (_) {}

  // ── Browser setup ─────────────────────────────────────────────────────────
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Block heavy resource types to reduce memory (same idea as browserlessContentClient / googleMapsScraper)
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

  // ── 1) Inject Google consent cookies BEFORE any navigation ────────────────
  // Prevents consent walls and "limited view"; use same pattern in gmaps_listings.js if data is missing.
  try {
    await page.setCookie(
      { name: "CONSENT", value: "PENDING+987", domain: ".google.com", path: "/" },
      { name: "SOCS", value: "CAISHAgCEhJnd3NfMjAyNDAyMDctMF9SQzIaAmVuIAEaBgiA_LyuBg", domain: ".google.com", path: "/" },
    );
    log("COOKIES_SET", { consent: true });
  } catch (e) {
    log("COOKIES_SET_FAIL", { error: e.message });
  }

  // ── 2) Pre-warm session via google.com ────────────────────────────────────
  // Visiting google.com first establishes session cookies/tokens that Google
  // expects. Without this, Maps often serves a "limited view".
  try {
    await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);

    // Dismiss any consent dialog on google.com
    await page.evaluate(() => {
      const labels = ["Accept all", "I agree", "Agree", "Accept", "Reject all"];
      const btns = Array.from(document.querySelectorAll("button"));
      const hit = btns.find((b) => labels.includes((b.innerText || "").replace(/\s+/g, " ").trim()));
      if (hit) hit.click();
    }).catch(() => {});
    await sleep(1000);

    log("PREWARM", { url: page.url(), title: await safeTitle(page) });
  } catch (e) {
    log("PREWARM_FAIL", { error: e.message });
  }

  // ── 3) Navigate to the Maps place URL ─────────────────────────────────────
  try {
    await page.goto(navUrl, { waitUntil: "networkidle0", timeout: 90000 });
  } catch (e) {
    return finish({
      error: `Navigation failed: ${e.message}`,
      url: navUrl,
      reviews: [],
      reviewCount: 0,
    });
  }

  await sleep(2000);
  log("NAV", { url: page.url(), title: await safeTitle(page) });

  // ── 4) Bot/block detection ────────────────────────────────────────────────
  const block = await page.evaluate(() => {
    const body = (document.body?.innerText || "").slice(0, 3000);
    return {
      looksLikeCaptcha:
        /sorry/i.test(document.title || "") ||
        /unusual traffic|automated queries|captcha/i.test(body) ||
        /\/sorry\//i.test(location.href),
      looksLikeConsent:
        /Before you continue/i.test(body) ||
        !!document.querySelector('form[action*="consent"]'),
      isLimitedView: /limited view of Google Maps/i.test(body),
    };
  });
  log("BLOCK_CHECK", block);

  // Dismiss consent if still present
  await page.evaluate(() => {
    const labels = ["Accept all", "I agree", "Agree", "Accept", "Reject all"];
    const btns = Array.from(document.querySelectorAll("button"));
    const hit = btns.find((b) => labels.includes((b.innerText || "").replace(/\s+/g, " ").trim()));
    if (hit) hit.click();
  }).catch(() => {});
  await sleep(800);

  // ── 5) Handle "limited view" - retry navigation ──────────────────────────
  if (block.isLimitedView) {
    log("LIMITED_VIEW_DETECTED", { msg: "Retrying navigation after session warm-up" });

    // Attempt A: reload the same page (cookies are now set from pre-warm)
    try {
      await page.goto(navUrl, { waitUntil: "networkidle0", timeout: 90000 });
      await sleep(3000);
    } catch (_) {}

    // Check if limited view persists
    const stillLimited = await page.evaluate(() =>
      /limited view of Google Maps/i.test((document.body?.innerText || "").slice(0, 3000))
    );

    if (stillLimited) {
      // Attempt B: try clicking the star rating area to open reviews
      const clickedRating = await page.evaluate(() => {
        const ratingEls = Array.from(document.querySelectorAll("span, div, button"));
        const target = ratingEls.find((el) => {
          const t = (el.textContent || "").trim();
          return /^\d\.\d$/.test(t) || /reviews?$/i.test(t);
        });
        if (target) { target.click(); return true; }
        return false;
      });
      log("LIMITED_VIEW_CLICK_RATING", { clickedRating });
      await sleep(3000);
    }

    const finalCheck = await page.evaluate(() => ({
      isLimitedView: /limited view of Google Maps/i.test((document.body?.innerText || "").slice(0, 3000)),
      tabCount: document.querySelectorAll('button[role="tab"]').length,
    }));
    log("LIMITED_VIEW_FINAL", finalCheck);
  }

  // ── 6) Open Reviews tab ───────────────────────────────────────────────────
  const openRes = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));

    const reviewsTab =
      tabs.find((b) => /reviews/i.test(norm(b.getAttribute("aria-label")))) ||
      tabs.find((b) => /reviews/i.test(norm(b.textContent)));

    if (!reviewsTab) {
      return {
        found: false,
        tabCount: tabs.length,
        tabLabels: tabs.map((t) => norm(t.getAttribute("aria-label") || t.textContent)).slice(0, 10),
      };
    }

    const selected = reviewsTab.getAttribute("aria-selected") === "true";
    if (!selected) reviewsTab.click();
    return { found: true, clicked: !selected, selectedBefore: selected };
  });
  log("OPEN_REVIEWS_TAB", openRes);

  if (!openRes.found) {
    let screenshotBase64 = null;
    if (cfg.screenshotOnError) {
      try { screenshotBase64 = await page.screenshot({ encoding: "base64", fullPage: true }); }
      catch (_) {}
    }
    return finish({
      error: "Reviews tab not found. Page may be in limited view or layout changed.",
      url: navUrl,
      diag: openRes,
      screenshotBase64,
      reviews: [],
      reviewCount: 0,
    });
  }

  // ── 7) Wait for review cards ──────────────────────────────────────────────
  const reviewsAppear = await page
    .waitForFunction(
      () => document.querySelectorAll("div.jftiEf[data-review-id]").length > 0,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);

  log("REVIEWS_APPEAR", { reviewsAppear });

  if (!reviewsAppear) {
    const diag = await page.evaluate(() => ({
      title: document.title || "",
      url: location.href,
      bodySnippet: (document.body?.innerText || "").slice(0, 1200),
      hasAnyReviewId: document.querySelectorAll("[data-review-id]").length,
      hasPf6ghf: !!document.querySelector(".m6QErb.Pf6ghf"),
      hasTabs: document.querySelectorAll('button[role="tab"]').length,
    }));
    log("NO_REVIEWS_DIAG", diag);

    let screenshotBase64 = null;
    if (cfg.screenshotOnError) {
      try { screenshotBase64 = await page.screenshot({ encoding: "base64", fullPage: true }); }
      catch (_) {}
    }
    return finish({
      error: "Review cards did not appear after clicking tab.",
      url: navUrl,
      diag,
      screenshotBase64,
      reviews: [],
      reviewCount: 0,
    });
  }

  // ── 8) Find scrollable container ──────────────────────────────────────────
  const scrollerSelector = await page.evaluate(() => {
    const first = document.querySelector("div.jftiEf[data-review-id]");
    if (!first) return null;

    const isScrollable = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      const oy = st.overflowY;
      return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 40;
    };

    let el = first;
    for (let i = 0; el && i < 30; i++) {
      if (isScrollable(el)) {
        el.setAttribute("data-bl-scroller", "1");
        return '[data-bl-scroller="1"]';
      }
      el = el.parentElement;
    }

    const pf = document.querySelector(".m6QErb.Pf6ghf");
    if (pf) {
      pf.setAttribute("data-bl-scroller", "1");
      return '[data-bl-scroller="1"]';
    }

    return null;
  });
  log("SCROLLER_FOUND", { scrollerSelector });

  if (!scrollerSelector) {
    return finish({
      error: "Could not find a scrollable reviews container.",
      url: navUrl,
      reviews: [],
      reviewCount: 0,
    });
  }

  // ── 9) Apply sort ─────────────────────────────────────────────────────────
  if (cfg.sort) {
    const sortMap = {
      newest: "Newest",
      highest: "Highest rating",
      lowest: "Lowest rating",
      relevant: "Most relevant",
    };
    const desired = sortMap[cfg.sort.toLowerCase()] || null;

    if (desired) {
      await page.evaluate(() => {
        const btn =
          document.querySelector('button[aria-label="Sort reviews"]') ||
          document.querySelector('button[data-value="Sort"]');
        if (btn) btn.click();
      });
      await sleep(900);

      const pickRes = await page.evaluate((desiredText) => {
        const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
        if (!items.length) return { menuItems: 0, picked: false };
        const target = items.find((el) => (el.textContent || "").includes(desiredText));
        if (!target) return { menuItems: items.length, picked: false };
        target.click();
        return { menuItems: items.length, picked: true, pickedText: (target.textContent || "").trim() };
      }, desired);

      log("SORT", { desired, ...pickRes });
      await sleep(1500);
    }
  }

  // ── 10) Scroll to load reviews + expand "More" ────────────────────────────
  let lastCount = 0;
  let stagnant = 0;

  for (let i = 0; i < cfg.maxScrolls; i++) {
    const count = await page.$$eval("div.jftiEf[data-review-id]", (els) => els.length).catch(() => 0);
    if (count >= cfg.maxReviews) break;

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }, scrollerSelector);

    await sleep(cfg.scrollWaitMs);

    await page.evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll('button[jsaction*="review.expandReview"], button.w8nwRe.kyuRq')
      );
      for (const b of btns) {
        try { if (b.getAttribute("aria-expanded") !== "true") b.click(); } catch (_) {}
      }
    });

    const newCount = await page.$$eval("div.jftiEf[data-review-id]", (els) => els.length).catch(() => 0);
    if (newCount <= lastCount) stagnant++;
    else stagnant = 0;
    lastCount = newCount;
    if (stagnant >= 3) break;

    if (i % 5 === 0) log("SCROLL_PROGRESS", { round: i, count: newCount });
  }

  // ── 11) Parse reviews ─────────────────────────────────────────────────────
  const parsed = await page.evaluate((opts) => {
    const { maxReviews, negativeOnly, reviewTimeRangeYears } = opts;

    const toInt = (s) => {
      const m = String(s || "").match(/([\d,]+)/);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    const parseRelativeDate = (dateText) => {
      const clean = String(dateText || "").replace("Edited", "").trim().toLowerCase();
      const now = new Date();
      const d = new Date(now);
      let m;
      if ((m = clean.match(/(\d+)\s*days?\s*ago/))) d.setDate(now.getDate() - parseInt(m[1]));
      else if (/^a\s+day\s+ago/.test(clean)) d.setDate(now.getDate() - 1);
      else if ((m = clean.match(/(\d+)\s*hours?\s*ago/))) d.setHours(now.getHours() - parseInt(m[1]));
      else if (/^an?\s+hour\s+ago/.test(clean)) d.setHours(now.getHours() - 1);
      else if ((m = clean.match(/(\d+)\s*weeks?\s*ago/))) d.setDate(now.getDate() - parseInt(m[1]) * 7);
      else if (/^a\s+week\s+ago/.test(clean)) d.setDate(now.getDate() - 7);
      else if ((m = clean.match(/(\d+)\s*months?\s*ago/))) d.setMonth(now.getMonth() - parseInt(m[1]));
      else if (/^a\s+month\s+ago/.test(clean)) d.setMonth(now.getMonth() - 1);
      else if ((m = clean.match(/(\d+)\s*years?\s*ago/))) d.setFullYear(now.getFullYear() - parseInt(m[1]));
      else if (/^a\s+year\s+ago/.test(clean)) d.setFullYear(now.getFullYear() - 1);
      return d;
    };

    const cutoff = new Date();
    if (Number.isFinite(reviewTimeRangeYears)) {
      cutoff.setFullYear(cutoff.getFullYear() - reviewTimeRangeYears);
    }

    const totalReviewsText =
      document.querySelector(".jANrlb .fontBodySmall")?.textContent?.trim() || null;
    const totalReviewsCount = totalReviewsText ? toInt(totalReviewsText) : null;

    const cards = Array.from(document.querySelectorAll("div.jftiEf[data-review-id]"));
    const out = [];
    const seen = new Set();

    for (const card of cards) {
      const reviewId = card.getAttribute("data-review-id") || null;

      const reviewerName =
        card.querySelector(".d4r55.fontTitleMedium")?.textContent?.trim() ||
        card.getAttribute("aria-label") ||
        null;

      const reviewerProfileUrl =
        card.querySelector('button[data-href*="/maps/contrib/"]')?.getAttribute("data-href") ||
        null;

      const ratingLabel =
        card.querySelector('span[role="img"][aria-label*="star"]')?.getAttribute("aria-label") ||
        null;
      const rating = ratingLabel ? toInt(ratingLabel) : null;

      const relativeDate = card.querySelector(".rsqaWe")?.textContent?.trim() || null;
      const dateObj = relativeDate ? parseRelativeDate(relativeDate) : null;

      if (Number.isFinite(reviewTimeRangeYears) && dateObj && dateObj < cutoff) continue;
      if (negativeOnly && rating != null && rating > 2) continue;

      const text = card.querySelector(".wiI7pd")?.textContent?.trim() || "";

      const key = reviewId || `${reviewerName}|${rating}|${relativeDate}|${text.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        reviewerName,
        reviewerProfileUrl,
        rating,
        relative_date: relativeDate,
        date: dateObj ? dateObj.toISOString() : null,
        text,
      });

      if (out.length >= maxReviews) break;
    }

    return { totalReviewsText, totalReviewsCount, extractedCount: out.length, reviews: out };
  }, {
    maxReviews: cfg.maxReviews,
    negativeOnly: cfg.negativeOnly,
    reviewTimeRangeYears: cfg.reviewTimeRangeYears,
  });

  log("PARSE_DONE", {
    extractedCount: parsed?.extractedCount,
    totalReviewsCount: parsed?.totalReviewsCount,
  });

  return finish({
    url: navUrl,
    totalReviewsText: parsed.totalReviewsText,
    totalReviewsCount: parsed.totalReviewsCount,
    reviewCount: parsed.extractedCount,
    reviews: parsed.reviews,
  });
}

async function safeTitle(page) {
  try { return await page.title(); }
  catch { return null; }
}
