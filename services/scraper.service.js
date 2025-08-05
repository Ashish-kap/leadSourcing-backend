import dotenv from "dotenv";
dotenv.config();
// import puppeteer from "puppeteer";
import puppeteer from "puppeteer-core";
import { executablePath } from "puppeteer";
import logger from "./logger.js";

async function safeEvaluate(page, fn, ...args) {
  const timeout = 30000;
  logger.info("SAFE_EVALUATE", "Starting safe evaluate with timeout", {
    timeout,
  });
  try {
    const result = await Promise.race([
      page.evaluate(fn, ...args),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`evaluate timed out after ${timeout}ms`)),
          timeout
        )
      ),
    ]);
    logger.info("SAFE_EVALUATE", "Safe evaluate completed successfully");
    return result;
  } catch (error) {
    logger.error("SAFE_EVALUATE", "Safe evaluate failed", error);
    throw error;
  }
}

export async function runScraper({ keyword, city, state }, job) {
  logger.info("SCRAPER_START", "Starting scraper", { keyword, city, state });
  const results = [];
  const formattedCity = city.replace(/ /g, "+");
  const formattedState = state ? `+${state.replace(/ /g, "+")}` : "";

  // Step 1: Get executable path
  logger.info("EXECUTABLE_PATH", "Getting executable path");
  const execPath = executablePath();
  logger.info("EXECUTABLE_PATH", "Executable path obtained", { execPath });

  // Step 2: Launch browser
  logger.info("BROWSER_LAUNCH", "Attempting to launch browser");
  const launchStart = Date.now();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
      "--disable-accelerated-2d-canvas",
      "--disable-web-security",
    ],
    protocolTimeout: 120000,
  });

  const launchTime = Date.now() - launchStart;
  logger.info("BROWSER_LAUNCH", "Browser launched successfully", {
    launchTimeMs: launchTime,
  });

  // const browser = await puppeteer.connect({
  //   browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
  // });

  try {
    logger.info("PAGE_CREATE", "Creating new page");
    const page = await browser.newPage();
    logger.info("PAGE_CREATE", "New page created successfully");

    await page.setDefaultNavigationTimeout(60000);

    const searchUrl = `https://www.google.com/maps/search/${keyword}+in+${formattedCity}${formattedState}`;

    logger.info("SEARCH_URL", "Search URL constructed", { searchUrl });

    logger.info("PROGRESS_UPDATE", "Setting initial progress");
    await job.progress({ processed: 0, total: 0 });
    logger.info("PROGRESS_UPDATE", "Initial progress set");

    // Step 7: Navigate to search URL
    logger.info("PAGE_NAVIGATION", "Starting navigation to search URL");
    const navStart = Date.now();
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 120000 });
    const navTime = Date.now() - navStart;
    logger.info("PAGE_NAVIGATION", "Navigation completed", {
      navigationTimeMs: navTime,
    });

    logger.info("AUTO_SCROLL", "Starting auto scroll");
    const scrollStart = Date.now();
    await autoScroll(page);
    const scrollTime = Date.now() - scrollStart;
    logger.info("AUTO_SCROLL", "Auto scroll completed", {
      scrollTimeMs: scrollTime,
    });

    // Step 9: Extract listing URLs
    logger.info("EXTRACT_LISTINGS", "Starting to extract listing URLs");
    const extractStart = Date.now();
    const listingUrls = await safeEvaluate(page, () => {
      return Array.from(document.querySelectorAll(".Nv2PK"))
        .map((listing) => {
          const anchor = listing.querySelector("a.hfpxzc");
          return anchor ? anchor.href : null;
        })
        .filter(Boolean);
    });
    const extractTime = Date.now() - extractStart;
    logger.info("EXTRACT_LISTINGS", "Listing URLs extracted", {
      count: listingUrls.length,
      extractTimeMs: extractTime,
      sampleUrls: listingUrls.slice(0, 3), // Log first 3 URLs as sample
    });

    if (listingUrls.length === 0) {
      logger.warn(
        "EXTRACT_LISTINGS",
        "No listing URLs found - possible selector issue or page not loaded"
      );
    }



    // const listingUrls = await page.evaluate(() => {
    //   return Array.from(document.querySelectorAll(".Nv2PK"))
    //     .map((listing) => {
    //       const anchor = listing.querySelector("a.hfpxzc");
    //       return anchor ? anchor.href : null;
    //     })
    //     .filter(Boolean);
    // });

    // Update progress with total listings
    await job.progress({ processed: 0, total: listingUrls.length });

    // Step 2: Process listings in batches
    const BATCH_SIZE = 1;
    for (let i = 0; i < listingUrls.length; i += BATCH_SIZE) {
      const batch = listingUrls.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (url) => {
          const detailPage = await browser.newPage();
          try {
            await detailPage.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });
            const businessData = await extractBusinessDetails(
              detailPage,
              browser,
              keyword,
              `${city}, ${state}`
            );
            return { url, ...businessData };
          } finally {
            await detailPage.close();
          }
        })
      );

      results.push(...batchResults.filter(Boolean));

      const processed = Math.min(i + BATCH_SIZE, listingUrls.length);
      await job.progress({
        processed,
        total: listingUrls.length,
      });
    }

    // Step 3: Generate CSV
    // await generateCSV(results, keyword, city, state);
    return results;
  } finally {
    await browser.close();
  }
}

