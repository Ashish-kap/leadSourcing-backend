import { State, City, Country } from "country-state-city";
import dotenv from "dotenv";
dotenv.config();
import logger from "./logger.js";
import { extractFilteredReviews } from "./utils/extractFilteredReviews.js";
import { extractBusinessDetails } from "./businessDetailsExtractor.js";
import { createPopulationResolverAllTheCities } from "./utils/populationResolver.allTheCities.js";
import { BrowserPool } from "./utils/browserPool.js";
import {
  createCityZones,
  generateZoneBatch,
} from "./utils/cityZoneGenerator.js";
import { ProgressMonitor, getStuckJobConfig } from "./stuckJobDetector.js";

const defaultPopulationResolver = createPopulationResolverAllTheCities();

// Get stuck job detection configuration
const { STUCK_RECORDS_TIMEOUT_MS, STUCK_PERCENTAGE_TIMEOUT_MS, STUCK_JOB_GRACE_PERIOD_MS } = getStuckJobConfig();

// ---- Tunables (or use env) - Optimized for speed & cost ----
// const CITY_CONCURRENCY = Number(process.env.CITY_CONCURRENCY || 2);
// const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 6);
// const POOL_MAX_PAGES = Number(process.env.POOL_MAX_PAGES || 10);

// Reduced defaults to minimize memory usage (3-4GB instead of 7-8GB)
const CITY_CONCURRENCY = Number(process.env.CITY_CONCURRENCY || 2);
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 8);
const POOL_MAX_PAGES = Number(process.env.POOL_MAX_PAGES || 10);
const SEARCH_NAV_TIMEOUT_MS = Number(
  process.env.SEARCH_NAV_TIMEOUT_MS || 45000
);
const DETAIL_NAV_TIMEOUT_MS = Number(
  process.env.DETAIL_NAV_TIMEOUT_MS || 25000
);

const BROWSER_SESSION_MAX_MS = Number(
  process.env.BROWSER_SESSION_MAX_MS || 60000 // 60 seconds - allows 10 concurrent email scrapes (each 10-30s)
);
const BROWSER_SESSION_DRAIN_TIMEOUT_MS = Number(
  process.env.BROWSER_SESSION_DRAIN_TIMEOUT_MS || 3000
);
const BROWSER_SESSION_RETRY_LIMIT = Number(
  process.env.BROWSER_SESSION_RETRY_LIMIT || 1
);

// Deep scrape batched zone configuration - Enhanced for better coverage
const ZONE_BATCH_SIZE = Number(process.env.ZONE_BATCH_SIZE || 50); // Increased from 30 to 50
const MAX_TOTAL_ZONES = Number(process.env.MAX_TOTAL_ZONES || 3000); // Increased from 300 to 800 for large cities

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
  try {
    return await Promise.race([
      page.evaluate(fn, ...args),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`evaluate timed out after ${timeout}ms`)),
          timeout
        )
      ),
    ]);
  } catch (error) {
    // Handle execution context errors gracefully
    if (
      error.message &&
      error.message.includes("Execution context was destroyed")
    ) {
      logger.warn(
        "SAFE_EVALUATE_CONTEXT_DESTROYED",
        "Execution context was destroyed during evaluation",
        {
          error: error.message,
        }
      );
      return null; // Return null instead of throwing
    }
    throw error;
  }
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
 * 
 */
