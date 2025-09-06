import { State, City, Country } from "country-state-city";
import dotenv from "dotenv";
dotenv.config();
import puppeteer from "puppeteer-core";
import puppeteerLocal from "puppeteer";
import logger from "./logger.js";
import autoScroll from "./autoScroll.js";
import { extractFilteredReviews } from "./utils/extractFilteredReviews.js";
import { verifyEmail } from "./utils/emailVerifier.js";
import { extractBusinessDetails } from "./businessDetailsExtractor.js";

// Helper to shuffle array for random selection
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

// Helper function to create location key
const locationKey = (country, state, city) =>
  `${country}-${state || ""}-${city}`.toLowerCase().replace(/\s+/g, "-");

async function safeEvaluate(page, fn, ...args) {
  const timeout = 10000;
  try {
    const result = await Promise.race([
      page.evaluate(fn, ...args),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`evaluate timed out after ${timeout}ms`)),
          timeout
        )
      ),
    ]);
    return result;
  } catch (error) {
    throw error;
  }
}

// Shared browser instance across locations with connection management
let sharedBrowser = null;
const MAX_BROWSER_CONNECTION_ATTEMPTS = 3;
const BROWSER_CONNECTION_RETRY_DELAY = 2000;

async function getSharedBrowserByEndpoint(endpoint) {
  // Check if existing browser is still connected
  if (sharedBrowser) {
    try {
      // Test if browser is still responsive
      await sharedBrowser.version();
      return sharedBrowser;
    } catch (error) {
      logger.warn(
        "BROWSER_CONNECTION_LOST",
        "Existing browser connection lost, creating new one",
        {
          error: error.message,
        }
      );
      sharedBrowser = null;
    }
  }

  // Create new browser connection with retry logic
  for (let attempt = 1; attempt <= MAX_BROWSER_CONNECTION_ATTEMPTS; attempt++) {
    try {
      if (endpoint) {
        logger.info(
          "BROWSER_ENDPOINT",
          "Connecting to remote browser endpoint",
          {
            endpoint: endpoint.replace(/\?.*$/, "?[TOKEN_HIDDEN]"), // Hide token in logs
            attempt,
          }
        );

        sharedBrowser = await puppeteer.connect({
          browserWSEndpoint: endpoint,
          protocolTimeout: 10000, // Reduce timeout for faster failure detection
        });
      } else {
        logger.info("BROWSER_LOCAL", "Launching local browser", { attempt });
        sharedBrowser = await puppeteerLocal.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-zygote",
            "--disable-accelerated-2d-canvas",
            "--disable-web-security",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
          ],
          protocolTimeout: 10000,
        });
      }

      // Test the connection
      await sharedBrowser.version();
      logger.info("BROWSER_CONNECTED", "Successfully connected to browser", {
        attempt,
      });
      return sharedBrowser;
    } catch (error) {
      logger.error(
        "BROWSER_CONNECTION_FAILED",
        `Browser connection attempt ${attempt} failed`,
        {
          error: error.message,
          attempt,
          maxAttempts: MAX_BROWSER_CONNECTION_ATTEMPTS,
        }
      );

      if (sharedBrowser) {
        try {
          await sharedBrowser.close();
        } catch (closeError) {
          // Ignore close errors
        }
        sharedBrowser = null;
      }

      if (attempt < MAX_BROWSER_CONNECTION_ATTEMPTS) {
        logger.info(
          "BROWSER_RETRY",
          `Retrying browser connection in ${BROWSER_CONNECTION_RETRY_DELAY}ms`,
          {
            nextAttempt: attempt + 1,
          }
        );
        await new Promise((resolve) =>
          setTimeout(resolve, BROWSER_CONNECTION_RETRY_DELAY)
        );
      } else {
        throw new Error(
          `Failed to connect to browser after ${MAX_BROWSER_CONNECTION_ATTEMPTS} attempts: ${error.message}`
        );
      }
    }
  }
}

// Cleanup browser connection
async function cleanupBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
      logger.info("BROWSER_CLEANUP", "Browser connection closed successfully");
    } catch (error) {
      logger.warn("BROWSER_CLEANUP_ERROR", "Error closing browser connection", {
        error: error.message,
      });
    } finally {
      sharedBrowser = null;
    }
  }
}

