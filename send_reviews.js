// send_reviews.js - Quick test harness for gmaps_reviews.js via Browserless /function
import 'dotenv/config';
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

const endpoint = `${BASE_URL.replace(/\/$/, "")}/function?token=${TOKEN}&launch=${launchJson}`;

const code = fs.readFileSync("./gmaps_reviews.js", "utf8");

const payload = {
  code,
  context: {
    url: "https://www.google.com/maps/place/Rendezvous/@19.117763,72.855965,17z/data=!3m1!1e3!4m8!3m7!1s0x3be7c82df4b38aa7:0x866bf0a6c3784d1c!8m2!3d19.117763!4d72.855965!9m1!1b1!16s%2Fg%2F1q5bw78y9?hl=en&gl=IN",

    maxReviews: 30,
    maxScrolls: 10,
    scrollWaitMs: 1000,

    sort: "lowest",
    negativeOnly: true,
    reviewTimeRangeYears: null,

    hl: "en",
    gl: "IN",

    debug: true,
    screenshotOnError: true,
  },
};


const res = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const text = await res.text();
try {
  const json = JSON.parse(text);
  // Don't dump the huge base64 screenshot to console
  if (json?.data?.screenshotBase64) {
    json.data.screenshotBase64 = "(omitted)";
  }
  console.log(JSON.stringify(json, null, 2));
} catch {
  console.error("Non-JSON response:", res.status, res.statusText);
  console.error(text.slice(0, 2000));
}
