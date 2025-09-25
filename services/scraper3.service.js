import { State, City, Country } from "country-state-city";
import dotenv from "dotenv";
dotenv.config();
import logger from "./logger.js";
import { extractFilteredReviews } from "./utils/extractFilteredReviews.js";
import { extractBusinessDetails } from "./businessDetailsExtractor.js";
import { createPopulationResolverAllTheCities } from "./utils/populationResolver.allTheCities.js";
import { BrowserPool } from "./utils/browserPool.js";

const defaultPopulationResolver = createPopulationResolverAllTheCities();

// ---- Tunables (or use env) ----
const CITY_CONCURRENCY = Number(process.env.CITY_CONCURRENCY || 2);
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 6);
const POOL_MAX_PAGES = Number(
  process.env.POOL_MAX_PAGES || CITY_CONCURRENCY + DETAIL_CONCURRENCY + 1
);
const SEARCH_NAV_TIMEOUT_MS = Number(
  process.env.SEARCH_NAV_TIMEOUT_MS || 60000
);
const DETAIL_NAV_TIMEOUT_MS = Number(
  process.env.DETAIL_NAV_TIMEOUT_MS || 30000
);

const BROWSER_SESSION_MAX_MS = Number(
  process.env.BROWSER_SESSION_MAX_MS || 55000
);
const BROWSER_SESSION_DRAIN_TIMEOUT_MS = Number(
  process.env.BROWSER_SESSION_DRAIN_TIMEOUT_MS || 10000
);
const BROWSER_SESSION_RETRY_LIMIT = Number(
  process.env.BROWSER_SESSION_RETRY_LIMIT || 3
);

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function calculatePercentage(processed, total) {
  return total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
}

const locationKey = (country, state, city) =>
  `${country}-${state || ""}-${city}`.toLowerCase().replace(/\s+/g, "-");

async function safeEvaluate(page, fn, ...args) {
  const timeout = 30000;
  return Promise.race([
    page.evaluate(fn, ...args),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`evaluate timed out after ${timeout}ms`)),
        timeout
      )
    ),
  ]);
}

// Simple in-file concurrency limiter (no deps)
function createLimiter(concurrency) {
  let active = 0;
  const q = [];
  const runNext = () => {
    if (active >= concurrency) return;
    const next = q.shift();
    if (!next) return;
    active++;
    const { fn, resolve, reject } = next;
    Promise.resolve()
      .then(fn)
      .then((v) => {
        active--;
        resolve(v);
        runNext();
      })
      .catch((err) => {
        active--;
        reject(err);
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      q.push({ fn, resolve, reject });
      runNext();
    });
}

/**
 * Scrolls the results panel only until at least `minCount` cards are present (or steps exhausted).
 */
async function scrollResultsPanelToCount(page, minCount, maxSteps = 24) {
  try {
    await page.waitForSelector(".Nv2PK", { timeout: 8000 });
  } catch (_) {
    // Panel not ready yet; keep going
  }
  await page.evaluate(
    async (minCount, maxSteps) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const scroller =
        document.querySelector('.m6QEr[aria-label][role="region"]') ||
        document.querySelector(".m6QEr") ||
        document.body;
      let steps = 0;
      let lastCount = 0;
      while (steps < maxSteps) {
        const cards = document.querySelectorAll(".Nv2PK");
        const count = cards.length;
        if (count >= minCount) break;
        scroller.scrollBy(0, 1200);
        await sleep(250);
        steps++;
        if (count === lastCount) {
          scroller.scrollBy(0, -200);
          await sleep(120);
          scroller.scrollBy(0, 1400);
        }
        lastCount = count;
      }
    },
    minCount,
    maxSteps
  );
}

/**
 * Extract listing metadata from the search page (pre-filtered).
 */
