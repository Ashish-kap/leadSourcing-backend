import "dotenv/config";
import logger from "../logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Config ───────────────────────────────────────────────────────────────────
import { getHttpEndpoint } from "./browserlessPool.js";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_API_TOKEN;

// Proxy config (same as reviewExtractor) – use proxy so Google shows review counts on listing cards
const USE_PROXY =
    String(process.env.USE_THORDATA_PROXY || "").toLowerCase() === "true";
const PROXY_HOST = (process.env.THORDATA_PROXY_HOST || "").trim();
const PROXY_PORT = String(process.env.THORDATA_PROXY_PORT || "").trim();
const PROXY_USER = (process.env.THORDATA_PROXY_USERNAME || "").trim();
const PROXY_PASS = String(process.env.THORDATA_PROXY_PASSWORD || "");

const FUNCTION_TIMEOUT = Number(
    process.env.LISTING_FUNCTION_TIMEOUT || 90000
);

// ── Read the function code once at module load ──────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTION_CODE_PATH = path.resolve(__dirname, "../../gmaps_listings.js");

let functionCode = "";
try {
    functionCode = fs.readFileSync(FUNCTION_CODE_PATH, "utf8");
    logger.info(
        "LISTING_EXTRACTOR_INIT",
        `Loaded gmaps_listings.js (${functionCode.length} bytes)`
    );
} catch (err) {
    logger.error(
        "LISTING_EXTRACTOR_INIT",
        `Failed to load gmaps_listings.js: ${err.message}`
    );
}

// ── Concurrency limiter ─────────────────────────────────────────────────────
const LISTING_CONCURRENCY = Number(
    process.env.LISTING_API_CONCURRENCY || 2
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

const limitListing = createLimiter(LISTING_CONCURRENCY);

// ── Build Browserless /function URL (with proxy so Google shows review counts) ─
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
    return `${getHttpEndpoint()}/function?token=${BROWSERLESS_TOKEN}&launch=${launchJson}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract listing URLs from a Google Maps search URL via Browserless Function API.
 *
 * @param {string} searchUrl – Google Maps search URL
 * @param {object} opts
 * @param {number}        opts.maxResults  – max listings to return (default 200)
 * @param {number}        opts.maxScrolls  – scroll iterations (default 25)
 * @param {string}        opts.hl          – language code (default "en")
 * @param {string}        opts.gl          – country code (default "IN")
 * @param {Function|null} opts.shouldCancel – returns true if job cancelled
 * @returns {Promise<{ listings: Array<{url,rating,reviewCount,businessName}>, listingCount: number }>}
 */
export async function extractListingsViaFunction(
    searchUrl,
    {
        maxResults = 200,
        maxScrolls = 25,
        hl = "en",
        gl = "IN",
        shouldCancel = null,
    } = {}
) {
    const empty = { listings: [], listingCount: 0 };

    if (!functionCode) {
        logger.error(
            "LISTING_FUNCTION",
            "gmaps_listings.js not loaded — cannot extract listings"
        );
        return empty;
    }

    if (!BROWSERLESS_TOKEN) {
        logger.error(
            "LISTING_FUNCTION",
            "BROWSERLESS_API_TOKEN not set"
        );
        return empty;
    }

    return await limitListing(async () => {
        if (shouldCancel && shouldCancel()) {
            logger.debug("LISTING_FUNCTION_CANCELLED", "Cancelled before start", {
                searchUrl,
            });
            return empty;
        }

        const functionUrl = buildFunctionUrl();

        const payload = JSON.stringify({
            code: functionCode,
            context: {
                url: searchUrl,
                maxResults,
                maxScrolls,
                hl,
                gl,
            },
        });

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FUNCTION_TIMEOUT);

            logger.info("LISTING_FUNCTION_REQUEST", "Calling Browserless /function for listings", {
                searchUrl,
                maxResults,
                maxScrolls,
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

                logger.error("LISTING_FUNCTION_HTTP_ERROR", "Non-OK response", {
                    searchUrl,
                    status: response.status,
                    statusText: response.statusText,
                    body: bodySnippet,
                });
                return empty;
            }

            const result = await response.json();
            const data = result?.data || result;

            // Pipe function-local logs into the real logger
            try {
                if (Array.isArray(data._logs)) {
                    data._logs.forEach((entry) => {
                        try {
                            logger.info(entry.event || "LISTING_FUNCTION_LOG", entry.msg || "", entry.payload || {});
                        } catch (_) {}
                    });
                }
            } catch (_) {}

            if (data.error) {
                logger.warn("LISTING_FUNCTION_LOGIC_ERROR", data.error, { searchUrl });
                return empty;
            }

            const listings = Array.isArray(data.listings) ? data.listings : [];
            const listingCount =
                typeof data.listingCount === "number" ? data.listingCount : listings.length;

            logger.info("LISTING_FUNCTION_SUCCESS", "Listings extracted", {
                searchUrl,
                listingCount,
            });

            return { listings, listingCount };
        } catch (err) {
            if (err.name === "AbortError") {
                logger.error(
                    "LISTING_FUNCTION_TIMEOUT",
                    `Timeout after ${FUNCTION_TIMEOUT}ms`,
                    { searchUrl }
                );
            } else {
                logger.error("LISTING_FUNCTION_ERROR", err.message, {
                    searchUrl,
                    stack: err.stack,
                });
            }
            return empty;
        }
    });
}
