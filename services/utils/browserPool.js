// utils/browserPool.js
import dotenv from "dotenv";
dotenv.config();
import puppeteerCore from "puppeteer-core";
import puppeteerLocal from "puppeteer";

/**
 * Lightweight browser + page pool (no external deps).
 * - Single Browser per job
 * - Acquire/release pages with a hard max
 * - Blocks heavy resources by default
 */
export class BrowserPool {
  constructor({
    maxPages = 12,
    navigationTimeoutMs = 60000,
    blockResources = true,
    userAgent = null,
  } = {}) {
    this.maxPages = maxPages;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.blockResources = blockResources;
    this.userAgent =
      userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    this.browser = null;

    this.available = [];
    this.pending = [];
    this.created = 0;
    this.closed = false;
  }

  async init() {
    const endpoint =
      process.env.NODE_ENV === "production"
        ? process.env.BROWSER_WS_ENDPOINT_PRIVATE
        : "";

    if (endpoint) {
      this.browser = await puppeteerCore.connect({
        browserWSEndpoint: endpoint,
      });
    } else {
      this.browser = await puppeteerLocal.launch({
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
  }

  getBrowser() {
    return this.browser;
  }

  async _newPage() {
    const page = await this.browser.newPage();
    await page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    await page.setUserAgent(this.userAgent);

    if (this.blockResources) {
      try {
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const type = req.resourceType();
          if (type === "image" || type === "font" || type === "media") {
            return req.abort();
          }
          // Stylesheets are usually safe to block for Maps; keep enabled if you see layout issues.
          if (
            process.env.BLOCK_STYLESHEETS === "true" &&
            type === "stylesheet"
          ) {
            return req.abort();
          }
          req.continue();
        });
      } catch (_) {
        // Ignore if interception fails (rare on some remote setups).
      }
    }

    // If the page closes/crashes, drop it from the pool.
    page.once("close", () => {
      // Do nothing if we already closed whole pool.
      if (this.closed) return;
      // Remove from available if present
      const idx = this.available.indexOf(page);
      if (idx >= 0) this.available.splice(idx, 1);
      // Allow a replacement to be created later.
      this.created = Math.max(0, this.created - 1);
    });

    return page;
  }

  async acquire() {
    if (this.closed) throw new Error("BrowserPool is closed");

    if (this.available.length > 0) {
      const page = this.available.pop();
      if (page && !page.isClosed()) return page;
    }
    if (this.created < this.maxPages) {
      this.created += 1;
      return this._newPage();
    }

    // Wait in queue
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  release(page) {
    if (this.closed || !page || page.isClosed()) return;
    if (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter.resolve(page);
      return;
    }
    this.available.push(page);
  }

  async close() {
    this.closed = true;
    // Reject any waiters
    for (const waiter of this.pending) {
      waiter.reject(new Error("BrowserPool closed"));
    }
    this.pending = [];
    this.available = [];
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (_) {}
    }
  }
}