async function getListingsData(page, ratingFilter, reviewFilter) {
  return safeEvaluate(
    page,
    (ratingFilter, reviewFilter) => {
      return Array.from(document.querySelectorAll(".Nv2PK"))
        .map((listing) => {
          const anchor = listing.querySelector("a.hfpxzc");
          const url = anchor ? anchor.href : null;
          if (!url) return null;

          const ratingElement = listing.querySelector('.ZkP5Je[role="img"]');
          const ratingText = ratingElement?.getAttribute("aria-label") || "";
          const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          const reviewLabelElement = listing.querySelector(
            '[aria-label*="reviews"], [aria-label*="Reviews"]'
          );
          const reviewLabelText =
            reviewLabelElement?.getAttribute("aria-label") || "";
          const reviewMatch = reviewLabelText.match(/(\d+)\s+[Rr]eviews?/);
          const reviewCount = reviewMatch ? parseInt(reviewMatch[1], 10) : 0;

          const nameElement = listing.querySelector(".qBF1Pd");
          const businessName =
            nameElement?.textContent?.trim() || "Unknown Business";

          return { url, rating, reviewCount, businessName };
        })
        .filter(Boolean)
        .filter((item) => {
          if (ratingFilter && item.rating != null) {
            const { operator, value } = ratingFilter;
            if (
              (operator === "gt" && !(item.rating > value)) ||
              (operator === "gte" && !(item.rating >= value)) ||
              (operator === "lt" && !(item.rating < value)) ||
              (operator === "lte" && !(item.rating <= value))
            ) {
              return false;
            }
          }
          if (reviewFilter && item.reviewCount != null) {
            const { operator, value } = reviewFilter;
            if (
              (operator === "gt" && !(item.reviewCount > value)) ||
              (operator === "gte" && !(item.reviewCount >= value)) ||
              (operator === "lt" && !(item.reviewCount < value)) ||
              (operator === "lte" && !(item.reviewCount <= value))
            ) {
              return false;
            }
          }
          return true;
        });
    },
    ratingFilter,
    reviewFilter
  );
}

