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
    maxPages = 10,
    navigationTimeoutMs = 25000,
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

    const protocolTimeout = Number(process.env.PROTOCOL_TIMEOUT || 90000);

    if (endpoint) {
      // Browserless applies memory-optimized flags via DEFAULT_LAUNCH_ARGS env var
      console.log(
        "[BROWSERLESS] Connecting to:",
        endpoint.replace(/token=[^&]+/, "token=***")
      );
      console.log(
        "[BROWSERLESS] Memory flags applied via launch parameter in connection URL"
      );

      // Create memory-optimized launch args for Browserless
      const memoryOptimizedArgs = {
        headless: true,
        args: [
          // Essential security flags
          "--no-sandbox",
          "--disable-setuid-sandbox",

          // Memory optimization flags
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-zygote",
          "--disk-cache-size=0",
          "--media-cache-size=0",
          "--disable-extensions",
          "--mute-audio",

          // Site isolation (stability + memory)
          "--disable-site-isolation-trials",
          "--disable-features=IsolateOrigins,site-per-process",

          // Additional memory optimizations
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-component-extensions-with-background-pages",
          "--disable-hang-monitor",
          "--disable-ipc-flooding-protection",
          "--disable-prompt-on-repost",
          "--disable-renderer-backgrounding",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-first-run",
          "--password-store=basic",
          "--use-mock-keychain",
          "--disable-canvas-aa",
          "--disable-2d-canvas-clip-aa",
          "--disable-gl-drawing-for-tests",
          "--disable-threaded-animation",
          "--disable-threaded-scrolling",
          "--disable-checker-imaging",
          "--disable-new-content-rendering-timeout",
          "--disable-image-animation-resizing",
          "--disable-webgl",
          "--disable-software-rasterizer",
          "--disable-partial-raster",
          "--no-pings",
          "--no-default-browser-check",
          "--disable-web-security",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1024,768",
        ],
      };

      // Pass launch args to Browserless via URL parameter
      const launchArgsParam = encodeURIComponent(
        JSON.stringify(memoryOptimizedArgs)
      );
      const endpointWithArgs = `${endpoint}&launch=${launchArgsParam}`;

      this.browser = await puppeteerCore.connect({
        // browserWSEndpoint: endpoint,
        browserWSEndpoint: endpointWithArgs,
        protocolTimeout: protocolTimeout,
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
          "--disable-blink-features=AutomationControlled",
          "--disable-site-isolation-trials", // Prevent frame detachment issues
          "--disable-features=IsolateOrigins,site-per-process", // Critical for frame stability
        ],
        protocolTimeout: protocolTimeout,
      });
    }
  }

  getBrowser() {
    return this.browser;
  }

  async _newPage() {
    const page = await this.browser.newPage();

    // Set smaller viewport to reduce memory
    await page.setViewport({
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
    });

    await page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    await page.setUserAgent(this.userAgent);

    if (this.blockResources) {
      try {
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const type = req.resourceType();
          const url = req.url();

          // Block images, fonts, media
          if (type === "image" || type === "font" || type === "media") {
            return req.abort();
          }

          // Block stylesheets
          if (
            process.env.BLOCK_STYLESHEETS === "true" &&
            type === "stylesheet"
          ) {
            return req.abort();
          }

          // Block analytics, ads, tracking scripts
          if (
            url.includes("analytics") ||
            url.includes("gtag") ||
            url.includes("googletagmanager") ||
            url.includes("doubleclick") ||
            url.includes("facebook.com") ||
            url.includes("twitter.com") ||
            url.includes("hotjar") ||
            url.includes("segment.") ||
            url.includes("mixpanel") ||
            url.includes("intercom") ||
            url.includes("livechat") ||
            url.includes("tawk.to") ||
            url.includes("zendesk") ||
            url.includes("drift.com") ||
            url.includes("recaptcha") ||
            url.includes("google-analytics") ||
            url.includes("/ads/") ||
            url.includes("/adservice/") ||
            url.includes("/pixel") ||
            type === "websocket"
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

  async release(page) {
    if (this.closed || !page || page.isClosed()) return;

    // Clean page memory before reuse (prevents memory bloat)
    try {
      const client = await page.target().createCDPSession();

      // Aggressive cleanup (all parallel for speed)
      await Promise.all([
        // Clear caches and cookies
        client.send("Network.clearBrowserCache").catch(() => {}),
        client.send("Network.clearBrowserCookies").catch(() => {}),
        // Clear storage (localStorage, sessionStorage, indexedDB)
        client
          .send("Storage.clearDataForOrigin", {
            origin: "*",
            storageTypes: "local_storage,session_storage,indexeddb,websql",
          })
          .catch(() => {}),
        // Clear service workers
        client.send("ServiceWorker.stopAllWorkers").catch(() => {}),
      ]);

      await client.detach();

      // Navigate to blank page to clear DOM and history
      await page
        .goto("about:blank", {
          waitUntil: "domcontentloaded",
          timeout: 2000,
        })
        .catch(() => {});
    } catch (err) {
      // If cleanup fails, just continue (rare, but safe to ignore)
    }

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

    const browser = this.browser;
    this.browser = null;
    if (!browser) return;

    // Try closing all pages first to speed up shutdown
    try {
      const pages = await browser.pages();
      const withTimeout = (p, ms) =>
        Promise.race([
          p,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("page close timeout")), ms)
          ),
        ]);
      const perPageTimeout = Number(process.env.PAGE_CLOSE_TIMEOUT_MS || 5000);
      await Promise.allSettled(
        pages.map((pg) =>
          withTimeout(
            pg.close().catch(() => {}),
            perPageTimeout
          )
        )
      );
    } catch (_) {
      // ignore
    }

    // Close browser with a hard timeout; force-kill if needed
    const closeTimeout = Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 10000);
    try {
      await Promise.race([
        browser.close(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("browser close timeout")),
            closeTimeout
          )
        ),
      ]);
    } catch (_) {
      try {
        // If local browser, kill the process; if remote, disconnect
        const proc =
          typeof browser.process === "function" ? browser.process() : null;
        if (proc && typeof proc.kill === "function") {
          console.log("[BROWSER] Force-killing Chrome process (SIGKILL)");
          proc.kill("SIGKILL");
        } else if (typeof browser.disconnect === "function") {
          console.log("[BROWSER] Disconnecting from remote browser");
          browser.disconnect();
        }
      } catch (_) {
        // ignore
      }
    }

    // Force garbage collection after browser close
    if (global.gc) {
      try {
        global.gc();
        console.log("[BROWSER] Forced GC after browser close");
      } catch (_) {
        // GC not available
      }
    }
  }
}
