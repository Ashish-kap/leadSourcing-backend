import dotenv from "dotenv";
dotenv.config();
import { verifyEmail } from "./utils/emailVerifier.js";
import { fetchMultiplePages, fetchPageContentWithRetry } from "./utils/browserlessContentClient.js";
import { extractEmailsFromHtml, findContactUrls } from "./utils/emailExtractorFromHtml.js";
import { scrapeGoogleMapsBusiness } from "./utils/googleMapsScraper.js";
import logger from "./logger.js";

// Email extraction concurrency limiter for Browserless Content API
const EMAIL_API_CONCURRENCY = Number(process.env.EMAIL_API_CONCURRENCY || 5);
function createEmailLimiter(concurrency) {
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
// Use EMAIL_API_CONCURRENCY to control how many email extractions run concurrently
const limitEmail = createEmailLimiter(EMAIL_API_CONCURRENCY);

function getCoordsFromUrl(u) {
  // matches ...!3d24.379259!4d91.4136279...
  const m = u.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  return m
    ? { latitude: parseFloat(m[1]), longitude: parseFloat(m[3]) }
    : { latitude: null, longitude: null };
}

export async function extractBusinessDetails(
  googleMapsUrl,
  searchTerm,
  searchLocation,
  ratingFilter = null,
  reviewFilter = null,
  isExtractEmail = false,
  isValidate = false,
  onlyWithoutWebsite = false,
  preScrapedRating = null,
  preScrapedReviewCount = null
) {

  // --- Parse coords from URL (reliable) ---
  const { latitude, longitude } = getCoordsFromUrl(googleMapsUrl);

  // --- Extract business data using Browserless Scrape API ---
  let businessData;
  try {
    businessData = await scrapeGoogleMapsBusiness(googleMapsUrl);
    
    if (!businessData) {
      logger.warn("BUSINESS_DATA_EXTRACTION_FAILED", `Failed to extract business data from ${googleMapsUrl}`);
      return null;
    }

    // Use pre-scraped rating/review count if available (more reliable from listings page)
    if (preScrapedRating !== null && preScrapedRating !== undefined) {
      businessData.rating = preScrapedRating;
    }
    if (preScrapedReviewCount !== null && preScrapedReviewCount !== undefined) {
      businessData.rating_count = String(preScrapedReviewCount);
    }

    logger.info("PRESCRAPED_VALUES_RECEIVED", "Using pre-scraped rating/review count", {
      googleMapsUrl,
      businessName: businessData.name,
      preScrapedRating,
      preScrapedReviewCount,
      hasRating: preScrapedRating !== null && preScrapedRating !== undefined,
      hasReviewCount: preScrapedReviewCount !== null && preScrapedReviewCount !== undefined,
      finalRating: businessData.rating,
      finalRatingCount: businessData.rating_count
    });

    // Set search term and location (not available in scraper response)
    businessData.search_term = searchTerm;
    businessData.search_location = searchLocation;

    // Apply rating filter if provided
    if (ratingFilter && typeof businessData.rating === "number") {
      const { operator, value } = ratingFilter;
      const bad =
        (operator === "gt" && !(businessData.rating > value)) ||
        (operator === "gte" && !(businessData.rating >= value)) ||
        (operator === "lt" && !(businessData.rating < value)) ||
        (operator === "lte" && !(businessData.rating <= value));
      if (bad) {
        logger.info("BUSINESS_FILTERED_BY_RATING", `Business ${businessData.name} filtered out by rating filter`);
        return null;
      }
    }

    // Apply review count filter if provided
    if (reviewFilter) {
      const reviewCount = parseInt(businessData.rating_count || "0", 10);
      const { operator, value } = reviewFilter;
      const bad =
        (operator === "gt" && !(reviewCount > value)) ||
        (operator === "gte" && !(reviewCount >= value)) ||
        (operator === "lt" && !(reviewCount < value)) ||
        (operator === "lte" && !(reviewCount <= value));
      if (bad) {
        logger.info("BUSINESS_FILTERED_BY_REVIEWS", `Business ${businessData.name} filtered out by review filter`);
        return null;
      }
    }
  } catch (error) {
    logger.error("BUSINESS_DATA_EXTRACTION_ERROR", `Error extracting business data from ${googleMapsUrl}: ${error.message}`);
    return null;
  }

  if (!businessData) return null;

    // inject reliable coords parsed from the URL
    businessData.latitude = latitude;
    businessData.longitude = longitude;

    // Filter: Skip businesses with websites if onlyWithoutWebsite is true
    if (onlyWithoutWebsite && businessData.website) {
      return null; // Skip businesses with websites
    }

    // Filter: Skip businesses without website if email extraction is required
    if (isExtractEmail && !businessData.website) {
      return null; // Skip businesses without websites when email extraction is required
    }

    /**
     * Extract emails using Browserless Content API with Smart Prioritization
     * Fetches homepage + priority pages (contact, about, team) concurrently
     * This avoids creating new Puppeteer pages, eliminating frame detachment issues
     */
    async function extractEmailsViaBrowserlessAPI(websiteUrl) {
      try {
        const allEmails = [];
        const visitedPages = [];
        
        // Step 1: Fetch homepage first to find priority pages
        logger.info("EMAIL_API_START", `Fetching homepage for ${websiteUrl}`);
        
        // Wrap in try-catch, use retry for homepage (critical page)
        let homepage = { html: null, error: null };
        try {
          homepage = await fetchPageContentWithRetry(websiteUrl, 2); // Retry 2 times
          if (homepage.error) {
            logger.warn("HOMEPAGE_FETCH_FAILED", `Homepage failed for ${websiteUrl}: ${homepage.error}`);
          }
        } catch (error) {
          logger.error("HOMEPAGE_FETCH_ERROR", `Critical error fetching homepage ${websiteUrl}: ${error.message}`);
        }
        
        // Continue even if homepage fails
        if (homepage.html) {
          const homepageEmails = extractEmailsFromHtml(homepage.html, websiteUrl);
          allEmails.push(...homepageEmails);
          visitedPages.push(websiteUrl);
          logger.info("EMAIL_API_HOMEPAGE", `Homepage: found ${homepageEmails.length} emails for ${websiteUrl}`);
        } else {
          visitedPages.push(websiteUrl); // Still track as visited
          logger.warn("HOMEPAGE_NO_HTML", `Skipping homepage email extraction for ${websiteUrl}`);
        }
        
        // Step 2: Find priority pages (contact, about, team) from homepage
        // Only if homepage HTML is available AND no emails found on homepage
        const shouldFetchPriorityPages = homepage.html && allEmails.length === 0;
        
        if (shouldFetchPriorityPages) {
          const priorityUrls = findContactUrls(homepage.html, websiteUrl);
          
          // Step 3: Fetch priority pages concurrently
          if (priorityUrls.length > 0) {
            logger.info("EMAIL_API_PRIORITY_PAGES", `No emails on homepage, fetching ${priorityUrls.length} priority pages for ${websiteUrl}`);
            
            // Fetch up to 5 priority pages concurrently
            const maxPriorityPages = 5;
            const pagesToFetch = priorityUrls.slice(0, maxPriorityPages);
            const priorityConcurrency = Math.min(3, maxPriorityPages); // Max 3 concurrent priority pages
            
            const priorityPages = await fetchMultiplePages(pagesToFetch, priorityConcurrency);
            
            // Extract emails from each priority page
            // Track ALL pages, not just successful ones
            for (const page of priorityPages) {
              visitedPages.push(page.url); // Move OUTSIDE the if block
              
              if (page.html && !page.error) {
                const pageEmails = extractEmailsFromHtml(page.html, websiteUrl);
                if (pageEmails.length > 0) {
                  logger.info("EMAIL_API_PAGE_SUCCESS", `Found ${pageEmails.length} emails on ${page.url}`);
                  allEmails.push(...pageEmails);
                }
              } else if (page.error) {
                logger.warn("EMAIL_API_PAGE_ERROR", `Failed to fetch ${page.url}: ${page.error}`);
              }
            }
          } else {
            logger.info("EMAIL_API_NO_PRIORITY_URLS", `No priority URLs found for ${websiteUrl}`);
          }
        } else if (homepage.html && allEmails.length > 0) {
          logger.info("EMAIL_API_SKIP_PRIORITY", `Found ${allEmails.length} emails on homepage for ${websiteUrl}, skipping priority pages`);
        }
        
        // Step 4: Dedupe and sort emails (prefer domain emails first)
        const uniqueEmails = [...new Set(allEmails)];
        
        // Sort: prefer emails from the website's domain
        const siteDomain = (() => {
          try {
            return new URL(websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
          } catch {
            return null;
          }
        })();
        
        if (siteDomain) {
          uniqueEmails.sort((a, b) => {
            const aDomain = a.split('@')[1]?.toLowerCase() || '';
            const bDomain = b.split('@')[1]?.toLowerCase() || '';
            const aMatch = aDomain.includes(siteDomain) ? 1 : 0;
            const bMatch = bDomain.includes(siteDomain) ? 1 : 0;
            return bMatch - aMatch;
          });
        }
        
        logger.info("EMAIL_API_COMPLETE", `Extracted ${uniqueEmails.length} unique emails from ${visitedPages.length} pages for ${websiteUrl}`);
        
        return {
          emails: uniqueEmails,
          pagesVisited: visitedPages.length,
          visited: visitedPages,
          errors: []
        };
      } catch (error) {
        logger.error("BROWSERLESS_API_EMAIL_ERROR", `Error extracting emails via API for ${websiteUrl}: ${error.message}`);
        return { 
          emails: [], 
          pagesVisited: 0,
          visited: [],
          errors: [{ type: "api_error", message: error.message }] 
        };
      }
    }

    // Skip email extraction when onlyWithoutWebsite is true
    // (businesses without websites won't have emails to scrape anyway)
    if (onlyWithoutWebsite) {
      businessData.email = [];
      businessData.email_status = [];
    } else if (
      isExtractEmail &&
      businessData.website &&
      !businessData.website.startsWith("javascript:")
    ) {
      try {
        // const T_SCRAPE_START = performance.now();
        const emailTimeout = Number(process.env.EMAIL_TIMEOUT_MS || 65000); // 65s to accommodate 60s budget + buffer

        // Use Browserless Content API - eliminates frame detachment issues
        const emailPromise = limitEmail(async () => {
          return await extractEmailsViaBrowserlessAPI(businessData.website);
        });

        let emailResult = await Promise.race([
          emailPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Email scraping timeout")),
              emailTimeout
            )
          ),
        ]).catch(async (err) => {
          // Log timeout/error
          if (process.env.LOG_EMAIL_FAILURES === "true") {
            logger.warn("EMAIL_API_ERROR", `Timeout/error for ${businessData.website}: ${err.message}`);
          }
          
          // Return empty on error
          return { emails: [], errors: [{ type: 'timeout', message: err.message }] };
        });

        let { emails: rawEmails = [], errors: scrapingErrors = [] } = emailResult;
        // businessData.timings.scrape_ms = Math.round(
        //   performance.now() - T_SCRAPE_START
        // );

        // Normalize + dedupe (case-insensitive)
        const seen = new Set();
        const uniqueEmails = [];
        for (const e of rawEmails) {
          const k = String(e || "")
            .trim()
            .toLowerCase();
          if (k && !seen.has(k)) {
            seen.add(k);
            uniqueEmails.push(k);
          }
        }

        // Prefer site-domain emails first (improves yield & speed)
        const siteHost = (() => {
          try {
            return new URL(businessData.website).hostname
              .replace(/^www\./, "")
              .toLowerCase();
          } catch {
            return null;
          }
        })();
        if (siteHost) {
          uniqueEmails.sort((a, b) => {
            const da = a.split("@")[1]?.toLowerCase() || "";
            const db = b.split("@")[1]?.toLowerCase() || "";
            return (
              (db.endsWith(siteHost) ? 1 : 0) - (da.endsWith(siteHost) ? 1 : 0)
            );
          });
        }

        // Verify emails only if isValidate is true
        if (isValidate) {
          const verifyOpts = {
            heloHost: process.env.HELO_HOST,
            mailFrom: process.env.MAIL_FROM,
            connectionTimeoutMs: Number(
              process.env.SMTP_CONNECT_TIMEOUT_MS || 10000
            ),
            commandTimeoutMs: Number(
              process.env.SMTP_COMMAND_TIMEOUT_MS || 15000
            ),
          };

          const concurrency = 3;
          const q = [...uniqueEmails];
          const results = [];

          // const T_VERIFY_WALL_START = performance.now();
          async function worker() {
            while (q.length) {
              const email = q.shift();
              // const t0 = performance.now();
              try {
                const res = await verifyEmail(email, verifyOpts);
                // const ms = Math.round(performance.now() - t0);
                results.push({
                  email,
                  result: res?.result || "unknown",
                  reason: res?.reason || "no reason provided",
                  code: res?.smtp?.[0]?.code || null,
                  // ms,
                });
              } catch (err) {
                // const ms = Math.round(performance.now() - t0);
                results.push({
                  email,
                  result: "error",
                  reason: err?.message || "verification error",
                  code: null,
                  // ms,
                });
              }
            }
          }

          await Promise.all(
            Array.from({ length: Math.min(concurrency, q.length) }, worker)
          );

          // const verifyWallMs = Math.round(
          //   performance.now() - T_VERIFY_WALL_START
          // );
          // const verifySumMs = results.reduce((acc, r) => acc + (r.ms || 0), 0);

          // Check if SMTP is likely blocked for fallback logic
          const FALLBACK_ON_SMTP_FAILURE =
            String(
              process.env.EMAIL_FALLBACK_ON_SMTP_FAILURE || "false"
            ).toLowerCase() === "true";

          const smtpLikelyBlocked =
            uniqueEmails.length > 0 &&
            results.length === uniqueEmails.length &&
            results.every(
              (r) =>
                r.result === "error" ||
                (r.result !== "deliverable" &&
                  /timeout|connect|refused|unreachable|temporary-failure/i.test(
                    r.reason || ""
                  ))
            );

          if (smtpLikelyBlocked && FALLBACK_ON_SMTP_FAILURE) {
            // SMTP blocked - return empty arrays
            businessData.email = [];
            businessData.email_status = [];
            businessData.email_verification = {
              mode: "fallback",
              details: results,
            };
          } else {
            // Store all emails and their statuses
            businessData.email = uniqueEmails;
            // Create status array that corresponds to email array by index
            businessData.email_status = uniqueEmails.map((email) => {
              const result = results.find((r) => r.email === email);
              return result ? result.result : "unknown";
            });
            businessData.email_verification = {
              mode: "verified",
              details: results,
            };
          }
        } else {
          // Email extraction but no validation - return all unique emails as unverified
          businessData.email = uniqueEmails;
          businessData.email_status = uniqueEmails.map(() => "unverified");
          businessData.email_verification = {
            mode: "unverified",
            details: [],
          };
        }

        // attach verification timing summary
        // businessData.timings.verify = {
        //   wall_ms: verifyWallMs,
        //   sum_email_ms: verifySumMs,
        //   per_email: results.map(({ email, ms, result, reason, code }) => ({
        //     email,
        //     ms,
        //     result,
        //     reason,
        //     code,
        //   })),
        // };
      } catch (err) {
        logger.warn(
          "EMAIL_EXTRACTION_FAILED",
          `Email extraction/verification failed: ${err?.message || err}`
        );
        businessData.email = [];
        businessData.email_status = [];
      }
    } else {
      businessData.email = [];
      businessData.email_status = [];
    }

    // Note: We no longer filter out businesses with no emails found
    // This allows businesses to be included even if email scraping fails due to technical errors
    // The "no website" filter (line 261-264) still applies when isExtractEmail is true

  return businessData;
}