export async function runScraper(
  {
    keyword,
    countryCode,
    stateCode,
    city,
    maxRecords,
    ratingFilter = null,
    reviewFilter = null,
    reviewTimeRange = null,
    isExtractEmail = false,
    isValidate = false,

    // Population / ordering options
    minPopulation = 5000,
    populationResolver = defaultPopulationResolver,

    bigPopulationThreshold = 1_000_000,
    midPopulationThreshold = 100_000,
  },
  job
) {
  // ---------------- pooling + queues ----------------
  const createBrowserPool = async () => {
    const pool = new BrowserPool({
      maxPages: POOL_MAX_PAGES,
      navigationTimeoutMs: Math.max(
        SEARCH_NAV_TIMEOUT_MS,
        DETAIL_NAV_TIMEOUT_MS
      ),
      blockResources:
        String(process.env.BLOCK_HEAVY_RESOURCES || "true") === "true",
    });
    await pool.init();
    return pool;
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isSessionError = (error) => {
    if (!error) return false;
    const message = String(error.message || error.stack || "").toLowerCase();
    return (
      error.status === 408 ||
      message.includes("http status 408") ||
      message.includes("websocket is not open") ||
      message.includes("target closed") ||
      message.includes("session closed") ||
      message.includes("browser disconnected")
    );
  };

  const PAGE_POOL_REF = Symbol("poolRef");

  let browserPool = await createBrowserPool();
  let sessionStartedAt = Date.now();
  let refreshingPromise = null;
  let activePages = 0;

  const rotateBrowserSession = async (reason, meta = {}) => {
    if (refreshingPromise) {
      await refreshingPromise;
      return;
    }
    const previousPool = browserPool;
    refreshingPromise = (async () => {
      logger.warn("BROWSER_SESSION_REFRESH", "Refreshing browser session", {
        reason,
        ...meta,
      });
      const waitStart = Date.now();
      while (
        activePages > 0 &&
        Date.now() - waitStart < BROWSER_SESSION_DRAIN_TIMEOUT_MS
      ) {
        await wait(150);
      }
      if (activePages > 0) {
        logger.warn(
          "BROWSER_SESSION_FORCE_ROTATE",
          "Closing browser with active pages",
          {
            pendingPages: activePages,
          }
        );
      }
      try {
        await previousPool.close();
      } catch (closeError) {
        logger.warn("BROWSER_SESSION_CLOSE_ERROR", "Error closing browser", {
          message: closeError.message,
        });
      }
      browserPool = await createBrowserPool();
      sessionStartedAt = Date.now();
    })();
    try {
      await refreshingPromise;
    } finally {
      refreshingPromise = null;
    }
  };

  const ensureActiveSession = async () => {
    if (refreshingPromise) await refreshingPromise;
    if (Date.now() - sessionStartedAt >= BROWSER_SESSION_MAX_MS) {
      await rotateBrowserSession("ttl-expired");
    }
  };

  const acquirePage = async () => {
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      await ensureActiveSession();
      const poolRef = browserPool;
      try {
        const page = await poolRef.acquire();
        activePages += 1;
        page[PAGE_POOL_REF] = poolRef;
        return page;
      } catch (error) {
        const closedMessage =
          typeof error?.message === "string" &&
          error.message.toLowerCase().includes("browserpool closed");
        if (poolRef !== browserPool || closedMessage) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Failed to acquire page after refreshing browser session");
  };

  const releasePage = (page) => {
    if (!page) return;
    const poolRef = page[PAGE_POOL_REF] || browserPool;
    if (activePages > 0) activePages -= 1;
    try {
      if (poolRef && typeof poolRef.release === "function") {
        poolRef.release(page);
      } else if (
        typeof page.close === "function" &&
        !(typeof page.isClosed === "function" && page.isClosed())
      ) {
        page.close().catch(() => {});
      }
    } catch (_) {
      // ignore release errors
    } finally {
      delete page[PAGE_POOL_REF];
    }
  };

  const limitCity = createLimiter(CITY_CONCURRENCY);
  const limitDetail = createLimiter(DETAIL_CONCURRENCY);

  // ---------------- bookkeeping ----------------
  const results = [];
  const processedLocations = new Set();
  const recordLimit = maxRecords || Infinity;
  // Cooperative cancellation flag used to stop scheduling and tear down fast
  let shouldStop = false;
  const requestStop = () => {
    shouldStop = true;
  };

  const withPage = async (context, fn) => {
    let attempt = 0;
    let lastError;
    while (attempt < BROWSER_SESSION_RETRY_LIMIT) {
      attempt += 1;
      const page = await acquirePage();
      try {
        if (shouldStop) return null;
        return await fn(page);
      } catch (error) {
        lastError = error;
        if (isSessionError(error) && attempt < BROWSER_SESSION_RETRY_LIMIT) {
          logger.warn(
            "BROWSER_SESSION_RETRY",
            "Retrying task after session error",
            {
              context,
              attempt,
              maxAttempts: BROWSER_SESSION_RETRY_LIMIT,
              message: error.message,
            }
          );
          await rotateBrowserSession("error", {
            context,
            message: error.message,
          });
          continue;
        }
        throw error;
      } finally {
        releasePage(page);
      }
    }
    throw lastError;
  };

  const pushResult = (r) => {
    if (!r) return;
    if (results.length >= recordLimit) {
      requestStop();
      return;
    }
    results.push(r);
    if (results.length >= recordLimit) requestStop();
  };

  const country = Country.getCountryByCode(countryCode);
  if (!country) throw new Error(`Invalid country code: ${countryCode}`);
  const countryName = country.name;

  logger.info("SCRAPER_START", "Starting scraper (pooled)", {
    keyword,
    countryCode,
    stateCode,
    city,
    maxRecords,
    CITY_CONCURRENCY,
    DETAIL_CONCURRENCY,
    POOL_MAX_PAGES,
  });

  // ---------------- helpers ----------------
  const toCandidate = (cityObj, stateIsoCode = null, stateName = null) => ({
    cityName: cityObj.name,
    stateCode: stateIsoCode,
    stateName: stateName,
  });

  const listCitiesForScope = (iso2, stateIsoCode) => {
    if (stateIsoCode) {
      const state = State.getStateByCodeAndCountry(stateIsoCode, iso2);
      const sName = state?.name || null;
      const cities = City.getCitiesOfState(iso2, stateIsoCode) || [];
      return cities.map((c) => toCandidate(c, stateIsoCode, sName));
    }
    const states = (State.getStatesOfCountry(iso2) || []).filter(Boolean);
    if (states.length > 0) {
      const out = [];
      for (const s of states) {
        const cities = City.getCitiesOfState(iso2, s.isoCode) || [];
        for (const c of cities) out.push(toCandidate(c, s.isoCode, s.name));
      }
      return out;
    }
    const cities = City.getCitiesOfCountry(iso2) || [];
    return cities.map((c) => {
      const maybeState = c.stateCode
        ? State.getStateByCodeAndCountry(c.stateCode, iso2)
        : null;
      return toCandidate(c, c.stateCode || null, maybeState?.name || null);
    });
  };

  const bucketizeCandidates = async (candidates, scopeLabel) => {
    const buckets = { big: [], mid: [], small: [], unknown: [] };
    let total = 0;
    for (const cand of candidates) {
      let pop = null;
      try {
        if (populationResolver) {
          pop = await populationResolver({
            iso2: countryCode,
            adminCode: cand.stateCode || null,
            city: cand.cityName,
          });
        }
      } catch {
        pop = null;
      }
      if (minPopulation > 0 && pop !== null && pop < minPopulation) continue;

      const enriched = { ...cand, __pop: pop };
      if (pop === null) buckets.unknown.push(enriched);
      else if (pop >= bigPopulationThreshold) buckets.big.push(enriched);
      else if (pop >= midPopulationThreshold) buckets.mid.push(enriched);
      else buckets.small.push(enriched);
      total++;
    }
    shuffleArray(buckets.big);
    shuffleArray(buckets.mid);
    shuffleArray(buckets.small);
    shuffleArray(buckets.unknown);

    logger.info("CITY_BUCKETS", "Bucketized candidates", {
      scope: scopeLabel,
      totalCandidates: total,
      thresholds: {
        minPopulation,
        midPopulationThreshold,
        bigPopulationThreshold,
      },
      counts: {
        big: buckets.big.length,
        mid: buckets.mid.length,
        small: buckets.small.length,
        unknown: buckets.unknown.length,
      },
    });
    return buckets;
  };

  const updateProgress = async (extra = {}) => {
    if (!job) return;
    const percentage =
      results.length >= recordLimit
        ? 100
        : calculatePercentage(results.length, recordLimit);
    await job.progress({
      percentage,
      recordsCollected: results.length,
      maxRecords: recordLimit,
      ...extra,
    });
  };

  // -------- Tier B: detail worker --------
  const detailTasks = [];
  const scheduleDetail = (url, meta) => {
    if (shouldStop) return;
    const p = limitDetail(async () => {
      // Re-check stop as soon as the task actually starts
      if (shouldStop) return null;
      try {
        return await withPage(`detail:${url}`, async (page) => {
          if (shouldStop) return null;
          // Faster nav: domcontentloaded + short timeout
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: DETAIL_NAV_TIMEOUT_MS,
          });
          // In case stop was requested during navigation, exit before parsing
          if (shouldStop) return null;

          const locationString = [meta.city, meta.state, meta.countryName]
            .filter(Boolean)
            .join(", ");
          const businessData = await extractBusinessDetails(
            page,
            page.browser(),
            meta.keyword,
            locationString,
            null,
            null,
            meta.isExtractEmail,
            meta.isValidate
          );

          if (!businessData) return null;

          // Optional review filtering on the same page
          if (meta.reviewTimeRange) {
            try {
              const filteredReviews = await extractFilteredReviews(
                page,
                meta.reviewTimeRange
              );
              businessData.filtered_reviews = filteredReviews;
              businessData.filtered_review_count = filteredReviews.length;
            } catch (err) {
              // non-fatal
            }
          }

          businessData.url = url;
          pushResult(businessData);

          await updateProgress({
            currentLocation: `${meta.city}, ${meta.state || ""}, ${
              meta.countryName
            }`.replace(/,\s*,/g, ","),
          });

          return businessData;
        });
      } catch (error) {
        logger.error("LISTING_ERROR", "Error processing listing", {
          url,
          error: error.message,
        });
        return null;
      }
    });
    detailTasks.push(p);
  };

  // -------- Tier A: city discovery --------
  async function scrapeCity({ cityName, stateCode, stateName }) {
    if (shouldStop) return;

    const key = locationKey(countryCode, stateCode, cityName);
    if (processedLocations.has(key)) {
      logger.info("LOCATION_SKIP", "Skipping already processed location", {
        city: cityName,
        state: stateName,
        country: countryName,
      });
      return;
    }
    processedLocations.add(key);

    const searchUrlBase = `https://www.google.com/maps/search/`;
    const formattedLocation = [cityName, stateName, countryName]
      .filter(Boolean)
      .join(" ")
      .replace(/,/g, "")
      .replace(/\s+/g, "+");
    const query = `${encodeURIComponent(keyword)}+in+${formattedLocation}`;
    // Stabilize locale a bit (optional)
    const searchUrl = `${searchUrlBase}${query}?hl=en`;

    logger.info("CITY_SCRAPE_START", "Scraping city (discovery only)", {
      url: searchUrl,
      city: cityName,
      state: stateName,
      country: countryName,
    });

    try {
      await withPage(`city:${cityName}`, async (page) => {
        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded", // faster than networkidle2
          timeout: SEARCH_NAV_TIMEOUT_MS,
        });

        // How many listings do we still need overall?
        const remaining = recordLimit - results.length;
        if (remaining <= 0) {
          shouldStop = true;
          return;
        }

        // Early-stop scroll: aim for enough to more than cover failures.
        const neededForCity = Math.min(remaining, 30);
        const targetCount = Math.ceil(neededForCity * 1.5);
        await scrollResultsPanelToCount(page, targetCount);

        const listingsData = await getListingsData(
          page,
          ratingFilter,
          reviewFilter
        );

        // Logging + progress
        const totalListingsFound = await safeEvaluate(page, () => {
          return document.querySelectorAll(".Nv2PK").length;
        });
        logger.info("FILTER_RESULTS", "Pre-filtering results", {
          location: `${cityName}, ${stateName}, ${countryName}`,
          totalBusinessesFound: totalListingsFound,
          matchingFilter: listingsData.length,
          filteredOut: totalListingsFound - listingsData.length,
          ratingFilter,
          reviewFilter,
          filterEfficiency: `${(
            (listingsData.length / Math.max(totalListingsFound, 1)) *
            100
          ).toFixed(1)}%`,
        });

        if (listingsData.length === 0) return;

        // Schedule details globally (Tier B)
        const urls = listingsData.map((x) => x.url);
        const toSchedule = Math.min(urls.length, remaining);
        const meta = {
          keyword,
          city: cityName,
          state: stateName,
          countryName,
          isExtractEmail,
          isValidate,
          reviewTimeRange,
        };

        for (let i = 0; i < toSchedule && !shouldStop; i++) {
          scheduleDetail(urls[i], meta);
        }
      });
    } catch (error) {
      logger.error("CITY_SCRAPE_ERROR", "Error scraping city", {
        city: cityName,
        state: stateName,
        error: error.message,
      });
    }
  }

  // ------- Phased bucket processing with parallel city discovery -------
  const runBuckets = async (buckets, scopeLabel) => {
    const order = ["big", "mid", "small", "unknown"];
    for (const bucketName of order) {
      if (shouldStop) break;
      const list = buckets[bucketName];
      const cityPromises = [];
      for (const cand of list) {
        if (shouldStop || results.length >= recordLimit) break;
        cityPromises.push(
          limitCity(() =>
            scrapeCity({
              cityName: cand.cityName,
              stateCode: cand.stateCode,
              stateName: cand.stateName,
            })
          )
        );
      }
      // Wait all cities in this bucket to complete discovery
      await Promise.allSettled(cityPromises);
    }
  };

  try {
    // Scenario 1: exact city + state
    if (city && stateCode) {
      logger.info("MODE_FULL_LOCATION", "Using exact location", {
        city,
        state: stateCode,
        country: countryName,
      });
      const state = State.getStateByCodeAndCountry(stateCode, countryCode);
      if (!state)
        throw new Error(
          `Invalid state code: ${stateCode} for country: ${countryCode}`
        );

      await limitCity(() =>
        scrapeCity({ cityName: city, stateCode, stateName: state.name })
      );
    }
    // Scenario 2: state only
    else if (stateCode) {
      logger.info("MODE_STATE_ONLY", "Scraping all cities in state", {
        state: stateCode,
        country: countryName,
      });
      const state = State.getStateByCodeAndCountry(stateCode, countryCode);
      if (!state)
        throw new Error(
          `Invalid state code: ${stateCode} for country: ${countryCode}`
        );

      const candidates = listCitiesForScope(countryCode, stateCode);
      const buckets = await bucketizeCandidates(
        candidates,
        `state:${state.name}`
      );
      await runBuckets(buckets, `state:${state.name}`);
    }
    // Scenario 3: country only
    else {
      logger.info("MODE_COUNTRY_ONLY", "Scraping entire country", {
        country: countryName,
      });
      const candidates = listCitiesForScope(countryCode /* no state */);
      const buckets = await bucketizeCandidates(
        candidates,
        `country:${countryName}`
      );
      await runBuckets(buckets, `country:${countryName}`);
    }

    // If we've hit the record limit, don't wait on outstanding detail tasks.
    // Close the browser pool first to force-fast fail any in-flight navigations.
    if (!shouldStop) {
      await Promise.allSettled(detailTasks);
    } else {
      // Prevent unhandled rejections for tasks we won't await
      for (const t of detailTasks) t.catch(() => {});
    }
  } finally {
    // Close browser resources; if shouldStop was requested this will abort in-flight work
    if (refreshingPromise) {
      await refreshingPromise;
    }
    await browserPool.close();

    // Finalize progress after cleanup
    const finalPercentage =
      results.length >= recordLimit
        ? 100
        : calculatePercentage(results.length, recordLimit);

    if (job) {
      await job.progress({
        percentage: finalPercentage,
        status: "completed",
        recordsCollected: results.length,
        maxRecords: recordLimit,
      });
    }
  }

  return results.slice(0, recordLimit);
}
