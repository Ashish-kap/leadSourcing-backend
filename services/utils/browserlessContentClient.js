

import logger from '../logger.js';
import { Agent } from 'undici';

const BROWSERLESS_API_URL = process.env.BROWSERLESS_CONTENT_API_URL;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_API_TOKEN;
const API_TIMEOUT = Number(process.env.EMAIL_API_TIMEOUT || 30000); // Default 30s
const EMAIL_API_CONCURRENCY = Number(process.env.EMAIL_API_CONCURRENCY || 10);

// Configure HTTP agent for better connection management
// Prevents "Request closed prior to writing results" errors
const httpAgent = new Agent({
  connections: 50,           // Max sockets per origin
  pipelining: 1,             // Requests per socket
  keepAliveTimeout: 60000,   // Keep connections alive 60s
  keepAliveMaxTimeout: 120000, // Max keep-alive duration
  headersTimeout: 60000,     // Wait 60s for headers
  bodyTimeout: 60000,        // Wait 60s for body
  connect: {
    timeout: 30000           // Connection timeout 30s
  }
});

// Log configuration on module load
logger.info("BROWSERLESS_CLIENT_CONFIG", JSON.stringify({
  apiUrl: BROWSERLESS_API_URL,
  hasToken: !!BROWSERLESS_TOKEN,
  timeout: API_TIMEOUT,
  concurrency: EMAIL_API_CONCURRENCY
}));

/**
 * Fetch page content from Browserless Content API
 * @param {string} url - Website URL to fetch
 * @param {object} options - Additional options
 * @returns {Promise<{html?: string, url: string, status?: number, error?: string, details?: object}>}
 */
