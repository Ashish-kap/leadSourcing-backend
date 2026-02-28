// listingUrl.js - Quick test harness for gmaps_listings.js via Browserless /function
import "dotenv/config";
import fs from "node:fs";

const TOKEN =
  process.env.BROWSERLESS_TOKEN ||
  process.env.BROWSERLESS_API_TOKEN ||
  process.env.BROWSER_TOKEN ||
  "";
const BASE_URL =
  process.env.BROWSERLESS_FUNCTION_API_URL ||
  process.env.BROWSERLESS_CONTENT_API_URL ||
  process.env.BROWSERLESS_BASE_URL ||
  "";

const USE_THORDATA_PROXY = String(process.env.USE_THORDATA_PROXY || "").toLowerCase() === "true";
const PROXY_HOST = process.env.THORDATA_PROXY_HOST || "";
const PROXY_PORT = process.env.THORDATA_PROXY_PORT || "";
const PROXY_USER = process.env.THORDATA_PROXY_USERNAME || "";
const PROXY_PASS = process.env.THORDATA_PROXY_PASSWORD || "";

let launchJson;
if (USE_THORDATA_PROXY && PROXY_HOST) {
  const hostPort = PROXY_PORT ? `${PROXY_HOST}:${PROXY_PORT}` : PROXY_HOST;
  const proxyUrl = PROXY_USER
    ? `http://${PROXY_USER}:${PROXY_PASS}@${hostPort}`
    : `http://${hostPort}`;
  launchJson = encodeURIComponent(
    JSON.stringify({
      stealth: true,
      externalProxyServer: proxyUrl,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
    })
  );
} else {
  launchJson = encodeURIComponent(
    JSON.stringify({
      stealth: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
    })
  );
}

if (!BASE_URL) {
  throw new Error(
    "BROWSERLESS function/base URL is not set. " +
    "Set BROWSERLESS_FUNCTION_API_URL or BROWSERLESS_CONTENT_API_URL in your environment."
  );
}


const url = `${BASE_URL.replace(/\/$/, "")}/function?token=${TOKEN}&launch=${launchJson}`;

// Build searchUrl like scraper3.service.js (zone with coords, or city center with location name)
const searchUrlBase = "https://www.google.com/maps/search/";
const keyword = process.env.LISTING_KEYWORD || "salon";
const countryCode = process.env.LISTING_GL || "IN";
const hl = process.env.LISTING_HL || "en";
const cityName = process.env.LISTING_CITY || "Andheri West";
const countryName = process.env.LISTING_COUNTRY || "India";
// Optional: set LISTING_LAT and LISTING_LNG for zone search (e.g. "19.13" and "72.83"); leave unset for city-center search
const coords =
  process.env.LISTING_LAT && process.env.LISTING_LNG
    ? { lat: process.env.LISTING_LAT, lng: process.env.LISTING_LNG }
    : null;

let searchUrl;
if (coords) {
  const query = encodeURIComponent(keyword);
  const coordString = `@${coords.lat},${coords.lng},14z`;
  searchUrl = `${searchUrlBase}${query}/${coordString}?gl=${countryCode}&hl=${hl}`;
} else {
  const formattedLocation = [cityName, countryName]
    .filter(Boolean)
    .join(" ")
    .replace(/,/g, "")
    .replace(/\s+/g, "+");
  const query = `${encodeURIComponent(keyword)}+in+${formattedLocation}`;
  searchUrl = `${searchUrlBase}${query}?gl=${countryCode}&hl=${hl}`;
}


const functionCode = fs.readFileSync("./gmaps_listings.js", "utf8");

const payload = JSON.stringify({
  code: functionCode,
  context: {
    url: searchUrl,
    maxResults: 50,
    maxScrolls: 25,
    hl,
    gl: countryCode,
    waitMs: 800,
    panelWaitMs: 2500,
  },
});

async function sendRequest() {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload
  });

  const text = await res.text();

  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.error("Non-JSON response from Browserless:");
    console.error("Status:", res.status, res.statusText);
    console.error(text.slice(0, 2000));
  }
}

sendRequest().catch(console.error);