// Create a new page with enhanced retry logic
async function newPageWithRetry(browser, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const page = await Promise.race([
        browser.newPage(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("newPage timeout")), 10000)
        ),
      ]);

      // Set reasonable timeouts for Railway environment
      await page.setDefaultNavigationTimeout(10000);
      await page.setDefaultTimeout(10000);

      // Speed up by blocking non-essential resources
      try {
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const type = req.resourceType();
          if (
            type === "image" ||
            type === "stylesheet" ||
            type === "font" ||
            type === "media"
          ) {
            return req.abort();
          }
          req.continue();
        });
      } catch (_) {
        // Ignore if interception fails (older chromium or remote limitations)
      }

      return page;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");

      logger.warn("NEW_PAGE_RETRY", `Page creation attempt ${i + 1} failed`, {
        error: message,
        attempt: i + 1,
        maxAttempts: attempts,
      });

      // Check if it's a connection issue that requires browser restart
      if (
        message.includes("Protocol error") ||
        message.includes("Connection closed") ||
        message.includes("Session with given id not found") ||
        message.includes("Target closed") ||
        message.includes("newPage timeout")
      ) {
        // Force browser reconnection on next attempt
        if (i < attempts - 1) {
          logger.info(
            "BROWSER_RECONNECT",
            "Forcing browser reconnection due to connection error"
          );
          await cleanupBrowser();
          await new Promise((r) => setTimeout(r, 1000));
        }
        continue;
      }

      if (
        message.includes("Target.createTarget") ||
        message.includes("Session with given id not found")
      ) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      throw error;
    }
  }
  throw lastError || new Error("Failed to open new page after retries");
}

// Process cleanup handlers
process.on("SIGINT", async () => {
  logger.info(
    "PROCESS_CLEANUP",
    "Received SIGINT, cleaning up browser connections"
  );
  await cleanupBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info(
    "PROCESS_CLEANUP",
    "Received SIGTERM, cleaning up browser connections"
  );
  await cleanupBrowser();
  process.exit(0);
});