export async function fetchPageContent(url, options = {}) {
  const timeout = options.timeout || API_TIMEOUT;
  
  if (!BROWSERLESS_API_URL || !BROWSERLESS_TOKEN) {
    const errorDetails = {
      url,
      message: 'BROWSERLESS_CONTENT_API_URL and BROWSERLESS_API_TOKEN must be set',
      statusCode: null,
      statusText: 'Configuration Error',
      responseBody: null,
      requestTimeout: timeout,
      timestamp: new Date().toISOString()
    };
    logger.error('BROWSERLESS_API_ERROR', `Configuration error for ${url}:`, errorDetails);
    return { html: null, url, error: errorDetails.message, details: errorDetails };
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(
      `${BROWSERLESS_API_URL}/content?token=${BROWSERLESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url,
          gotoOptions: {
            waitUntil: 'networkidle2',
            timeout: 30000
          }
        }),
        signal: controller.signal,
        dispatcher: httpAgent  // Use custom agent for connection pooling
      }
    );
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      // Try to get error response body
      let responseBody = null;
      try {
        const contentType = response.headers.get('content-type') || '';
        let bodyText = await response.text();
        
        // Try to parse as JSON if it looks like JSON
        if (contentType.includes('application/json') || (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('['))) {
          try {
            const parsed = JSON.parse(bodyText);
            bodyText = typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
          } catch {
            // Not valid JSON, use as-is
          }
        }
        
        // Ensure it's a string and truncate if too long
        responseBody = typeof bodyText === 'string' 
          ? (bodyText.length > 500 ? bodyText.substring(0, 500) : bodyText)
          : String(bodyText);
      } catch (e) {
        // Ignore if we can't read response body
        responseBody = `Error reading response: ${e.message}`;
      }
      
      const errorDetails = {
        url,
        message: `Browserless API error: ${response.status} ${response.statusText}`,
        statusCode: response.status,
        statusText: response.statusText,
        responseBody,
        requestTimeout: timeout,
        timestamp: new Date().toISOString()
      };
      
      logger.error("BROWSERLESS_API_ERROR", `Failed to fetch ${url}:`, JSON.stringify(errorDetails));
      
      return { 
        html: null, 
        url,
        error: `Browserless API error: ${response.status} ${response.statusText}`,
        details: errorDetails 
      };
    }
    
    // Add timeout for reading response body
    const bodyTimeoutId = setTimeout(() => controller.abort(), timeout);
    const html = await response.text();
    clearTimeout(bodyTimeoutId);
    
    logger.info('BROWSERLESS_API_SUCCESS', `Fetched ${url}: ${html.length} chars`);
    
    return { html, url, status: response.status };
  } catch (error) {
    if (error.name === 'AbortError') {
      const errorDetails = {
        url,
        message: `Request timeout after ${timeout}ms`,
        statusCode: null,
        statusText: 'Timeout',
        responseBody: null,
        requestTimeout: timeout,
        timestamp: new Date().toISOString()
      };
      
      logger.error('BROWSERLESS_API_ERROR', `Timeout fetching ${url} after ${timeout}ms:`, JSON.stringify(errorDetails));
      
      return { 
        html: null, 
        url,
        error: `Request timeout after ${timeout}ms`,
        details: errorDetails 
      };
    }
    
    // Generic error - create details object
    const errorDetails = {
      url,
      message: error.message,
      statusCode: null,
      statusText: null,
      responseBody: null,
      requestTimeout: timeout,
      timestamp: new Date().toISOString()
    };
    
    logger.error('BROWSERLESS_API_ERROR', `Failed to fetch ${url}:`, JSON.stringify(errorDetails));
    
    return { 
      html: null, 
      url,
      error: error.message,
      details: errorDetails 
    };
  }
}

/**
 * Fetch page content with retry logic for transient errors
 * @param {string} url - Website URL to fetch
 * @param {number} maxRetries - Maximum number of retries (default: 2)
 * @returns {Promise<{html?: string, url: string, status?: number, error?: string, details?: object}>}
 */
export async function fetchPageContentWithRetry(url, maxRetries = 2) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    logger.info("FETCH_ATTEMPT", JSON.stringify({ url, attempt, maxRetries: maxRetries + 1 }));
    
    const result = await fetchPageContent(url);
    
    // Success
    if (!result.error) {
      if (attempt > 1) {
        logger.info("FETCH_RETRY_SUCCESS", JSON.stringify({ url, attempt }));
      }
      return result;
    }
    
    // Check if retryable (500 errors or timeouts)
    const isRetryable = result.details?.statusCode >= 500 || 
                       result.error.includes('timeout') ||
                       result.error.includes('ETIMEDOUT');
    
    if (!isRetryable || attempt >= maxRetries + 1) {
      logger.warn("FETCH_FAILED_NO_RETRY", JSON.stringify({ url, attempt, error: result.error, isRetryable }));
      return result;
    }
    
    // Exponential backoff: 2s, 4s, 8s
    const delay = Math.pow(2, attempt) * 1000;
    logger.info("FETCH_RETRY_DELAY", JSON.stringify({ url, attempt, delayMs: delay, reason: result.error }));
    await new Promise(resolve => setTimeout(resolve, delay));
    lastError = result;
  }
  
  return lastError;
}

/**
 * Fetch multiple pages concurrently with rate limiting
 * @param {string[]} urls - Array of URLs to fetch
 * @param {number} concurrency - Max concurrent requests
 * @returns {Promise<Array<{url: string, html?: string, error?: string, details?: object}>>}
 */
export async function fetchMultiplePages(urls, concurrency = 10) {
  if (!urls || urls.length === 0) {
    return [];
  }
  
  try {
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(concurrency);
    
    const tasks = urls.map(url => 
      limit(async () => {
        const result = await fetchPageContent(url);
        if (result.error) {
          return { url, error: result.error, details: result.details };
        }
        return { url, html: result.html };
      })
    );
    
    return Promise.all(tasks);
  } catch (error) {
    logger.error('BROWSERLESS_API_BATCH_ERROR', `Failed to fetch multiple pages: ${error.message}`);
    // Return error results for all URLs
    return urls.map(url => ({ url, error: error.message }));
  }
}