async function extractBusinessDetails(
  page,
  browser,
  searchTerm,
  searchLocation
) {
  let businessData;

  try {
    businessData = await page.evaluate(
      (searchTerm, searchLocation) => {
        const getText = (selector) =>
          document.querySelector(selector)?.textContent?.trim() || null;

        const getHref = (selector) =>
          document.querySelector(selector)?.href || null;

        // Extract coordinates from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const coords = urlParams.get("!3d")?.split("!4d") || [];

        // Extract categories
        const categories = Array.from(
          document.querySelectorAll('[class*="DkEaL"]')
        )
          .map((el) => el.textContent.trim())
          .filter(Boolean);

        // Extract rating details
        const ratingElement = document.querySelector('.ceNzKf[role="img"]');
        const ratingText = ratingElement?.getAttribute("aria-label") || "";
        const phoneElement = document.querySelector(
          'a[aria-label="Call phone number"]'
        );
        const phoneNumber = phoneElement
          ? phoneElement.href.replace("tel:", "")
          : null;

        const addressButton = document.querySelector(
          'button[aria-label^="Address:"]'
        );
        const address = addressButton
          ? addressButton
              .getAttribute("aria-label")
              .replace("Address: ", "")
              .trim()
          : null;

        return {
          name: getText(".DUwDvf.lfPIob"),
          phone: phoneNumber,
          website: getHref('[aria-label*="Website"]'),
          address: address,
          latitude: coords[0] || null,
          longitude: coords[1] || null,
          rating: ratingText.replace(/\D+$/g, "") || null,
          rating_count:
            getText('[aria-label*="reviews"]')?.match(/\d+/)?.[0] || "0",
          category: categories.join(", "),
          search_term: searchTerm,
          search_type: "Google Maps",
          search_location: searchLocation,
          // opening_hours: Array.from(document.querySelectorAll(".eK4R0e tr"))
          //   .map((row) => ({
          //     day: row.querySelector(".ylH6lf")?.textContent.trim(),
          //     hours: row.querySelector(".mxowUb")?.textContent.trim(),
          //   }))
          //   .filter((x) => x.day && x.hours),
        };
      },
      searchTerm,
      searchLocation
    );

    // Add email if website exists
    if (businessData.website) {
      const emailPage = await browser.newPage();
      try {
        await emailPage.goto(businessData.website, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        businessData.email = await emailPage.evaluate(() => {
          const emailRegex =
            /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
          return document.body.textContent.match(emailRegex)?.[0] || null;
        });
      } catch (error) {
        console.error(
          `Failed to extract email from ${businessData.website}: ${error.message}`
        );
      } finally {
        await emailPage.close();
      }
    }
  } catch (error) {
    console.error(`Error extracting details: ${error.message}`);
    return null;
  }

  return businessData;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const wrapper = document.querySelector('div[role="feed"]');

    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const scrollDelay = 1000;

      const timer = setInterval(async () => {
        const scrollHeightBefore = wrapper.scrollHeight;
        wrapper.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeightBefore) {
          totalHeight = 0;
          await new Promise((r) => setTimeout(r, scrollDelay));

          const scrollHeightAfter = wrapper.scrollHeight;
          if (scrollHeightAfter <= scrollHeightBefore) {
            clearInterval(timer);
            resolve();
          }
        }
      }, 200);
    });
  });
}
