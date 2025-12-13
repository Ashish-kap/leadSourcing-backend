import dotenv from "dotenv";
dotenv.config();
import Redis from "ioredis";
import logger from "./logger.js";

let redisClient = null;

// Get Redis configuration (same as queue.js)
function getRedisConfig() {
  let redisObj;

  if (process.env.REDIS_HOST) {
    try {
      const redisUrl = new URL(process.env.REDIS_HOST);
      redisObj = {
        host: redisUrl.hostname,
        port: parseInt(redisUrl.port, 10) || 6379,
        password: redisUrl.password
          ? redisUrl.password.replace(/^default:/, "")
          : undefined,
      };
    } catch (e) {
      redisObj = {
        host: process.env.REDIS_HOST,
        port: 6379,
      };
    }
  } else {
    redisObj = {
      host: "localhost",
      port: 6379,
    };
  }

  return redisObj;
}

// Get or create Redis client
function getRedisClient() {
  if (redisClient && redisClient.status === "ready") {
    return redisClient;
  }

  const config = getRedisConfig();
  redisClient = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  redisClient.on("error", (err) => {
    logger.warn("REDIS_URL_TRACKER_ERROR", "Redis connection error in URL tracker", {
      error: err.message,
    });
  });

  redisClient.on("connect", () => {
    logger.info("REDIS_URL_TRACKER_CONNECTED", "Redis URL tracker connected");
  });

  return redisClient;
}

// Get Redis key for user's scraped URLs
function getUserKey(userId) {
  return `user:${userId}:scraped_urls`;
}

// Normalize URL to ensure consistent storage and lookup
// Removes query parameters that don't affect the business listing
function normalizeUrl(url) {
  if (!url) return url;
  
  try {
    const urlObj = new URL(url);
    
    // For Google Maps place URLs, the data= parameter contains the place ID which is what matters
    // Extract the place ID from the data parameter if it exists
    if (urlObj.searchParams.has('data')) {
      const dataParam = urlObj.searchParams.get('data');
      // The data parameter format is: !4m7!3m6!1s<PLACE_ID>!8m2!3d<lat>!4d<lng>...
      // Extract the place ID (the part after 1s and before !8m2 or !16s or !19s)
      // Place ID can be: 0x3be053428fa108e3:0x8d2b7660c3245be5 (hex format)
      const placeIdMatch = dataParam.match(/1s([^!]+)/);
      if (placeIdMatch && placeIdMatch[1]) {
        // Use just the pathname + place ID for normalization
        // This ensures same business = same normalized URL regardless of query params
        const placeId = placeIdMatch[1];
        const normalized = `${urlObj.origin}${urlObj.pathname}?data=!4m7!3m6!1s${placeId}`;
        logger.debug("URL_NORMALIZED_PLACE_ID", "Normalized URL using place ID", {
          original: url,
          normalized,
          placeId,
        });
        return normalized;
      }
    }
    
    // Fallback: If no data param or can't extract place ID, keep only essential params
    // Remove all query params except 'data'
    const essentialParams = ['data'];
    const newSearchParams = new URLSearchParams();
    
    for (const param of essentialParams) {
      if (urlObj.searchParams.has(param)) {
        newSearchParams.set(param, urlObj.searchParams.get(param));
      }
    }
    
    // Reconstruct URL with only essential params
    urlObj.search = newSearchParams.toString();
    const fallbackNormalized = urlObj.toString();
    logger.debug("URL_NORMALIZED_FALLBACK", "Normalized URL using fallback (full data param)", {
      original: url,
      normalized: fallbackNormalized,
    });
    return fallbackNormalized;
  } catch (error) {
    // If URL parsing fails, return as-is
    logger.warn("URL_NORMALIZATION_ERROR", "Failed to normalize URL", {
      url,
      error: error.message,
    });
    return url;
  }
}

// Get TTL in seconds (default: 1 year = 365 days)
function getTTL() {
  const ttlDays = parseInt(process.env.REDIS_URL_TTL_DAYS || "365", 10);
  return ttlDays * 24 * 60 * 60; // Convert days to seconds
}

/**
 * Batch check if URLs exist in Redis for a user
 * @param {string} userId - User ID
 * @param {string[]} urls - Array of URLs to check
 * @returns {Promise<boolean[]>} - Array of booleans indicating if each URL exists (true = exists, false = new)
 */