process.on("uncaughtException", async (error) => {
  logger.error("UNCAUGHT_EXCEPTION", "Uncaught exception, cleaning up", {
    error: error.message,
  });
  await cleanupBrowser();
  process.exit(1);
});

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
  },
  job
) {
  logger.info("SCRAPER_START", "Starting scraper", {
    keyword,
    countryCode,
    stateCode,
    city,
    maxRecords,
  });

  // Initialize results and tracking
  const results = [];
  const processedLocations = new Set();

  // Handle maxRecords default
  const recordLimit = maxRecords || Infinity;
  let recordsRemaining = recordLimit;

  // Get country name
  const country = Country.getCountryByCode(countryCode);
  if (!country) {
    throw new Error(`Invalid country code: ${countryCode}`);
  }
  const countryName = country.name;

  // Helper to scrape a specific city
  const scrapeCity = async (cityName, stateCode, stateName) => {
    if (recordsRemaining <= 0) return [];

    const key = locationKey(countryCode, stateCode, cityName);
    if (processedLocations.has(key)) {
      logger.info("LOCATION_SKIP", "Skipping already processed location", {
        city: cityName,
        state: stateName,
        country: countryName,
      });
      return [];
    }

    processedLocations.add(key);
    logger.info("CITY_SCRAPE_START", "Scraping specific city", {
      city: cityName,
      state: stateName,
      country: countryName,
    });

    const cityResults = await scrapeLocation({
      keyword,
      city: cityName,
      state: stateName,
      countryName,
      job,
      maxRecords: recordsRemaining,
      ratingFilter,
      reviewFilter,
      reviewTimeRange,
      isExtractEmail,
      cumulativeResults: results.length, // Pass cumulative count
      totalMaxRecords: recordLimit, // Pass original limit
    });

    return cityResults;
  };

  // Scenario 1: Full city + state + country provided
  if (city && stateCode) {
    logger.info("MODE_FULL_LOCATION", "Using exact location", {
      city,
      state: stateCode,
      country: countryName,
    });

    const state = State.getStateByCodeAndCountry(stateCode, countryCode);
    if (!state) {
      throw new Error(
        `Invalid state code: ${stateCode} for country: ${countryCode}`
      );
    }

    const cityResults = await scrapeCity(city, stateCode, state.name);
    results.push(...cityResults);
    recordsRemaining = recordLimit - results.length;

    return results.slice(0, recordLimit);
  }

  // Scenario 2: State + country provided
  if (stateCode) {
    logger.info("MODE_STATE_ONLY", "Scraping all cities in state", {
      state: stateCode,
      country: countryName,
    });

    const state = State.getStateByCodeAndCountry(stateCode, countryCode);
    if (!state) {
      throw new Error(
        `Invalid state code: ${stateCode} for country: ${countryCode}`
      );
    }
    const stateName = state.name;

    const cities = City.getCitiesOfState(countryCode, stateCode);
    if (cities.length === 0) {
      return [];
    }

    // Shuffle for random selection
    const shuffledCities = shuffleArray([...cities]);
    const totalCities = shuffledCities.length;

    for (const [index, cityObj] of shuffledCities.entries()) {
      // Stop if we've reached maxRecords
      if (recordsRemaining <= 0) break;

      try {
        const cityResults = await scrapeCity(
          cityObj.name,
          stateCode,
          stateName
        );
        results.push(...cityResults);
        recordsRemaining = recordLimit - results.length;

        // Stop if we've reached maxRecords
        if (recordsRemaining <= 0) break;
      } catch (error) {
        logger.error("CITY_SCRAPE_ERROR", "Error scraping city", {
          city: cityObj.name,
          state: stateName,
          error: error.message,
        });
      }
    }
    return results.slice(0, recordLimit);
  }

  // Scenario 3: Country only provided
  logger.info("MODE_COUNTRY_ONLY", "Scraping entire country", {
    country: countryName,
  });

  const states = State.getStatesOfCountry(countryCode);
  if (states.length === 0) {
    return [];
  }

  // Shuffle states for random selection
  const shuffledStates = shuffleArray([...states]);
  let totalLocations = 0;

  // First pass: Count total locations
  for (const state of shuffledStates) {
    const cities = City.getCitiesOfState(countryCode, state.isoCode);
    totalLocations += cities.length;
  }

  let processedCount = 0;
  // Second pass: Process locations
  for (const state of shuffledStates) {
    // Stop if we've reached maxRecords
    if (recordsRemaining <= 0) break;

    const cities = City.getCitiesOfState(countryCode, state.isoCode);
    if (cities.length === 0) continue;

    const shuffledCities = shuffleArray([...cities]);

    for (const cityObj of shuffledCities) {
      // Stop if we've reached maxRecords
      if (recordsRemaining <= 0) break;

      processedCount++;

      try {
        const cityResults = await scrapeCity(
          cityObj.name,
          state.isoCode,
          state.name
        );
        results.push(...cityResults);
        recordsRemaining = recordLimit - results.length;
      } catch (error) {
        logger.error("CITY_SCRAPE_ERROR", "Error scraping city", {
          city: cityObj.name,
          state: state.name,
          error: error.message,
        });
      }
    }
  }

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

  return results.slice(0, recordLimit);
}

