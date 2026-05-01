import dotenv from "dotenv";
dotenv.config();
import logger from "../logger.js";

function parseEndpointList(primaryEnvVar, fallbackEnvVar) {
  const raw = process.env[primaryEnvVar] || process.env[fallbackEnvVar] || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// WS endpoints: full wss://...?token=... URLs (token embedded per-URL)
// Set BROWSER_WS_ENDPOINTS=wss://host1?token=abc,wss://host2?token=abc
// Falls back to the single BROWSER_WS_ENDPOINT_PRIVATE for backward compatibility
const wsEndpoints = parseEndpointList(
  "BROWSER_WS_ENDPOINTS",
  "BROWSER_WS_ENDPOINT_PRIVATE"
);

// HTTP endpoints: base URLs only, token comes from BROWSERLESS_API_TOKEN
// Set BROWSERLESS_HTTP_ENDPOINTS=https://host1.railway.app,https://host2.railway.app
// Falls back to the single BROWSERLESS_CONTENT_API_URL for backward compatibility
const httpEndpoints = parseEndpointList(
  "BROWSERLESS_HTTP_ENDPOINTS",
  "BROWSERLESS_CONTENT_API_URL"
);

let wsIdx = 0;
let httpIdx = 0;

logger.info(
  "BROWSERLESS_POOL_INIT",
  `WS pool: ${wsEndpoints.length} endpoint(s), HTTP pool: ${httpEndpoints.length} endpoint(s)`
);

export function getWsEndpoint() {
  if (!wsEndpoints.length) return "";
  const ep = wsEndpoints[wsIdx];
  wsIdx = (wsIdx + 1) % wsEndpoints.length;
  return ep;
}

export function getHttpEndpoint() {
  if (!httpEndpoints.length) return "";
  const ep = httpEndpoints[httpIdx];
  httpIdx = (httpIdx + 1) % httpEndpoints.length;
  return ep;
}

export const wsPoolSize = wsEndpoints.length;
export const httpPoolSize = httpEndpoints.length;
