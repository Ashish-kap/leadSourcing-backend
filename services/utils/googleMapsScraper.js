import logger from '../logger.js';
import { Agent } from 'undici';

// Use same env vars as browserlessContentClient.js for consistency
// BROWSERLESS_CONTENT_API_URL should be the base URL (e.g., https://browserless-wmfn-development.up.railway.app)
const BROWSERLESS_API_BASE = process.env.BROWSERLESS_CONTENT_API_URL || '';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_API_TOKEN || '';
const SCRAPE_TIMEOUT = Number(process.env.SCRAPE_API_TIMEOUT || 30000);

// Configure HTTP agent for better connection management
const httpAgent = new Agent({
  connections: 50,
  pipelining: 1,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 120000,
  headersTimeout: 60000,
  bodyTimeout: 60000,
  connect: {
    timeout: 30000
  }
});

// Log configuration on module load
logger.info("GOOGLE_MAPS_SCRAPER_CONFIG", JSON.stringify({
  apiBase: BROWSERLESS_API_BASE,
  hasToken: !!BROWSERLESS_TOKEN,
  timeout: SCRAPE_TIMEOUT
}));

/**
 * Normalize website URL - handles Google redirects
 * @param {string} href - Raw href from element
 * @param {string} baseUrl - Base URL for relative URLs
 * @returns {string|null} - Normalized URL or null
 */
function normalizeWebsiteHref(href, baseUrl = 'https://www.google.com') {
  if (!href) return null;
  try {
    const u = new URL(href, baseUrl);
    // Google redirector used by Maps sometimes
    if (u.hostname.includes("google.") && u.pathname === "/url") {
      const q = u.searchParams.get("q");
      return q || u.href;
    }
    return u.href;
  } catch {
    return href;
  }
}

/**
 * Extract attribute value from Scrape API result
 * @param {object} result - Scrape API result object
 * @param {string} attrName - Attribute name to extract
 * @returns {string|null} - Attribute value or null
 */
function getAttribute(result, attrName) {
  if (!result || !result.attributes) return null;
  const attr = result.attributes.find(a => a.name === attrName);
  return attr ? attr.value : null;
}

/**
 * Extract business data from Scrape API response
 * @param {object} responseData - Scrape API response data
 * @param {string} googleMapsUrl - Original Google Maps URL
 * @returns {object|null} - Parsed business data or null
 */