// Core scraping function for a specific location
async function scrapeLocation({
  keyword,
  city,
  state,
  countryName,
  job,
  maxRecords = Infinity,
  ratingFilter = null,
  reviewFilter = null,
  reviewTimeRange,
  isExtractEmail = false,
  cumulativeResults = 0, // Total results so far across all cities
  totalMaxRecords = maxRecords, // Original target limit
}) {
  const results = [];

  // Build the search location string
  const locationParts = [city];
  if (state) locationParts.push(state);
  if (countryName) locationParts.push(countryName);

  // Format for URL
  const formattedLocation = locationParts
    .join(" ")
    .replace(/,/g, "")
    .replace(/\s+/g, "+");

  const searchUrl = `https://www.google.com/maps/search/${keyword}+in+${formattedLocation}`;
  logger.info("SEARCH_URL", "Generated search URL", { url: searchUrl });

  const endpoint =
    process.env.NODE_ENV === "production"
      ? process.env.BROWSER_WS_ENDPOINT_PRIVATE
      : "";

  // Get browser with retry logic
  let browser;
  try {
    browser = await getSharedBrowserByEndpoint(endpoint);
  } catch (error) {
    logger.error(
      "BROWSER_CONNECTION_ERROR",
      "Failed to get browser connection",
      {
        location: `${city}, ${state}, ${countryName}`,
        error: error.message,
      }
    );
    throw error;
  }

  try {
    const page = await newPageWithRetry(browser, 3);

    // Navigate to search URL
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    // Cap autoScroll to avoid long stalls on heavy result lists
    await Promise.race([
      autoScroll(page),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("autoScroll timed out")), 10000)
      ),
    ]);

    // Extract listing URLs with ratings for pre-filtering
    const listingsData = await safeEvaluate(
      page,
      (ratingFilter, reviewFilter) => {
        return Array.from(document.querySelectorAll(".Nv2PK"))
          .map((listing) => {
            const anchor = listing.querySelector("a.hfpxzc");
            const url = anchor ? anchor.href : null;

            if (!url) return null;

            // Extract rating from the listing
            const ratingElement = listing.querySelector('.ZkP5Je[role="img"]');
            const ratingText = ratingElement?.getAttribute("aria-label") || "";
            const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
            const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

            // Extract review count from the listing (using aria-label for consistency)
            const reviewLabelElement = listing.querySelector(
              '[aria-label*="reviews"], [aria-label*="Reviews"]'
            );
            const reviewLabelText =
              reviewLabelElement?.getAttribute("aria-label") || "";
            const reviewMatch = reviewLabelText.match(/(\d+)\s+[Rr]eviews?/);
            const reviewCount = reviewMatch ? parseInt(reviewMatch[1]) : 0;

            // Extract business name for logging
            const nameElement = listing.querySelector(".qBF1Pd");
            const businessName =
              nameElement?.textContent?.trim() || "Unknown Business";

            return {
              url,
              rating,
              reviewCount,
              businessName,
            };
          })
          .filter(Boolean)
          .filter((item) => {
            // Apply rating filter at URL extraction stage
            if (ratingFilter && item.rating) {
              const { operator, value } = ratingFilter;
              let shouldInclude = true;

              switch (operator) {
                case "gt":
                  shouldInclude = item.rating > value;
                  break;
                case "gte":
                  shouldInclude = item.rating >= value;
                  break;
                case "lt":
                  shouldInclude = item.rating < value;
                  break;
                case "lte":
                  shouldInclude = item.rating <= value;
                  break;
              }

              if (!shouldInclude) return false;
            }

            // Apply review count filter at URL extraction stage
            if (reviewFilter && item.reviewCount !== null) {
              const { operator, value } = reviewFilter;
              let shouldInclude = true;

              switch (operator) {
                case "gt":
                  shouldInclude = item.reviewCount > value;
                  break;
                case "gte":
                  shouldInclude = item.reviewCount >= value;
                  break;
                case "lt":
                  shouldInclude = item.reviewCount < value;
                  break;
                case "lte":
                  shouldInclude = item.reviewCount <= value;
                  break;
              }

              if (!shouldInclude) return false;
            }

            return true;
          });
      },
      ratingFilter,
      reviewFilter
    );

    // Log filtering results
    const totalListingsFound = await safeEvaluate(page, () => {
      return document.querySelectorAll(".Nv2PK").length;
    });

    logger.info("FILTER_RESULTS", "Pre-filtering results", {
      location: `${city}, ${state}, ${countryName}`,
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

    if (listingsData.length === 0) {
      logger.info("NO_MATCHES_FOUND", "No businesses match the rating filter", {
        location: `${city}, ${state}, ${countryName}`,
        totalBusinessesFound,
        ratingFilter,
      });
      return [];
    }

    // Extract just the URLs for processing
    const listingUrls = listingsData.map((item) => item.url);

    // Calculate how many listings to process
    const listingsToProcess = Math.min(listingUrls.length, maxRecords);

    // Concurrency: configurable via env, safer defaults in production
    const envConcurrency = Number(process.env.SCRAPER_CONCURRENCY);
    const defaultConcurrency = process.env.NODE_ENV === "production" ? 2 : 5;
    const CONCURRENCY = Math.max(
      1,
      Math.min(
        isNaN(envConcurrency) ? defaultConcurrency : envConcurrency,
        listingsToProcess
      )
    );

    logger.info("CONCURRENCY", "Processing listings with concurrency", {
      concurrency: CONCURRENCY,
      listingsToProcess,
    });

    // Shared progress counters
    let processed = 0;

    // Helper to process a single URL with retries using a persistent page
    const processWithPage = async (detailPage, url) => {
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries) {
        try {
          const result = await Promise.race([
            (async () => {
              await detailPage.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 10000,
              });

              const locationString = [city, state, countryName]
                .filter(Boolean)
                .join(", ");
              // No rating/review filter needed here - already pre-filtered at URL extraction
              const businessData = await extractBusinessDetails(
                detailPage,
                browser,
                keyword,
                locationString,
                null,
                null,
                isExtractEmail
              );

              if (!businessData) {
                return null;
              }

              if (reviewTimeRange) {
                const filteredReviews = await extractFilteredReviews(
                  detailPage,
                  reviewTimeRange
                );
                businessData.filtered_reviews = filteredReviews;
                businessData.filtered_review_count = filteredReviews.length;
              }

              return businessData ? { ...businessData, url } : null;
            })(),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error("Listing processing timed out after 25s")),
                25000
              )
            ),
          ]);

          return result;
        } catch (error) {
          const errorMessage = error?.message || String(error);
          const isConnectionError =
            errorMessage.includes("Protocol error") ||
            errorMessage.includes("Connection closed") ||
            errorMessage.includes("Session with given id not found") ||
            errorMessage.includes("Target closed") ||
            errorMessage.includes("WebSocket connection closed");

          if (isConnectionError && retryCount < maxRetries) {
            retryCount++;
            logger.warn(
              "LISTING_RETRY",
              `Retrying listing due to connection error`,
              {
                url,
                error: errorMessage,
                retry: retryCount,
                maxRetries,
              }
            );

            // Recreate page for next attempt
            try {
              await detailPage.close().catch(() => {});
            } catch (_) {}
            detailPage = await newPageWithRetry(browser, 2);
            await new Promise((r) => setTimeout(r, 500 * retryCount));
            continue;
          } else {
            logger.error("LISTING_ERROR", "Error processing listing", {
              url,
              error: errorMessage,
              finalAttempt: true,
              retryCount,
            });
            return null;
          }
        }
      }

      return null; // All retries exhausted
    };

    // Create a simple worker pool with persistent pages
    let currentIndex = 0;
    const resultsBuffer = [];

    const makeWorker = async () => {
      let pageForWorker;
      try {
        pageForWorker = await newPageWithRetry(browser, 2);
        while (true) {
          const myIndex = currentIndex++;
          if (myIndex >= listingsToProcess) break;
          const url = listingUrls[myIndex];
          const item = await processWithPage(pageForWorker, url);
          if (item) resultsBuffer.push(item);

          processed++;
          // Lightweight, occasional progress update
          if (
            job &&
            processed % Math.max(1, Math.floor(listingsToProcess / 10)) === 0
          ) {
            const cumulativeCount = cumulativeResults + resultsBuffer.length;
            const percentage = calculatePercentage(
              cumulativeCount,
              totalMaxRecords
            );
            await job.progress({
              percentage,
              processedListings: processed,
              totalListings: listingsToProcess,
              recordsCollected: cumulativeCount,
              maxRecords: totalMaxRecords,
              currentLocation: `${city}, ${state}, ${countryName}`,
              preFilterStats: ratingFilter
                ? {
                    totalFound: totalListingsFound,
                    matchingFilter: listingsData.length,
                    preFilterEfficiency: `${(
                      (listingsData.length / Math.max(totalListingsFound, 1)) *
                      100
                    ).toFixed(1)}%`,
                  }
                : undefined,
            });
          }

          // Early exit if we've reached maxRecords
          if (resultsBuffer.length >= maxRecords) break;
        }
      } finally {
        if (pageForWorker) {
          try {
            await pageForWorker.close();
          } catch (closeError) {
            logger.warn("PAGE_CLOSE_ERROR", "Failed to close worker page", {
              error: closeError.message,
            });
          }
        }
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => makeWorker());
    await Promise.all(workers);

    // Flush results from buffer in original array
    const successfulExtractions = resultsBuffer.filter(Boolean);
    const newRecords = successfulExtractions.length;
    results.push(...successfulExtractions);

    if (job && newRecords > 0) {
      const cumulativeCount = cumulativeResults + results.length;
      const percentage = calculatePercentage(cumulativeCount, totalMaxRecords);
      await job.progress({
        percentage,
        processedListings: processed,
        totalListings: listingsToProcess,
        recordsCollected: cumulativeCount, // ✅ Total across all cities
        maxRecords: totalMaxRecords, // ✅ Original target
        currentLocation: `${city}, ${state}, ${countryName}`,
        preFilterStats: ratingFilter
          ? {
              totalFound: totalListingsFound,
              matchingFilter: listingsData.length,
              preFilterEfficiency: `${(
                (listingsData.length / Math.max(totalListingsFound, 1)) *
                100
              ).toFixed(1)}%`,
            }
          : undefined,
      });
    }

    if (job) {
      const cumulativeCount = cumulativeResults + results.length;
      const finalPercentage =
        cumulativeCount >= totalMaxRecords
          ? 100
          : calculatePercentage(cumulativeCount, totalMaxRecords);

      await job.progress({
        percentage: finalPercentage,
        status: "processing",
        recordsCollected: cumulativeCount, // ✅ Total across all cities
        maxRecords: totalMaxRecords, // ✅ Original target
        finalStats:
          ratingFilter || reviewFilter
            ? {
                totalBusinessesFound: totalListingsFound,
                preFilteredToProcess: listingsData.length,
                finalResultsExtracted: results.length,
                preFilterEfficiency: `${(
                  (listingsData.length / Math.max(totalListingsFound, 1)) *
                  100
                ).toFixed(1)}%`,
                extractionEfficiency: `${(
                  (results.length / Math.max(listingsData.length, 1)) *
                  100
                ).toFixed(1)}%`,
                ratingFilter,
                reviewFilter,
              }
            : undefined,
      });
    }

    // Log final statistics for filters
    if (ratingFilter || reviewFilter) {
      logger.info("FILTER_STATISTICS", "Filter results", {
        location: `${city}, ${state}, ${countryName}`,
        ratingFilter,
        reviewFilter,
        totalBusinessesFound: totalListingsFound,
        preFilteredToProcess: listingsData.length,
        finalResultsExtracted: results.length,
        preFilterEfficiency: `${(
          (listingsData.length / Math.max(totalListingsFound, 1)) *
          100
        ).toFixed(1)}%`,
        extractionEfficiency: `${(
          (results.length / Math.max(listingsData.length, 1)) *
          100
        ).toFixed(1)}%`,
      });
    }

    return results.slice(0, maxRecords);
  } finally {
    // Do not close the shared browser here; it will be closed by the caller or process end
  }
}