export async function batchCheckUrls(userId, urls) {
  if (!userId || !urls || urls.length === 0) {
    return urls.map(() => false);
  }

  try {
    const client = getRedisClient();
    await client.connect().catch(() => {
      // Already connected or connection in progress
    });

    const key = getUserKey(userId);
    
    // Normalize URLs before checking
    const normalizedUrls = urls.map(url => normalizeUrl(url));
    
    logger.info("REDIS_BATCH_CHECK", "Checking URLs in Redis", {
      userId,
      urlCount: urls.length,
      key,
      sampleUrl: urls[0],
      sampleNormalized: normalizedUrls[0],
    });

    // Check if Redis supports SMISMEMBER (Redis 6.2+)
    // If not available, fall back to pipeline with SISMEMBER
    try {
      // Try SMISMEMBER first (more efficient for bulk checks)
      const results = await client.smismember(key, normalizedUrls);
      const foundCount = results.filter(r => r === 1).length;
      logger.info("REDIS_BATCH_CHECK_RESULT", "Batch check completed", {
        userId,
        totalUrls: urls.length,
        foundInRedis: foundCount,
        notFound: urls.length - foundCount,
      });
      return results.map((result) => result === 1);
    } catch (error) {
      // Fall back to pipeline with SISMEMBER if SMISMEMBER not available
      const pipeline = client.pipeline();
      normalizedUrls.forEach((url) => {
        pipeline.sismember(key, url);
      });
      const results = await pipeline.exec();
      const foundCount = results.filter(([err, result]) => !err && result === 1).length;
      logger.info("REDIS_BATCH_CHECK_RESULT", "Batch check completed (pipeline)", {
        userId,
        totalUrls: urls.length,
        foundInRedis: foundCount,
        notFound: urls.length - foundCount,
      });
      return results.map(([err, result]) => {
        if (err) {
          logger.warn("REDIS_SISMEMBER_ERROR", "Error checking URL in Redis", {
            error: err.message,
          });
          return false; // On error, treat as new URL
        }
        return result === 1;
      });
    }
  } catch (error) {
    logger.warn("REDIS_BATCH_CHECK_ERROR", "Error batch checking URLs in Redis", {
      error: error.message,
      userId,
      urlCount: urls.length,
    });
    // On error, treat all URLs as new (don't block scraping)
    return urls.map(() => false);
  }
}

/**
 * Check if a single URL exists in Redis for a user
 * @param {string} userId - User ID
 * @param {string} url - URL to check
 * @returns {Promise<boolean>} - true if URL exists, false otherwise
 */
export async function isUrlScraped(userId, url) {
  if (!userId || !url) {
    return false;
  }

  try {
    const client = getRedisClient();
    await client.connect().catch(() => {
      // Already connected or connection in progress
    });

    const key = getUserKey(userId);
    const result = await client.sismember(key, url);
    return result === 1;
  } catch (error) {
    logger.warn("REDIS_CHECK_ERROR", "Error checking URL in Redis", {
      error: error.message,
      userId,
      url,
    });
    // On error, treat as new URL (don't block scraping)
    return false;
  }
}

/**
 * Mark a URL as scraped in Redis for a user
 * @param {string} userId - User ID
 * @param {string} url - URL to mark as scraped
 * @returns {Promise<void>}
 */
export async function markUrlAsScraped(userId, url) {
  if (!userId || !url) {
    return;
  }

  try {
    const client = getRedisClient();
    await client.connect().catch(() => {
      // Already connected or connection in progress
    });

    const key = getUserKey(userId);
    const ttl = getTTL();
    
    // Normalize URL before storing
    const normalizedUrl = normalizeUrl(url);
    
    logger.info("REDIS_MARK_NORMALIZED", "Normalizing URL before marking", {
      originalUrl: url,
      normalizedUrl: normalizedUrl,
      areDifferent: url !== normalizedUrl,
    });

    // Add URL to set and set TTL
    // Use pipeline to ensure atomicity
    const pipeline = client.pipeline();
    pipeline.sadd(key, normalizedUrl);
    pipeline.expire(key, ttl);
    const results = await pipeline.exec();
    
    // Log success
    logger.info("REDIS_URL_MARKED", "URL marked as scraped in Redis", {
      userId,
      originalUrl: url,
      normalizedUrl: normalizedUrl,
      key,
      ttlDays: Math.round(ttl / (24 * 60 * 60)),
    });
  } catch (error) {
    logger.warn("REDIS_MARK_ERROR", "Error marking URL as scraped in Redis", {
      error: error.message,
      userId,
      url,
    });
    // Don't throw - this is non-critical, just log
  }
}

/**
 * Mark multiple URLs as scraped in Redis for a user (batch operation)
 * @param {string} userId - User ID
 * @param {string[]} urls - Array of URLs to mark as scraped
 * @returns {Promise<void>}
 */
export async function batchMarkUrlsAsScraped(userId, urls) {
  if (!userId || !urls || urls.length === 0) {
    return;
  }

  try {
    const client = getRedisClient();
    await client.connect().catch(() => {
      // Already connected or connection in progress
    });

    const key = getUserKey(userId);
    const ttl = getTTL();

    // Add all URLs to set and set TTL
    const pipeline = client.pipeline();
    urls.forEach((url) => {
      pipeline.sadd(key, url);
    });
    pipeline.expire(key, ttl);
    await pipeline.exec();
  } catch (error) {
    logger.warn("REDIS_BATCH_MARK_ERROR", "Error batch marking URLs as scraped in Redis", {
      error: error.message,
      userId,
      urlCount: urls.length,
    });
    // Don't throw - this is non-critical, just log
  }
}

// Export client getter for testing/cleanup if needed
export { getRedisClient };