async function scrollResultsPanelToCount(page, minCount, maxSteps = 25) {
  try {
    await page.waitForSelector(".Nv2PK", { timeout: 8000 });
  } catch (_) {
    // Panel not ready yet; keep going
  }
  await page.evaluate(
    async (minCount, maxSteps) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      
      // Try multiple selectors for the scrollable container based on actual Google Maps structure
      const scroller =
        document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd[role="feed"]') ||
        document.querySelector('.m6QErb[role="feed"]') ||
        document.querySelector('[role="feed"]') ||
        document.querySelector('.m6QErb[aria-label*="Results"]') ||
        document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd') ||
        document.querySelector('.m6QErb') ||
        document.querySelector('.m6QEr') ||
        document.body;
      
  
      
      let steps = 0;
      let lastCount = 0;
      let stagnantCount = 0;
      
      while (steps < maxSteps) {
        const cards = document.querySelectorAll(".Nv2PK");
        const count = cards.length;
        
        if (count >= minCount) {
          break;
        }
        
        // Enhanced scrolling with larger distances
        scroller.scrollBy(0, 2000); // Increased from 1200
        await sleep(500); // Increased from 250ms
        steps++;
        
        // Check if we're getting new results
        if (count === lastCount) {
          stagnantCount++;
          
          // Try different scroll patterns to trigger loading
          if (stagnantCount % 3 === 0) {
            scroller.scrollBy(0, -500);
            await sleep(200);
            scroller.scrollBy(0, 2500);
            await sleep(300);
          } else if (stagnantCount % 2 === 0) {
            // Try scrolling to bottom and back
            scroller.scrollTo(0, scroller.scrollHeight);
            await sleep(400);
            scroller.scrollBy(0, -1000);
            await sleep(200);
            scroller.scrollBy(0, 2000);
          }
        } else {
          stagnantCount = 0; // Reset if we got new results
        }
        
        lastCount = count;
        
        // If we've been stagnant for too long, try a different approach
        if (stagnantCount >= 5) {
          // Scroll to very bottom to trigger "show more" or similar
          scroller.scrollTo(0, scroller.scrollHeight);
          await sleep(1000);
          scroller.scrollBy(0, -2000);
          await sleep(500);
          scroller.scrollBy(0, 3000);
          stagnantCount = 0;
        }
        
        // Try to trigger "load more" by scrolling to absolute bottom
        if (stagnantCount >= 4) {
          // Scroll to absolute bottom of the feed
          const feedElement = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd[role="feed"]') ||
                             document.querySelector('.m6QErb[role="feed"]');
          if (feedElement) {
            feedElement.scrollTop = feedElement.scrollHeight;
            await sleep(1000);
            // Try scrolling a bit more to trigger loading
            feedElement.scrollBy(0, 1000);
            await sleep(500);
          }
        }
        
        // Try alternative scroll methods if normal scrolling isn't working
        if (stagnantCount >= 3) {
          
          // Method 1: Try scrolling the window
          window.scrollBy(0, 2000);
          await sleep(300);
          
          // Method 2: Try scrolling the document
          document.documentElement.scrollBy(0, 2000);
          await sleep(300);
          
          // Method 3: Try scrolling the main container
          const mainContainer = document.querySelector('.m6QErb[role="feed"]') || 
                               document.querySelector('[role="feed"]') ||
                               document.querySelector('.m6QErb') ||
                               document.querySelector('div[role="main"]');
          if (mainContainer) {
            mainContainer.scrollBy(0, 2000);
            await sleep(300);
          }
          
          // Method 4: Try scrolling the specific feed container from your HTML
          const feedContainer = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd[role="feed"]');
          if (feedContainer) {
            feedContainer.scrollBy(0, 2000);
            await sleep(300);
          }
          
          // Method 5: Try scrolling the exact container with all classes
          const exactContainer = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd');
          if (exactContainer && exactContainer !== feedContainer) {
            exactContainer.scrollBy(0, 2000);
            await sleep(300);
          }
          
          // Method 6: Try scrolling the parent container
          const parentContainer = document.querySelector('.m6QErb.WNBkOb.XiKgde[role="main"]');
          if (parentContainer) {
            parentContainer.scrollBy(0, 2000);
            await sleep(300);
          }
        }
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
    extractNegativeReviews = false,

    // Population / ordering options
    minPopulation = 5000,
    populationResolver = defaultPopulationResolver,

    bigPopulationThreshold = 1_000_000,
    midPopulationThreshold = 100_000,
  },
  job
) {
  // Memory tracking helper
  const logMemory = (label) => {
    const usage = process.memoryUsage();
    logger.info("MEMORY_USAGE", label, {
      rss: `${(usage.rss / 1024 / 1024).toFixed(0)} MB`,
      heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(0)} MB`,
      external: `${(usage.external / 1024 / 1024).toFixed(0)} MB`,
    });
  };

  // Job timeout to prevent memory bloat from long-running jobs
  const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 5400000); // Default: 3 hours (increased from 2 hours)
  const jobStartTime = Date.now();

  const checkJobTimeout = () => {
    const elapsed = Date.now() - jobStartTime;
    if (elapsed > JOB_TIMEOUT_MS) {
      logger.warn(
        "JOB_TIMEOUT",
        "Job exceeded maximum duration, stopping gracefully",
        {
          elapsed: `${Math.round(elapsed / 1000 / 60)} minutes`,
          maxDuration: `${Math.round(JOB_TIMEOUT_MS / 1000 / 60)} minutes`,
          recordsCollected: results.length,
        }
      );
      return true;
    }
    return false;
  };

  // Log initial memory and config
  logMemory("SCRAPER_START");
  logger.info("SCRAPER_CONFIG", "Current configuration", {
    CITY_CONCURRENCY,
    DETAIL_CONCURRENCY,
    POOL_MAX_PAGES,
    BROWSER_SESSION_MAX_MS,
    maxRecords,
    jobTimeoutMinutes: Math.round(JOB_TIMEOUT_MS / 1000 / 60),
    stuckDetection: {
      recordsTimeoutMinutes: Math.round(STUCK_RECORDS_TIMEOUT_MS / 1000 / 60),
      percentageTimeoutMinutes: Math.round(STUCK_PERCENTAGE_TIMEOUT_MS / 1000 / 60),
      gracePeriodSeconds: Math.round(STUCK_JOB_GRACE_PERIOD_MS / 1000),
    },
  });

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
      message.includes("browser disconnected") ||
      message.includes("execution context was destroyed") ||
      message.includes("protocol error")
    );
  };

  const PAGE_POOL_REF = Symbol("poolRef");

  let browserPool = await createBrowserPool();
  logMemory("AFTER_BROWSER_POOL_INIT");

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

  const releasePage = async (page) => {
    if (!page) return;
    const poolRef = page[PAGE_POOL_REF] || browserPool;
    if (activePages > 0) activePages -= 1;
    try {
      if (poolRef && typeof poolRef.release === "function") {
        await poolRef.release(page);
      } else if (
        typeof page.close === "function" &&
        !(typeof page.isClosed === "function" && page.isClosed())
      ) {
        await page.close().catch(() => {});
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
  const seenBusinessUrls = new Set(); // Track business URLs to prevent duplicates (checked at listing level)
  const recordLimit = maxRecords || Infinity;
  // Cooperative cancellation flag used to stop scheduling and tear down fast
  let shouldStop = false;
  const requestStop = () => {
    shouldStop = true;
  };

  // Initialize progress monitor for stuck job detection
  const progressMonitor = new ProgressMonitor(job?.data?.jobId || 'unknown');

  // Import Job model for cancellation checking
  const { default: JobModel } = await import("../models/jobModel.js");

  // Periodic cancellation check - monitors database for job deletion/cancellation AND timeout
  const cancellationCheckInterval = setInterval(async () => {
    try {
      // Check job timeout
      if (checkJobTimeout()) {
        requestStop();
        clearInterval(cancellationCheckInterval);
        return;
      }

      // Check for stuck job conditions
      const percentage = results.length >= recordLimit
        ? 100
        : calculatePercentage(results.length, recordLimit);
      const stuckStatus = progressMonitor.updateProgress(results.length, percentage);
      
      if (stuckStatus.isStuck && !shouldStop) {
        logger.warn(
          "JOB_STUCK_DETECTED_INTERVAL",
          `Job ${job?.data?.jobId} detected as stuck in interval check`,
          {
            reason: stuckStatus.reason,
            recordsCollected: results.length,
            percentage,
            stuckFor: Math.round(stuckStatus.stuckFor / 1000),
          }
        );
        requestStop();
        clearInterval(cancellationCheckInterval);
        return;
      }

      // Check job cancellation in database
      if (job && job.data && job.data.jobId) {
        const dbJob = await JobModel.findOne({ jobId: job.data.jobId });
        // If job is deleted or marked as failed, stop the scraping
        if (!dbJob || dbJob.status === "failed") {
          logger.warn(
            "JOB_CANCELLED",
            `Job ${job.data.jobId} was cancelled - stopping scraper`
          );
          requestStop();
          clearInterval(cancellationCheckInterval);
        }
      }
    } catch (error) {
      logger.error(
        "CANCELLATION_CHECK_ERROR",
        "Error checking job cancellation",
        {
          error: error.message,
        }
      );
    }
  }, 30000); // Check every 30 seconds for stuck detection

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
        await releasePage(page);
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
    // Duplicate checking is now handled at URL level during listing scraping
    // No need to check here since we already filtered duplicates before scheduling
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
    if (shouldStop) return; // Don't emit progress if job is cancelled
    const percentage =
      results.length >= recordLimit
        ? 100
        : calculatePercentage(results.length, recordLimit);
    
    // Check for stuck job conditions
    const stuckStatus = progressMonitor.updateProgress(results.length, percentage);
    
    // If job is stuck, trigger graceful termination
    if (stuckStatus.isStuck && !shouldStop) {
      logger.warn(
        "JOB_STUCK_TERMINATION",
        `Job ${job.data?.jobId} is stuck - initiating graceful termination`,
        {
          reason: stuckStatus.reason,
          recordsCollected: results.length,
          percentage,
          stuckFor: Math.round(stuckStatus.stuckFor / 1000),
        }
      );
      
      // Set stop flag to begin graceful shutdown
      requestStop();
      
      // Update job status in database to indicate stuck timeout
      try {
        const { default: JobModel } = await import("../models/jobModel.js");
        const dbJob = await JobModel.findOne({ jobId: job.data.jobId });
        if (dbJob && dbJob.status !== "failed") {
          await dbJob.updateStatus("stuck_timeout", {
            "progress.stuckDetection": {
              isStuck: true,
              stuckReason: stuckStatus.reason,
              stuckAt: new Date(),
              recordsStuckFor: stuckStatus.recordsStuckFor,
              percentageStuckFor: stuckStatus.percentageStuckFor,
            },
            "progress.lastRecordsUpdate": new Date(progressMonitor.lastRecordsUpdate),
            "progress.lastPercentageUpdate": new Date(progressMonitor.lastPercentageUpdate),
          });
        }
      } catch (dbError) {
        logger.error("STUCK_JOB_DB_UPDATE_ERROR", "Failed to update stuck job status", {
          jobId: job.data?.jobId,
          error: dbError.message,
        });
      }
    }
    
    try {
      await job.progress({
        percentage,
        recordsCollected: results.length,
        maxRecords: recordLimit,
        stuckDetection: stuckStatus,
        ...extra,
      });
    } catch (progressError) {
      // Job might be cancelled/deleted - silently ignore
      logger.warn("PROGRESS_UPDATE_ERROR", "Failed to update progress", {
        jobId: job.data?.jobId,
        message: progressError.message,
      });
    }
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

          // Faster nav with retry logic
          try {
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: DETAIL_NAV_TIMEOUT_MS,
            });
          } catch (navError) {
            // If navigation fails, try once more with longer timeout
            logger.warn("NAVIGATION_RETRY", `Retrying navigation for ${url}`);
            await page.goto(url, {
              waitUntil: "networkidle2",
              timeout: DETAIL_NAV_TIMEOUT_MS + 10000,
            });
          }

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
          if (meta.reviewTimeRange || meta.extractNegativeReviews) {
            try {
              const filteredReviews = await extractFilteredReviews(page, {
                reviewTimeRange: meta.reviewTimeRange,
                ratingFilter: meta.extractNegativeReviews ? "negative" : null,
              });
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
  async function scrapeCity({
    cityName,
    stateCode,
    stateName,
    coords = null,
    zoneLabel = null,
  }) {
    if (shouldStop) return;

    // Create unique key for this zone (includes coordinates if present)
    const zoneKey = coords
      ? `${locationKey(countryCode, stateCode, cityName)}-${coords.lat}-${
          coords.lng
        }`
      : locationKey(countryCode, stateCode, cityName);

    if (processedLocations.has(zoneKey)) {
      logger.info("LOCATION_SKIP", "Skipping already processed zone", {
        city: cityName,
        state: stateName,
        country: countryName,
        zone: zoneLabel || "center",
      });
      return;
    }
    processedLocations.add(zoneKey);

    const searchUrlBase = `https://www.google.com/maps/search/`;
    let searchUrl;

    // If coordinates provided, use coordinate-based search
    if (coords) {
      // Format: keyword/@latitude,longitude,zoom
      const query = encodeURIComponent(keyword);
      const coordString = `@${coords.lat},${coords.lng},14z`; // 14z is good zoom level for local area
      searchUrl = `${searchUrlBase}${query}/${coordString}?hl=en`;
    } else {
      // Standard location-based search
      const formattedLocation = [cityName, stateName, countryName]
        .filter(Boolean)
        .join(" ")
        .replace(/,/g, "")
        .replace(/\s+/g, "+");
      const query = `${encodeURIComponent(keyword)}+in+${formattedLocation}`;
      searchUrl = `${searchUrlBase}${query}?hl=en`;
    }

    logger.info("CITY_SCRAPE_START", "Scraping city zone (discovery only)", {
      url: searchUrl,
      city: cityName,
      state: stateName,
      country: countryName,
      zone: zoneLabel || "center",
      coords: coords || "N/A",
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

        // Enhanced scroll: aim for more results to ensure good coverage
        const neededForCity = Math.min(remaining, 50); // Increased from 30
        const targetCount = Math.ceil(neededForCity * 2.0); // Increased multiplier from 1.5
        
        logger.info("ENHANCED_SCROLL_START", "Starting enhanced scrolling for better coverage", {
          city: cityName,
          neededForCity,
          targetCount,
          remaining,
          currentResults: results.length,
        });
        
        // Debug: Check initial card count
        const initialCards = await page.evaluate(() => document.querySelectorAll(".Nv2PK").length);
        logger.info("SCROLL_DEBUG", "Initial card count before scrolling", {
          city: cityName,
          initialCards,
          targetCount,
        });
        
        // Try the enhanced scroll function first
        try {
          if (page.isClosed() || !page.target()) {
            logger.warn("ENHANCED_SCROLL_SKIPPED", "Page is closed or disconnected, skipping enhanced scroll", {
              city: cityName,
              isClosed: page.isClosed(),
              hasTarget: !!page.target(),
            });
          } else {
            await scrollResultsPanelToCount(page, targetCount);
          }
        } catch (scrollError) {
          logger.warn("ENHANCED_SCROLL_FAILED", "Enhanced scroll failed", {
            city: cityName,
            error: scrollError.message,
            targetCount,
          });
          // Continue with whatever results we have
        }
        
        // Check results after scrolling
        let cardsAfterScroll = 0;
        try {
          if (!page.isClosed() && page.target()) {
            cardsAfterScroll = await page.evaluate(() => document.querySelectorAll(".Nv2PK").length);
            logger.info("SCROLL_RESULTS", "Cards found after scrolling", {
              city: cityName,
              initialCards,
              cardsAfterScroll,
              targetCount,
              improvement: cardsAfterScroll - initialCards,
            });
          } else {
            logger.warn("SCROLL_EVAL_SKIPPED", "Page is closed or disconnected, skipping card evaluation", {
              city: cityName,
              isClosed: page.isClosed(),
              hasTarget: !!page.target(),
            });
            cardsAfterScroll = initialCards;
          }
        } catch (evalError) {
          if (evalError.message.includes('Execution context was destroyed') ||
              evalError.message.includes('Target closed') ||
              evalError.message.includes('detached Frame')) {
            logger.warn("SCROLL_EVAL_CONTEXT_DESTROYED", "Card evaluation failed due to destroyed context", {
              city: cityName,
              error: evalError.message,
              errorType: evalError.constructor.name,
            });
          } else {
            logger.warn("SCROLL_EVAL_FAILED", "Could not evaluate cards after scroll", {
              city: cityName,
              error: evalError.message,
            });
          }
          // Use initial cards count as fallback
          cardsAfterScroll = initialCards;
        }
        
        // If that didn't work well, try the autoScroll function as fallback
        if (cardsAfterScroll < targetCount * 0.5) { // If we got less than half the target
          // Check if we should skip autoScroll due to browser session issues
          if (page.isClosed() || !page.target()) {
            logger.warn("FALLBACK_SCROLL_SKIPPED", "Skipping autoScroll due to closed/disconnected page", {
              city: cityName,
              cardsAfterScroll,
              targetCount,
              isClosed: page.isClosed(),
              hasTarget: !!page.target(),
            });
          } else {
            logger.info("FALLBACK_SCROLL", "Using autoScroll as fallback", {
              city: cityName,
              cardsAfterScroll,
              targetCount,
            });
            
            try {
              // Check if page is still valid before attempting autoScroll
              if (page.isClosed() || !page.target()) {
                logger.warn("FALLBACK_SCROLL_SKIPPED", "Page is closed or disconnected, skipping autoScroll", {
                  city: cityName,
                  isClosed: page.isClosed(),
                  hasTarget: !!page.target(),
                });
                return;
              }
            
            // Import and use the autoScroll function with timeout protection
            const autoScroll = (await import("./autoScroll.js")).default;
            
            // Wrap autoScroll in additional error handling for target close errors
            await Promise.race([
              autoScroll(page).catch(error => {
                if (error.message.includes('Target closed') || 
                    error.message.includes('detached Frame') ||
                    error.message.includes('Execution context was destroyed') ||
                    error.message.includes('Protocol error')) {
                  logger.warn("AUTO_SCROLL_TARGET_CLOSED", "AutoScroll failed due to closed target or destroyed context", {
                    city: cityName,
                    error: error.message,
                    errorType: error.constructor.name,
                  });
                  return; // Don't throw, just return gracefully
                }
                throw error; // Re-throw other errors
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error("AutoScroll timeout")), 15000)
              )
            ]);
            
            // Check final results
            try {
              if (!page.isClosed() && page.target()) {
                const finalCards = await page.evaluate(() => document.querySelectorAll(".Nv2PK").length);
                logger.info("FALLBACK_SCROLL_RESULTS", "Cards after fallback scroll", {
                  city: cityName,
                  finalCards,
                  improvement: finalCards - cardsAfterScroll,
                });
              } else {
                logger.warn("FALLBACK_EVAL_SKIPPED", "Page is closed or disconnected, skipping final evaluation", {
                  city: cityName,
                  isClosed: page.isClosed(),
                  hasTarget: !!page.target(),
                });
              }
            } catch (finalEvalError) {
              if (finalEvalError.message.includes('Execution context was destroyed') ||
                  finalEvalError.message.includes('Target closed') ||
                  finalEvalError.message.includes('detached Frame')) {
                logger.warn("FALLBACK_EVAL_CONTEXT_DESTROYED", "Final evaluation failed due to destroyed context", {
                  city: cityName,
                  error: finalEvalError.message,
                  errorType: finalEvalError.constructor.name,
                });
              } else {
                logger.warn("FALLBACK_EVAL_FAILED", "Could not evaluate final cards", {
                  city: cityName,
                  error: finalEvalError.message,
                });
              }
            }
            } catch (fallbackError) {
              logger.warn("FALLBACK_SCROLL_FAILED", "AutoScroll fallback failed", {
                city: cityName,
                error: fallbackError.message,
                cardsAfterScroll,
              });
              // Continue with whatever results we have
            }
          }
        }

        const listingsData = await getListingsData(
          page,
          ratingFilter,
          reviewFilter
        );

        // Handle case where execution context was destroyed
        if (!listingsData) {
          logger.warn(
            "CITY_SCRAPE_NO_DATA",
            "No listings data returned (execution context may have been destroyed)",
            {
              city: cityName,
              state: stateName,
              zone: zoneLabel || "center",
            }
          );
          return;
        }

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

        // Filter out duplicate URLs before scheduling details (Tier B)
        const allUrls = listingsData.map((x) => x.url);
        const uniqueUrls = allUrls.filter(url => {
          if (seenBusinessUrls.has(url)) {
            logger.info("DUPLICATE_URL_FILTERED", "Skipping duplicate URL at listing level", {
              url,
              city: cityName,
            });
            return false;
          }
          seenBusinessUrls.add(url);
          return true;
        });

        const toSchedule = Math.min(uniqueUrls.length, remaining);
        const meta = {
          keyword,
          city: cityName,
          state: stateName,
          countryName,
          isExtractEmail,
          isValidate,
          reviewTimeRange,
          extractNegativeReviews,
        };

        logger.info("URL_DEDUPLICATION", "Filtered duplicate URLs at listing level", {
          city: cityName,
          totalUrls: allUrls.length,
          uniqueUrls: uniqueUrls.length,
          duplicatesFiltered: allUrls.length - uniqueUrls.length,
          toSchedule,
        });

        for (let i = 0; i < toSchedule && !shouldStop; i++) {
          scheduleDetail(uniqueUrls[i], meta);
        }
      });
    } catch (error) {
      // Expected errors when stopping early or on session rotation
      const isDetachedFrame =
        error.message && error.message.includes("detached Frame");
      const isTargetClosed =
        error.message &&
        (error.message.includes("Target closed") ||
          error.message.includes("Session closed"));
      const isExecutionContextDestroyed =
        error.message &&
        error.message.includes("Execution context was destroyed");
      const isProtocolError =
        error.message && error.message.includes("Protocol error");

      if (
        isDetachedFrame ||
        isTargetClosed ||
        isExecutionContextDestroyed ||
        isProtocolError
      ) {
        logger.info(
          "CITY_SCRAPE_STOPPED",
          "Zone scrape stopped (expected during shutdown)",
          {
            city: cityName,
            state: stateName,
            zone: zoneLabel || "center",
            reason: isDetachedFrame
              ? "detached_frame"
              : isTargetClosed
              ? "target_closed"
              : isExecutionContextDestroyed
              ? "execution_context_destroyed"
              : "protocol_error",
          }
        );
      } else {
        logger.error("CITY_SCRAPE_ERROR", "Error scraping city", {
          city: cityName,
          state: stateName,
          zone: zoneLabel || "center",
          error: error.message,
        });
      }
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
    // Scenario 3: exact city + state (WITH BATCHED MULTI-ZONE DEEP SCRAPE)
    if (city && stateCode) {
      logger.info(
        "MODE_FULL_LOCATION",
        "Using exact location with batched multi-zone search",
        {
          city,
          state: stateCode,
          country: countryName,
        }
      );
      const state = State.getStateByCodeAndCountry(stateCode, countryCode);
      if (!state)
        throw new Error(
          `Invalid state code: ${stateCode} for country: ${countryCode}`
        );

      // Get zone configuration for batched generation
      const zoneConfig = await createCityZones(
        city,
        stateCode,
        countryCode,
        null, // population (could be fetched if needed)
        true, // Always enable deep scrape for city searches
        ZONE_BATCH_SIZE, // Zones per batch
        MAX_TOTAL_ZONES // Maximum total zones across all batches
      );

      logger.info(
        "CITY_ZONES_READY",
        "Starting batched multi-zone city scrape",
        {
          city,
          totalPossibleZones: zoneConfig.totalPossibleZones,
          batchSize: zoneConfig.batchSize,
          maxTotalZones: zoneConfig.maxTotalZones,
          estimatedBatches: Math.ceil(
            Math.min(zoneConfig.totalPossibleZones, zoneConfig.maxTotalZones) /
              zoneConfig.batchSize
          ),
        }
      );

      // First, scrape city center
      await limitCity(() =>
        scrapeCity({
          cityName: city,
          stateCode,
          stateName: state.name,
          coords: null,
          zoneLabel: "city-center",
        })
      );

      // Calculate total possible batches
      const totalBatches = Math.ceil(
        Math.min(zoneConfig.totalPossibleZones, zoneConfig.maxTotalZones) /
          zoneConfig.batchSize
      );

      // Start from a RANDOM batch for variety (different results each time)
      const randomStartBatch = Math.floor(
        Math.random() * Math.max(1, totalBatches)
      );

      logger.info(
        "ZONE_BATCH_RANDOM_START",
        "Starting from random batch for variety",
        {
          city,
          randomStartBatch,
          totalBatches,
        }
      );

      // Then process zones in batches (with wrap-around)
      let batchNumber = randomStartBatch;
      let batchesProcessed = 0;
      let totalZonesProcessed = 1; // Already processed center
      const processedBatches = new Set(); // Track which batches we've done

      while (
        !shouldStop &&
        results.length < recordLimit &&
        batchesProcessed < totalBatches
      ) {
        // Skip if we've already processed this batch (wrap-around protection)
        if (processedBatches.has(batchNumber)) {
          batchNumber = (batchNumber + 1) % totalBatches;
          continue;
        }

        // Generate next batch of zones
        const batch = generateZoneBatch(zoneConfig, batchNumber);

        if (batch.length === 0) {
          // No more zones in this batch, try next
          batchNumber = (batchNumber + 1) % totalBatches;
          processedBatches.add(batchNumber);
          continue;
        }

        // Shuffle zones within batch for additional randomness
        shuffleArray(batch);

        // Mark this batch as processed
        processedBatches.add(batchNumber);

        logger.info("ZONE_BATCH_PROCESSING", "Processing shuffled zone batch", {
          city,
          batchNumber,
          batchSize: batch.length,
          recordsCollected: results.length,
          recordsNeeded: recordLimit - results.length,
          isShuffled: true,
        });

        // Process all zones in this batch
        const batchPromises = [];
        for (const zone of batch) {
          if (shouldStop || results.length >= recordLimit) break;

          batchPromises.push(
            limitCity(() =>
              scrapeCity({
                cityName: zone.cityName || city,
                stateCode: zone.stateCode || stateCode,
                stateName: state.name,
                coords: zone.coords,
                zoneLabel: zone.label,
              })
            )
          );
        }

        // Wait for this batch to complete
        await Promise.allSettled(batchPromises);

        totalZonesProcessed += batch.length;
        batchesProcessed++;

        // Move to next batch (with wrap-around)
        batchNumber = (batchNumber + 1) % totalBatches;

        // Check if we have enough results
        if (results.length >= recordLimit) {
          logger.info("ZONE_BATCH_TARGET_REACHED", "Target records reached", {
            city,
            batchesProcessed,
            totalZonesProcessed,
            recordsCollected: results.length,
            targetRecords: recordLimit,
            randomStartBatch,
          });
          break;
        }
      }

      logger.info("CITY_SCRAPE_COMPLETE", "City scraping completed", {
        city,
        batchesProcessed,
        totalZonesProcessed,
        recordsCollected: results.length,
        targetRecords: recordLimit,
        randomStartBatch,
        processedBatchNumbers: Array.from(processedBatches).sort(
          (a, b) => a - b
        ),
      });
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
      // If job was stopped due to stuck detection, wait for grace period
      const stuckStatus = progressMonitor.getStatus();
      if (stuckStatus.isStuck) {
        logger.info(
          "STUCK_JOB_GRACE_PERIOD",
          `Job ${job?.data?.jobId} in grace period before termination`,
          {
            reason: stuckStatus.reason,
            gracePeriodMs: STUCK_JOB_GRACE_PERIOD_MS,
            recordsCollected: results.length,
          }
        );
        
        // Wait for grace period to allow current operations to complete
        await new Promise(resolve => setTimeout(resolve, STUCK_JOB_GRACE_PERIOD_MS));
      }
      
      // Prevent unhandled rejections for tasks we won't await
      for (const t of detailTasks) t.catch(() => {});
    }
  } finally {
    // Clear the cancellation check interval
    clearInterval(cancellationCheckInterval);

    // Close browser resources; if shouldStop was requested this will abort in-flight work
    if (refreshingPromise) {
      await refreshingPromise;
    }
    await browserPool.close();

    // Finalize progress after cleanup (only if job wasn't cancelled)
    if (job && !shouldStop) {
      const finalPercentage =
        results.length >= recordLimit
          ? 100
          : calculatePercentage(results.length, recordLimit);

      try {
        await job.progress({
          percentage: finalPercentage,
          status: "completed",
          recordsCollected: results.length,
          maxRecords: recordLimit,
        });
      } catch (progressError) {
        // Job might be cancelled/deleted - silently ignore
        logger.warn("FINAL_PROGRESS_SKIP", "Skipped final progress update", {
          jobId: job.data?.jobId,
          reason: progressError.message,
        });
      }
    } else if (shouldStop) {
      logger.info(
        "JOB_CANCELLED_CLEANUP",
        "Job cancelled - skipping final progress update",
        {
          jobId: job?.data?.jobId,
          recordsCollected: results.length,
        }
      );
    }
  }

  // Force garbage collection to release memory immediately
  const finalResults = results.slice(0, recordLimit);

  // Clear results array to help GC
  results.length = 0;

  // Force GC if available (needs --expose-gc flag)
  if (global.gc) {
    try {
      global.gc();
      logger.info("MEMORY_GC", "Forced garbage collection after job completion");
    } catch (e) {
      // GC not available
    }
  }

  logMemory("JOB_COMPLETE");

  return finalResults;
}