// async function extractBusinessDetails(
//   page,
//   browser,
//   searchTerm,
//   searchLocation,
//   ratingFilter = null,
//   reviewFilter = null,
//   isExtractEmail = false
// ) {
//   let businessData;
//   try {
//     businessData = await Promise.race([
//       page.evaluate(
//         (searchTerm, searchLocation, ratingFilter, reviewFilter) => {
//           const getText = (selector) =>
//             document.querySelector(selector)?.textContent?.trim() || null;

//           const getHref = (selector) =>
//             document.querySelector(selector)?.href || null;

//           // Extract coordinates from URL parameters
//           const urlParams = new URLSearchParams(window.location.search);
//           const coords = urlParams.get("!3d")?.split("!4d") || [];

//           // Extract categories
//           const categories = Array.from(
//             document.querySelectorAll('[class*="DkEaL"]')
//           )
//             .map((el) => el.textContent.trim())
//             .filter(Boolean);

//           // Extract rating details
//           const ratingElement = document.querySelector('.ceNzKf[role="img"]');
//           const ratingText = ratingElement?.getAttribute("aria-label") || "";

//           // Parse rating value
//           const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
//           const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

//           // Apply rating filter if specified
//           if (ratingFilter && rating) {
//             const { operator, value } = ratingFilter;
//             let shouldSkip = false;

