// scraper5.service.js
import { State, City, Country } from "country-state-city";
import dotenv from "dotenv";
dotenv.config();
import puppeteer from "puppeteer-core";
import puppeteerLocal from "puppeteer";
import logger from "./logger.js";
import autoScroll from "./autoScroll.js";
import { extractFilteredReviews } from "./utils/extractFilteredReviews.js";
import { extractBusinessDetails } from "./businessDetailsExtractor.js";
import { createPopulationResolverAllTheCities } from "./utils/populationResolver.allTheCities.js";

const defaultPopulationResolver = createPopulationResolverAllTheCities();

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
  const timeout = 30000;
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

    // Population / ordering options
    minPopulation = 5000, // floor; set 0 to disable
    populationResolver = defaultPopulationResolver, // ({ iso2, adminCode, city }) => number|null

    // Bucket thresholds (phased buckets)
    bigPopulationThreshold = 1_000_000,
    midPopulationThreshold = 100_000,
  },
  job
) {
  // ---------------- helpers (scoped to this function) ----------------

  const toCandidate = (cityObj, stateIsoCode = null, stateName = null) => ({
    cityName: cityObj.name,
    stateCode: stateIsoCode,
    stateName: stateName,
  });

  // Enumerate cities for (country[, state]) with a robust fallback.
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

    // country has no states -> fallback directly to cities-of-country
    const cities = City.getCitiesOfCountry(iso2) || [];
    return cities.map((c) => {
      // some datasets include stateCode on city, some don't
      const maybeState = c.stateCode
        ? State.getStateByCodeAndCountry(c.stateCode, iso2)
        : null;
      return toCandidate(c, c.stateCode || null, maybeState?.name || null);
    });
  };

  // Build population buckets: Big, Mid, Small, Unknown (null)
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

      // Apply floor (keep unknowns so they can land in "unknown" bucket)
      if (minPopulation > 0 && pop !== null && pop < minPopulation) continue;

      const enriched = { ...cand, __pop: pop };
      if (pop === null) {
        buckets.unknown.push(enriched);
      } else if (pop >= bigPopulationThreshold) {
        buckets.big.push(enriched);
      } else if (pop >= midPopulationThreshold) {
        buckets.mid.push(enriched);
      } else {
        // >= minPopulation (or minPopulation==0)
        buckets.small.push(enriched);
      }
      total++;
    }

    // Shuffle inside each bucket to avoid deterministic ordering
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

  // Process a single bucket in order, stop when recordLimit reached
  const processBucket = async (bucketList, bucketName) => {
    for (const cand of bucketList) {
      if (recordsRemaining <= 0) break;
      try {
        const cityResults = await scrapeCity(
          cand.cityName,
          cand.stateCode,
          cand.stateName
        );
        results.push(...cityResults);
        recordsRemaining = recordLimit - results.length;
      } catch (error) {
        logger.error("CITY_SCRAPE_ERROR", "Error scraping city", {
          city: cand.cityName,
          state: cand.stateName,
          bucket: bucketName,
          error: error.message,
        });
      }
    }
  };

  // -------------------------------------------------------------------

  logger.info("SCRAPER_START", "Starting scraper", {
    keyword,
    countryCode,
    stateCode,
    city,
    maxRecords,
  });

  const results = [];
  const processedLocations = new Set();

  const recordLimit = maxRecords || Infinity;
  let recordsRemaining = recordLimit;

  const country = Country.getCountryByCode(countryCode);
  if (!country) throw new Error(`Invalid country code: ${countryCode}`);
  const countryName = country.name;

  // scrape a single city (dedup + pass-through)
  const scrapeCity = async (cityName, stateIsoCode, stateName) => {
    if (recordsRemaining <= 0) return [];

    const key = locationKey(countryCode, stateIsoCode, cityName);
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
      cumulativeResults: results.length,
      totalMaxRecords: recordLimit,
    });

    return cityResults;
  };

  // ---------------- Scenario 1: city + state + country ----------------
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

  // ---------------- Scenario 2: state + country ----------------
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

    const candidates = listCitiesForScope(countryCode, stateCode);
    const buckets = await bucketizeCandidates(
      candidates,
      `state:${state.name}`
    );

    // Phased processing: Big -> Mid -> Small -> Unknown
    await processBucket(buckets.big, "big");
    if (recordsRemaining > 0) await processBucket(buckets.mid, "mid");
    if (recordsRemaining > 0) await processBucket(buckets.small, "small");
    if (recordsRemaining > 0) await processBucket(buckets.unknown, "unknown");

    return results.slice(0, recordLimit);
  }

  // ---------------- Scenario 3: country only ----------------
  logger.info("MODE_COUNTRY_ONLY", "Scraping entire country", {
    country: countryName,
  });

  const candidates = listCitiesForScope(countryCode /* no state */);
  const buckets = await bucketizeCandidates(
    candidates,
    `country:${countryName}`
  );

  // Phased processing: Big -> Mid -> Small -> Unknown
  await processBucket(buckets.big, "big");
  if (recordsRemaining > 0) await processBucket(buckets.mid, "mid");
  if (recordsRemaining > 0) await processBucket(buckets.small, "small");
  if (recordsRemaining > 0) await processBucket(buckets.unknown, "unknown");

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

  // const browser = await puppeteer.connect({
  //   browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
  // });

  const endpoint =
    process.env.NODE_ENV === "production"
      ? process.env.BROWSER_WS_ENDPOINT_PRIVATE
      : "";

  // const browser = await puppeteer.connect({
  //   browserWSEndpoint: endpoint,
  // });

  const getBrowser = async () => {
    if (endpoint) {
      // Use Browserless for staging and production
      console.log(endpoint);
      return await puppeteer.connect({
        browserWSEndpoint: endpoint,
      });
    } else {
      // return await puppeteerLocal.launch({
      //   headless: true,
      //   // executablePath: executablePath(),
      //   args: [
      //     "--no-sandbox",
      //     "--disable-setuid-sandbox",
      //     "--disable-gpu",
      //     "--disable-dev-shm-usage",
      //     "--single-process",
      //     "--no-zygote",
      //     "--disable-accelerated-2d-canvas",
      //     "--disable-web-security",
      //   ],
      //   protocolTimeout: 120000,
      // });
      return await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
      });
    }
  };

  const browser = await getBrowser();

  // const browser = await puppeteer.launch({
  //   headless: false,
  //   // executablePath: executablePath(),
  //   args: [
  //     "--no-sandbox",
  //     "--disable-setuid-sandbox",
  //     "--disable-gpu",
  //     "--disable-dev-shm-usage",
  //     "--single-process",
  //     "--no-zygote",
  //     "--disable-accelerated-2d-canvas",
  //     "--disable-web-security",
  //   ],
  //   protocolTimeout: 120000,
  // });

  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60000);

    // Navigate to search URL
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 120000 });
    await autoScroll(page);

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
    // await job.progress({
    //   listingsTotal: listingUrls.length,
    //   listingsToProcess,
    //   location: `${city}, ${state}, ${countryName}`,
    // });

    const BATCH_SIZE = 1;
    for (let i = 0; i < listingsToProcess; i += BATCH_SIZE) {
      // Get current batch (usually 1 URL)
      const batch = listingUrls.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (url) => {
          let detailPage;
          try {
            detailPage = await browser.newPage();

            const result = await Promise.race([
              (async () => {
                await detailPage.goto(url, {
                  waitUntil: "domcontentloaded",
                  timeout: 20000,
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
                  null, // Pre-filtered, so no need to filter again
                  null, // Pre-filtered, so no need to filter again
                  isExtractEmail
                );
                // return { url, ...businessData };

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
                    reject(new Error("Listing processing timed out after 60s")),
                  60000
                )
              ),
            ]);

            return result;
          } catch (error) {
            logger.error("LISTING_ERROR", "Error processing listing", {
              url,
              error: error.message,
            });
            return null;
          } finally {
            if (detailPage) {
              try {
                await detailPage.close();
              } catch (closeError) {
                logger.warn("PAGE_CLOSE_ERROR", "Failed to close detail page", {
                  error: closeError.message,
                });
              }
            }
          }
        })
      );

      const successfulExtractions = batchResults.filter(Boolean);
      const newRecords = successfulExtractions.length;
      results.push(...successfulExtractions);

      if (job && newRecords > 0) {
        const cumulativeCount = cumulativeResults + results.length;
        const percentage = calculatePercentage(
          cumulativeCount,
          totalMaxRecords
        );
        await job.progress({
          percentage,
          processedListings: i + 1,
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
      // Early exit if we've reached maxRecords
      if (results.length >= maxRecords) {
        break;
      }
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
    await browser.close();
  }
}
