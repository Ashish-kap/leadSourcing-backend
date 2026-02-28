import "dotenv/config";
import logger from "../logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Config (reuse same env vars as googleMapsScraper.js) ────────────────────
const BROWSERLESS_API_BASE =
    process.env.BROWSERLESS_CONTENT_API_URL 
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_API_TOKEN 

// Proxy config (same env vars as browserPool.js)
const USE_PROXY =
    String(process.env.USE_THORDATA_PROXY || "").toLowerCase() === "true";
const PROXY_HOST = (process.env.THORDATA_PROXY_HOST || "").trim();
const PROXY_PORT = String(process.env.THORDATA_PROXY_PORT || "").trim();
const PROXY_USER = (process.env.THORDATA_PROXY_USERNAME || "").trim();
const PROXY_PASS = String(process.env.THORDATA_PROXY_PASSWORD || "");

const FUNCTION_TIMEOUT = Number(
    process.env.REVIEW_FUNCTION_TIMEOUT || 120000
);

// ── Read the function code once at module load ──────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTION_CODE_PATH = path.resolve(__dirname, "../../gmaps_reviews.js");

let functionCode = "";
try {
    functionCode = fs.readFileSync(FUNCTION_CODE_PATH, "utf8");
    logger.info(
        "REVIEW_EXTRACTOR_INIT",
        `Loaded gmaps_reviews.js (${functionCode.length} bytes)`
    );
} catch (err) {
    logger.error(
        "REVIEW_EXTRACTOR_INIT",
        `Failed to load gmaps_reviews.js: ${err.message}`
    );
}

// ── Concurrency limiter (same pattern as googleMapsScraper.js) ──────────────
const REVIEW_CONCURRENCY = Number(
    process.env.REVIEW_API_CONCURRENCY || 2
);

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

const limitReview = createLimiter(REVIEW_CONCURRENCY || 3);

// ── Build Browserless /function URL (same approach as listingUrl.js) ────────
function buildFunctionUrl() {
    const launch = {
        stealth: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
        ],
    };

    if (USE_PROXY && PROXY_HOST && PROXY_PORT && PROXY_USER) {
        const proxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
        launch.externalProxyServer = proxyUrl;
    }

    const launchJson = encodeURIComponent(JSON.stringify(launch));
    return `${BROWSERLESS_API_BASE}/function?token=${BROWSERLESS_TOKEN}&launch=${launchJson}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract reviews from a Google Maps listing URL via Browserless Function API.
 *
 * @param {string} url  – Google Maps listing URL
 * @param {object} opts
 * @param {number|null} opts.reviewTimeRange – years to look back (null = all)
 * @param {boolean}     opts.extractNegativeReviews – filter 1-2 star
 * @param {number}      opts.maxReviews – max reviews to return (default 50)
 * @param {number}      opts.maxScrollAttempts – scroll iterations (default 30)
 * @param {string}      opts.hl – language code (default "en")
 * @param {string}      opts.gl – country code (default "")
 * @param {string|null} opts.sort – "newest"|"highest"|"lowest"|"relevant"|null
 * @param {Function|null} opts.shouldCancel – returns true if job cancelled
 * @returns {Promise<{ reviews: Array, reviewCount: number }>}
 */
export async function extractReviewsViaFunction(
    url,
    {
        reviewTimeRange = null,
        extractNegativeReviews = false,
        maxReviews = 50,
        maxScrollAttempts = 30,
        hl = "en",
        gl = "",
        sort = null,
        shouldCancel = null,
    } = {}
) {
    const empty = { reviews: [], reviewCount: 0 };

    if (!functionCode) {
        logger.error(
            "REVIEW_FUNCTION",
            "gmaps_reviews.js not loaded — cannot extract reviews"
        );
        return empty;
    }

    if (!BROWSERLESS_API_BASE || !BROWSERLESS_TOKEN) {
        logger.error(
            "REVIEW_FUNCTION",
            "BROWSERLESS_CONTENT_API_URL / BROWSERLESS_API_TOKEN not set"
        );
        return empty;
    }

    // Apply concurrency limiter
    return await limitReview(async () => {
        if (shouldCancel && shouldCancel()) {
            logger.debug("REVIEW_FUNCTION_CANCELLED", "Cancelled before start", {
                url,
            });
            return empty;
        }

        const functionUrl = buildFunctionUrl();

        const payload = JSON.stringify({
            code: functionCode,
            context: {
                url,
                reviewTimeRangeYears: reviewTimeRange,
                negativeOnly: extractNegativeReviews,
                maxReviews,
                maxScrolls: maxScrollAttempts,
                sort: sort || (extractNegativeReviews ? "lowest" : null),
                hl,
                gl,
            },
        });

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FUNCTION_TIMEOUT);

            logger.info("REVIEW_FUNCTION_REQUEST", "Calling Browserless /function", {
                url,
                reviewTimeRange,
                extractNegativeReviews,
                maxReviews,
                hl,
                gl,
            });

            const response = await fetch(functionUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: payload,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                let bodySnippet = "";
                try {
                    const text = await response.text();
                    bodySnippet = text.slice(0, 500);
                } catch (_) { }

                logger.error("REVIEW_FUNCTION_HTTP_ERROR", "Non-OK response", {
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    body: bodySnippet,
                });
                return empty;
            }

            const result = await response.json();

            // The function returns { data: { reviews, reviewCount, ... }, type }
            const data = result?.data || result;

            // Pipe function-local logs into the real logger so we can debug remote runs
            try {
                if (Array.isArray(data._logs)) {
                    data._logs.forEach((entry) => {
                        try {
                            logger.info(entry.event || "REVIEW_FUNCTION_LOG", entry.msg || "", entry.payload || {});
                        } catch (_) {}
                    });
                }
            } catch (_) {}

            if (data.error) {
                logger.warn("REVIEW_FUNCTION_LOGIC_ERROR", data.error, { url });
                return empty;
            }

            const reviews = Array.isArray(data.reviews) ? data.reviews : [];
            const reviewCount =
                typeof data.reviewCount === "number" ? data.reviewCount : reviews.length;

            logger.info("REVIEW_FUNCTION_SUCCESS", "Reviews extracted", {
                url,
                reviewCount,
            });

            return { reviews, reviewCount };
        } catch (err) {
            if (err.name === "AbortError") {
                logger.error(
                    "REVIEW_FUNCTION_TIMEOUT",
                    `Timeout after ${FUNCTION_TIMEOUT}ms`,
                    { url }
                );
            } else {
                logger.error("REVIEW_FUNCTION_ERROR", err.message, {
                    url,
                    stack: err.stack,
                });
            }
            return empty;
        }
    });
}