//             switch (operator) {
//               case "gt":
//                 shouldSkip = rating <= value;
//                 break;
//               case "gte":
//                 shouldSkip = rating < value;
//                 break;
//               case "lt":
//                 shouldSkip = rating >= value;
//                 break;
//               case "lte":
//                 shouldSkip = rating > value;
//                 break;
//             }

//             if (shouldSkip) {
//               return null; // Skip this business
//             }
//           }

//           // Extract and apply review count filter if specified
//           const reviewCountText = getText('[aria-label*="reviews"]') || "";
//           const reviewCountMatch = reviewCountText.match(/(\d+)\s+[Rr]eviews?/);
//           const reviewCount = reviewCountMatch
//             ? parseInt(reviewCountMatch[1])
//             : 0;

//           if (reviewFilter && reviewCount !== null) {
//             const { operator, value } = reviewFilter;
//             let shouldSkip = false;

//             switch (operator) {
//               case "gt":
//                 shouldSkip = reviewCount <= value;
//                 break;
//               case "gte":
//                 shouldSkip = reviewCount < value;
//                 break;
//               case "lt":
//                 shouldSkip = reviewCount >= value;
//                 break;
//               case "lte":
//                 shouldSkip = reviewCount > value;
//                 break;
//             }

//             if (shouldSkip) {
//               return null; // Skip this business
//             }
//           }