function parseScrapeResponse(responseData, googleMapsUrl) {
  if (!responseData || !responseData.data || !Array.isArray(responseData.data)) {
    logger.warn("SCRAPE_RESPONSE_INVALID", `Invalid response structure for ${googleMapsUrl}`);
    return null;
  }

  // Create a map of selector -> results for easy lookup
  // Note: Some selectors return multiple results (arrays), others return single result
  const selectorMap = {};
  for (const item of responseData.data) {
    if (item.selector && item.results && Array.isArray(item.results)) {
      // Store all results (array) - some selectors return multiple matches
      selectorMap[item.selector] = item.results;
    }
  }

  // Helper to get first result for a selector (for single-result selectors)
  const getFirstResult = (selector) => {
    const results = selectorMap[selector];
    return (results && Array.isArray(results) && results.length > 0) ? results[0] : null;
  };

  // Helper to get all results for a selector (for multi-result selectors)
  const getAllResults = (selector) => {
    return selectorMap[selector] || [];
  };

  // 1. Name - single result
  const nameResult = getFirstResult("h1.DUwDvf.lfPIob");
  const name = nameResult?.text?.trim() || null;

  if (!name) {
    logger.warn("SCRAPE_MISSING_NAME", `Missing name for ${googleMapsUrl}`);
    return null; // Name is critical
  }

  // 2. Category - single result
  const categoryResult = getFirstResult(".DkEaL");
  const category = categoryResult?.text?.trim() || null;

  // 3. Address, Phone, Website - parse from multiple results
  const contactResults = getAllResults(".Io6YTe.fontBodyMedium.kR99db.fdkmkc");
  let address = null;
  let phone = null;
  let website = null;

  // Skip patterns for non-relevant results
  const skipPatterns = [
    /^Find a table$/i,
    /^Plus code:/i
  ];

  // Plus Code pattern: alphanumeric code with + sign (e.g., "WRHJ+XJ", "8FVC+2X")
  const plusCodePattern = /^[A-Z0-9]{2,}\+[A-Z0-9]{2,}/i;

  for (const result of contactResults) {
    const text = result?.text?.trim();
    if (!text) continue;

    // Skip known non-relevant patterns
    if (skipPatterns.some(pattern => pattern.test(text))) {
      continue;
    }

    // Skip Plus Codes (they often appear after the real address)
    if (plusCodePattern.test(text)) {
      continue;
    }

    // Phone: starts with + or contains country code pattern (e.g., "+91 90046 05665")
    if (/^\+?\d{1,3}[\s\d\-()]{8,}/.test(text)) {
      phone = text;
    }
    // Website: domain pattern (e.g., "delhihighwayrestaurant.com")
    else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) {
      website = text.startsWith('http') ? text : `https://${text}`;
    }
    // Address: long text with commas (likely address)
    // Prioritize longer addresses (more detailed) and only set if not already set or if new one is longer
    else if (text.length > 30 && text.includes(',')) {
      // Use the longest/most detailed address (usually the first one is the full address)
      if (!address || text.length > address.length) {
        address = text;
      }
    }
  }

  // 4. Rating and Review Count - parse from .dmRWX HTML
  const ratingContainerResults = getAllResults(".dmRWX");
  let rating = null;
  let reviewCount = 0;

  if (ratingContainerResults.length > 0) {
    const ratingContainer = ratingContainerResults[0];
    const html = ratingContainer?.html || "";
    const text = ratingContainer?.text || "";

    // Extract rating from aria-label="4.4 stars " in HTML
    const ratingMatch = html.match(/aria-label="([\d.]+)\s*stars?"/i);
    if (ratingMatch) {
      rating = parseFloat(ratingMatch[1]);
    }

    // Extract review count from aria-label="4,079 reviews" in HTML
    const reviewMatch = html.match(/aria-label="([0-9,]+)\s*reviews?"/i);
    if (reviewMatch) {
      const reviewCountText = reviewMatch[1].replace(/,/g, '');
      reviewCount = parseInt(reviewCountText, 10) || 0;
    } else {
      // Fallback: parse from text like "4.4\n(4,079)·₹400–800"
      const textReviewMatch = text.match(/\(([0-9,]+)\)/);
      if (textReviewMatch) {
        const reviewCountText = textReviewMatch[1].replace(/,/g, '');
        reviewCount = parseInt(reviewCountText, 10) || 0;
      }
    }
  }

  return {
    name,
    phone,
    website,
    email: null,
    email_status: null,
    address,
    latitude: null, // Will be set by caller from URL
    longitude: null, // Will be set by caller from URL
    rating: typeof rating === "number" ? rating : null,
    rating_count: String(reviewCount),
    category: category || null,
    search_term: null, // Will be set by caller
    search_type: "Google Maps",
    search_location: null, // Will be set by caller
  };
}

/**
 * Scrape Google Maps business data using Browserless Scrape API
 * @param {string} googleMapsUrl - Google Maps URL to scrape
 * @returns {Promise<object|null>} - Parsed business data or null on failure
 */
