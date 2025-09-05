import { State, City, Country } from "country-state-city";
import dotenv from "dotenv";
dotenv.config();
import puppeteer from "puppeteer-core";
import puppeteerLocal from "puppeteer";
import logger from "./logger.js";
import autoScroll from "./autoScroll.js";
import { extractFilteredReviews } from "./utils/extractFilteredReviews.js";
import { verifyEmail } from "./utils/emailVerifier.js";

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

// Shared browser instance across locations
let sharedBrowser = null;
async function getSharedBrowserByEndpoint(endpoint) {
  if (sharedBrowser) {
    return sharedBrowser;
  }
  if (endpoint) {
    console.log(endpoint);
    sharedBrowser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  } else {
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
      ],
      protocolTimeout: 120000,
    });
  }
  return sharedBrowser;
}


// Create a new page with minimal retry to avoid Target.createTarget stalls
async function newPageWithRetry(browser, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const page = await browser.newPage();
      return page;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      if (
        message.includes("Target.createTarget") ||
        message.includes("Session with given id not found")
      ) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("Failed to open new page");
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

  // Reuse one browser across all locations
  const browser = await getSharedBrowserByEndpoint(endpoint);

  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(10000);

    // Navigate to search URL
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
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
    // await job.progress({
    //   listingsTotal: listingUrls.length,
    //   listingsToProcess,
    //   location: `${city}, ${state}, ${countryName}`,
    // });

    const BATCH_SIZE = 2;
    for (let i = 0; i < listingsToProcess; i += BATCH_SIZE) {
      // Get current batch (usually 1 URL)
      const batch = listingUrls.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (url) => {
          let detailPage;
          try {
            detailPage = await newPageWithRetry(browser, 2);

            const result = await Promise.race([
              (async () => {
                await detailPage.goto(url, {
                  waitUntil: "domcontentloaded",
                  timeout: 15000,
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
                    reject(new Error("Listing processing timed out after 30s")),
                  30000
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
    // Do not close the shared browser here; it will be closed by the caller or process end
  }
}

async function extractBusinessDetails(
  page,
  browser,
  searchTerm,
  searchLocation,
  ratingFilter = null,
  reviewFilter = null,
  isExtractEmail = false
) {
  let businessData;
  try {
    businessData = await Promise.race([
      page.evaluate(
        (searchTerm, searchLocation, ratingFilter, reviewFilter) => {
          const getText = (selector) =>
            document.querySelector(selector)?.textContent?.trim() || null;

          const getHref = (selector) =>
            document.querySelector(selector)?.href || null;

          // Extract coordinates from URL parameters
          const urlParams = new URLSearchParams(window.location.search);
          const coords = urlParams.get("!3d")?.split("!4d") || [];

          // Extract categories
          const categories = Array.from(
            document.querySelectorAll('[class*="DkEaL"]')
          )
            .map((el) => el.textContent.trim())
            .filter(Boolean);

          // Extract rating details
          const ratingElement = document.querySelector('.ceNzKf[role="img"]');
          const ratingText = ratingElement?.getAttribute("aria-label") || "";

          // Parse rating value
          const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          // Apply rating filter if specified
          if (ratingFilter && rating) {
            const { operator, value } = ratingFilter;
            let shouldSkip = false;

            switch (operator) {
              case "gt":
                shouldSkip = rating <= value;
                break;
              case "gte":
                shouldSkip = rating < value;
                break;
              case "lt":
                shouldSkip = rating >= value;
                break;
              case "lte":
                shouldSkip = rating > value;
                break;
            }

            if (shouldSkip) {
              return null; // Skip this business
            }
          }

          // Extract and apply review count filter if specified
          const reviewCountText = getText('[aria-label*="reviews"]') || "";
          const reviewCountMatch = reviewCountText.match(/(\d+)\s+[Rr]eviews?/);
          const reviewCount = reviewCountMatch
            ? parseInt(reviewCountMatch[1])
            : 0;

          if (reviewFilter && reviewCount !== null) {
            const { operator, value } = reviewFilter;
            let shouldSkip = false;

            switch (operator) {
              case "gt":
                shouldSkip = reviewCount <= value;
                break;
              case "gte":
                shouldSkip = reviewCount < value;
                break;
              case "lt":
                shouldSkip = reviewCount >= value;
                break;
              case "lte":
                shouldSkip = reviewCount > value;
                break;
            }

            if (shouldSkip) {
              return null; // Skip this business
            }
          }

          const phoneElement = document.querySelector(
            'a[aria-label="Call phone number"]'
          );
          const phoneNumber = phoneElement
            ? phoneElement.href.replace("tel:", "")
            : null;

          const addressButton = document.querySelector(
            'button[aria-label^="Address:"]'
          );
          const address = addressButton
            ? addressButton
                .getAttribute("aria-label")
                .replace("Address: ", "")
                .trim()
            : null;

          return {
            name: getText(".DUwDvf.lfPIob"),
            phone: phoneNumber,
            website: getHref('[aria-label*="Website"]'),
            address: address,
            latitude: coords[0] || null,
            longitude: coords[1] || null,
            rating: ratingText.replace(/\D+$/g, "") || null,
            rating_count:
              getText('[aria-label*="reviews"]')?.match(/\d+/)?.[0] || "0",
            category: categories.join(", "),
            search_term: searchTerm,
            search_type: "Google Maps",
            search_location: searchLocation,
          };
        },
        searchTerm,
        searchLocation,
        ratingFilter,
        reviewFilter
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Business data extraction timed out")),
          15000
        )
      ),
    ]);

    // Extract email if website exists and email extraction is enabled
    if (isExtractEmail && businessData.website) {
      let emailPage;
      try {
        emailPage = await newPageWithRetry(browser, 2);
        await emailPage.setDefaultNavigationTimeout(7000);

        const emailResult = await Promise.race([
          (async () => {
            // If it's a mailto link, use it directly without loading the site
            if (businessData.website.startsWith("mailto:")) {
              return businessData.website.replace("mailto:", "");
            }

            await emailPage.goto(businessData.website, {
              waitUntil: "domcontentloaded",
              timeout: 7000,
            });

            const email = await emailPage.evaluate(() => {
              const emailRegex =
                /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
              return document.body.textContent.match(emailRegex)?.[0] || null;
            });

            return email;
          })(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Email extraction timed out")),
              7000
            )
          ),
        ]);

        // Verify email if one was found
        if (emailResult) {
          try {
            const verificationResult = await verifyEmail(emailResult, {
              heloHost: process.env.HELO_HOST,
              mailFrom: process.env.MAIL_FROM,
              connectionTimeoutMs: 5000,
              commandTimeoutMs: 5000,
            });

            // Only set email if verification result is 'deliverable'
            businessData.email =
              verificationResult.result === "deliverable" ? emailResult : null;
          } catch (verificationError) {
            // If verification fails, set email to null
            businessData.email = null;
            logger.warn(
              "EMAIL_VERIFICATION_ERROR",
              "Email verification failed",
              {
                email: emailResult,
                error: verificationError.message,
              }
            );
          }
        } else {
          businessData.email = null;
        }
      } catch (error) {
        businessData.email = null;
      } finally {
        if (emailPage) {
          try {
            await emailPage.close();
          } catch (closeError) {}
        }
      }
    } else {
      businessData.email = null;
    }
  } catch (error) {
    return null;
  }

  return businessData;
}