//           const phoneElement = document.querySelector(
//             'a[aria-label="Call phone number"]'
//           );
//           const phoneNumber = phoneElement
//             ? phoneElement.href.replace("tel:", "")
//             : null;

//           const addressButton = document.querySelector(
//             'button[aria-label^="Address:"]'
//           );
//           const address = addressButton
//             ? addressButton
//                 .getAttribute("aria-label")
//                 .replace("Address: ", "")
//                 .trim()
//             : null;

//           return {
//             name: getText(".DUwDvf.lfPIob"),
//             phone: phoneNumber,
//             website: getHref('[aria-label*="Website"]'),
//             address: address,
//             latitude: coords[0] || null,
//             longitude: coords[1] || null,
//             rating: ratingText.replace(/\D+$/g, "") || null,
//             rating_count:
//               getText('[aria-label*="reviews"]')?.match(/\d+/)?.[0] || "0",
//             category: categories.join(", "),
//             search_term: searchTerm,
//             search_type: "Google Maps",
//             search_location: searchLocation,
//           };
//         },
//         searchTerm,
//         searchLocation,
//         ratingFilter,
//         reviewFilter
//       ),
//       new Promise((_, reject) =>
//         setTimeout(
//           () => reject(new Error("Business data extraction timed out")),
//           15000
//         )
//       ),
//     ]);

//     // Extract email if website exists and email extraction is enabled
//     if (isExtractEmail && businessData.website) {
//       let emailPage;
//       try {
//         emailPage = await newPageWithRetry(browser, 2);

//         const emailResult = await Promise.race([
//           (async () => {
//             // If it's a mailto link, use it directly without loading the site
//             if (businessData.website.startsWith("mailto:")) {
//               return businessData.website.replace("mailto:", "");
//             }

//             await emailPage.goto(businessData.website, {
//               waitUntil: "domcontentloaded",
//               timeout: 7000,
//             });

//             const email = await emailPage.evaluate(() => {
//               const emailRegex =
//                 /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
//               return document.body.textContent.match(emailRegex)?.[0] || null;
//             });

//             return email;
//           })(),
//           new Promise((_, reject) =>
//             setTimeout(
//               () => reject(new Error("Email extraction timed out")),
//               7000
//             )
//           ),
//         ]);

//         // Verify email if one was found
//         if (emailResult) {
//           try {
//             const verificationResult = await verifyEmail(emailResult, {
//               heloHost: process.env.HELO_HOST,
//               mailFrom: process.env.MAIL_FROM,
//               connectionTimeoutMs: 5000,
//               commandTimeoutMs: 5000,
//             });

//             // Only set email if verification result is 'deliverable'
//             businessData.email =
//               verificationResult.result === "deliverable" ? emailResult : null;
//           } catch (verificationError) {
//             // If verification fails, set email to null
//             businessData.email = null;
//             logger.warn(
//               "EMAIL_VERIFICATION_ERROR",
//               "Email verification failed",
//               {
//                 email: emailResult,
//                 error: verificationError.message,
//               }
//             );
//           }
//         } else {
//           businessData.email = null;
//         }
//       } catch (error) {
//         businessData.email = null;
//       } finally {
//         if (emailPage) {
//           try {
//             await emailPage.close();
//           } catch (closeError) {}
//         }
//       }
//     } else {
//       businessData.email = null;
//     }
//   } catch (error) {
//     return null;
//   }

//   return businessData;
// }