export async function scrapeGoogleMapsBusiness(googleMapsUrl) {
  if (!BROWSERLESS_API_BASE || !BROWSERLESS_TOKEN) {
    const errorDetails = {
      url: googleMapsUrl,
      message: 'BROWSERLESS_CONTENT_API_URL and BROWSERLESS_API_TOKEN must be set',
      timestamp: new Date().toISOString()
    };
    logger.error('SCRAPE_API_CONFIG_ERROR', `Configuration error for ${googleMapsUrl}:`, JSON.stringify(errorDetails));
    return null;
  }

  // Build elements array with simplified selectors that work reliably
  const elements = [
    { selector: "h1.DUwDvf.lfPIob" }, // Name
    { selector: ".DkEaL" }, // Category
    { selector: ".Io6YTe.fontBodyMedium.kR99db.fdkmkc" }, // Address, Website, Phone (multiple results)
    { selector: ".dmRWX" } // Rating + Review count (combined HTML)
  ];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT);

    logger.info("SCRAPE_API_REQUEST", `Scraping Google Maps: ${googleMapsUrl}`);

    // Construct URL same way as browserlessContentClient.js: base + /scrape + token
    const scrapeUrl = `${BROWSERLESS_API_BASE}/scrape?token=${BROWSERLESS_TOKEN}`;
    
    const response = await fetch(
      scrapeUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: googleMapsUrl,
          elements: elements,
          gotoOptions: {
            waitUntil: "networkidle2",
            timeout: 30000
          },
          waitForSelector: {
            selector: "h1.DUwDvf.lfPIob",
            timeout: 10000
          }
        }),
        signal: controller.signal,
        dispatcher: httpAgent
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      let responseBody = null;
      try {
        const contentType = response.headers.get('content-type') || '';
        let bodyText = await response.text();
        
        if (contentType.includes('application/json') || (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('['))) {
          try {
            const parsed = JSON.parse(bodyText);
            bodyText = typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
          } catch {
            // Not valid JSON, use as-is
          }
        }
        
        responseBody = typeof bodyText === 'string' 
          ? (bodyText.length > 500 ? bodyText.substring(0, 500) + '...' : bodyText)
          : String(bodyText);
      } catch (e) {
        // Ignore if we can't read response body
      }

      const errorDetails = {
        url: googleMapsUrl,
        message: `Browserless Scrape API error: ${response.status} ${response.statusText}`,
        statusCode: response.status,
        statusText: response.statusText,
        responseBody,
        requestTimeout: SCRAPE_TIMEOUT,
        timestamp: new Date().toISOString()
      };

      logger.error("SCRAPE_API_ERROR", `Failed to scrape ${googleMapsUrl}:`, JSON.stringify(errorDetails));
      return null;
    }

    const responseData = await response.json();
    
    logger.info("SCRAPE_API_SUCCESS", `Successfully scraped ${googleMapsUrl}`);

    // Parse the response
    const businessData = parseScrapeResponse(responseData, googleMapsUrl);
    
    if (!businessData) {
      logger.warn("SCRAPE_PARSE_FAILED", `Failed to parse business data from ${googleMapsUrl}`);
      return null;
    }

    logger.info("SCRAPE_EXTRACTION_SUCCESS", `Extracted business data for ${businessData.name || 'unknown'}`);
    
    return businessData;
  } catch (error) {
    if (error.name === 'AbortError') {
      const errorDetails = {
        url: googleMapsUrl,
        message: `Request timeout after ${SCRAPE_TIMEOUT}ms`,
        statusCode: null,
        statusText: 'Timeout',
        requestTimeout: SCRAPE_TIMEOUT,
        timestamp: new Date().toISOString()
      };
      logger.error('SCRAPE_API_TIMEOUT', `Timeout scraping ${googleMapsUrl} after ${SCRAPE_TIMEOUT}ms:`, JSON.stringify(errorDetails));
      return null;
    }
    
    const errorDetails = {
      url: googleMapsUrl,
      message: error.message,
      statusCode: null,
      statusText: 'Network Error',
      requestTimeout: SCRAPE_TIMEOUT,
      timestamp: new Date().toISOString()
    };
    logger.error('SCRAPE_API_ERROR', `Failed to scrape ${googleMapsUrl}:`, JSON.stringify(errorDetails));
    return null;
  }
}
