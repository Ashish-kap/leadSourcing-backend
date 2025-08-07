import dotenv from "dotenv";
dotenv.config();
// import puppeteer from "puppeteer";
import puppeteer from "puppeteer-core";
import { executablePath } from "puppeteer";
import logger from "./logger.js";
import autoScroll from "./autoScroll.js";

async function safeEvaluate(page, fn, ...args) {
  const timeout = 30000;
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
    return result;
  } catch (error) {
    throw error;
  }
}

export async function runScraper({ keyword, city, state }, job) {
  logger.info("SCRAPER_START", "Starting scraper", { keyword, city, state });
  const results = [];
  const formattedCity = city.replace(/ /g, "+");
  const formattedState = state ? `+${state.replace(/ /g, "+")}` : "";

  // Step 1: Get executable path
  // const execPath = executablePath();
  // Step 2: Launch browser
  // const launchStart = Date.now();
  // const browser = await puppeteer.launch({
  //   headless: true,
  //   executablePath: executablePath(),
  //   args: [
  //     "--no-sandbox",
  //     "--disable-setuid-sandbox",
  //     "--disable-gpu",
  //     "--disable-dev-shm-usage",
  //     "--single-process",
  //     "--no-zygote",
  //     "--disable-accelerated-2d-canvas",
  //     "--disable-web-security",
  //   ],
  //   protocolTimeout: 120000,
  // });

  // const launchTime = Date.now() - launchStart;
  // logger.info("BROWSER_LAUNCH", "Browser launched successfully", {
  //   launchTimeMs: launchTime,
  // });

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
  });

  try {
    const page = await browser.newPage();

    await page.setDefaultNavigationTimeout(60000);

    const searchUrl = `https://www.google.com/maps/search/${keyword}+in+${formattedCity}${formattedState}`;
    await job.progress({ processed: 0, total: 0 });

    // Step 7: Navigate to search URL
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 120000 });
    await autoScroll(page);

    // Step 9: Extract listing URLs
    const listingUrls = await safeEvaluate(page, () => {
      return Array.from(document.querySelectorAll(".Nv2PK"))
        .map((listing) => {
          const anchor = listing.querySelector("a.hfpxzc");
          return anchor ? anchor.href : null;
        })
        .filter(Boolean);
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
    // const BATCH_SIZE = 1;
    // logger.info("BATCH_PROCESSING", "Starting batch processing", {
    //   totalListings: listingUrls.length,
    //   batchSize: BATCH_SIZE,
    // });
    // for (let i = 0; i < listingUrls.length; i += BATCH_SIZE) {
    //   const batch = listingUrls.slice(i, i + BATCH_SIZE);
    //   const batchResults = await Promise.all(
    //     batch.map(async (url, batchIndex) => {
    //       logger.info(
    //         "DETAIL_EXTRACTION",
    //         `Processing listing ${i + batchIndex + 1}/${listingUrls.length}`,
    //         { url }
    //       );
    //       const detailPage = await browser.newPage();
    //       try {
    //         await detailPage.goto(url, {
    //           waitUntil: "domcontentloaded",
    //           timeout: 20000,
    //         });
    //         const businessData = await extractBusinessDetails(
    //           detailPage,
    //           browser,
    //           keyword,
    //           `${city}, ${state}`
    //         );
    //         logger.info(
    //           "DETAIL_EXTRACTION",
    //           `Processing listing ${i + batchIndex + 1}/${listingUrls.length}`,
    //           { url }
    //         );
    //         return { url, ...businessData };
    //       } finally {
    //         await detailPage.close();
    //       }
    //     })
    //   );

    //   results.push(...batchResults.filter(Boolean));

    //   const processed = Math.min(i + BATCH_SIZE, listingUrls.length);
    //   await job.progress({
    //     processed,
    //     total: listingUrls.length,
    //   });
    //   logger.info("PROGRESS_UPDATE", "Progress updated", {
    //     processed,
    //     total: listingUrls.length,
    //   });
    // }

    // Step 2: Process listings in batches
    const BATCH_SIZE = 1;
    for (let i = 0; i < listingUrls.length; i += BATCH_SIZE) {
      const batch = listingUrls.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (url, batchIndex) => {
          let detailPage;
          try {
            detailPage = await browser.newPage();

            // Add timeout to the entire extraction process
            const result = await Promise.race([
              (async () => {
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
              })(),

              // 60 second timeout for entire listing processing
              new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(new Error("Listing processing timed out after 60s")),
                  60000
                )
              ),
            ]);

            return result;
          } catch (error) {
            return null; // Return null instead of throwing
          } finally {
            // Always close the page, even on error
            if (detailPage) {
              try {
                await detailPage.close();
              } catch (closeError) {
                logger.warn(
                  "DETAIL_EXTRACTION",
                  `Failed to close page for listing ${i + batchIndex + 1}`,
                  {
                    error: closeError.message,
                  }
                );
              }
            }
          }
        })
      );

      const successfulExtractions = batchResults.filter(Boolean);
      results.push(...successfulExtractions);

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
    // Step 1: Extract business data with timeout
    businessData = await Promise.race([
      page.evaluate(
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
          };
        },
        searchTerm,
        searchLocation
      ),

      // 15 second timeout for page evaluation
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Business data extraction timed out")),
          15000
        )
      ),
    ]);

    // Step 2: Extract email if website exists (with timeout)
    if (businessData.website) {
      let emailPage;
      try {
        emailPage = await browser.newPage();
        await emailPage.setDefaultNavigationTimeout(10000);

        const emailResult = await Promise.race([
          (async () => {
            await emailPage.goto(businessData.website, {
              waitUntil: "domcontentloaded",
              timeout: 10000,
            });

            const email = await emailPage.evaluate(() => {
              const emailRegex =
                /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
              return document.body.textContent.match(emailRegex)?.[0] || null;
            });

            return email;
          })(),

          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Email extraction timed out")),
              10000
            )
          ),
        ]);

        businessData.email = emailResult;
      } catch (error) {
        businessData.email = null;
      } finally {
        // Always close email page
        if (emailPage) {
          try {
            await emailPage.close();
          } catch (closeError) {}
        }
      }
    } else {
      businessData.email = null;
    }
  } catch (error) {
    logger.error("BUSINESS_DETAILS", "Error extracting business details", {
      error: error.message,
    });
    return null;
  }

  return businessData;
}

// async function extractBusinessDetails(
//   page,
//   browser,
//   searchTerm,
//   searchLocation
// ) {
//   let businessData;

//   try {
//     businessData = await page.evaluate(
//       (searchTerm, searchLocation) => {
//         const getText = (selector) =>
//           document.querySelector(selector)?.textContent?.trim() || null;

//         const getHref = (selector) =>
//           document.querySelector(selector)?.href || null;

//         // Extract coordinates from URL parameters
//         const urlParams = new URLSearchParams(window.location.search);
//         const coords = urlParams.get("!3d")?.split("!4d") || [];

//         // Extract categories
//         const categories = Array.from(
//           document.querySelectorAll('[class*="DkEaL"]')
//         )
//           .map((el) => el.textContent.trim())
//           .filter(Boolean);

//         // Extract rating details
//         const ratingElement = document.querySelector('.ceNzKf[role="img"]');
//         const ratingText = ratingElement?.getAttribute("aria-label") || "";
//         const phoneElement = document.querySelector(
//           'a[aria-label="Call phone number"]'
//         );
//         const phoneNumber = phoneElement
//           ? phoneElement.href.replace("tel:", "")
//           : null;

//         const addressButton = document.querySelector(
//           'button[aria-label^="Address:"]'
//         );
//         const address = addressButton
//           ? addressButton
//               .getAttribute("aria-label")
//               .replace("Address: ", "")
//               .trim()
//           : null;

//         return {
//           name: getText(".DUwDvf.lfPIob"),
//           phone: phoneNumber,
//           website: getHref('[aria-label*="Website"]'),
//           address: address,
//           latitude: coords[0] || null,
//           longitude: coords[1] || null,
//           rating: ratingText.replace(/\D+$/g, "") || null,
//           rating_count:
//             getText('[aria-label*="reviews"]')?.match(/\d+/)?.[0] || "0",
//           category: categories.join(", "),
//           search_term: searchTerm,
//           search_type: "Google Maps",
//           search_location: searchLocation,
//           // opening_hours: Array.from(document.querySelectorAll(".eK4R0e tr"))
//           //   .map((row) => ({
//           //     day: row.querySelector(".ylH6lf")?.textContent.trim(),
//           //     hours: row.querySelector(".mxowUb")?.textContent.trim(),
//           //   }))
//           //   .filter((x) => x.day && x.hours),
//         };
//       },
//       searchTerm,
//       searchLocation
//     );

//     // Add email if website exists
//     if (businessData.website) {
//       const emailPage = await browser.newPage();
//       try {
//         await emailPage.goto(businessData.website, {
//           waitUntil: "domcontentloaded",
//           timeout: 15000,
//         });

//         businessData.email = await emailPage.evaluate(() => {
//           const emailRegex =
//             /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
//           return document.body.textContent.match(emailRegex)?.[0] || null;
//         });
//       } catch (error) {
//         console.error(
//           `Failed to extract email from ${businessData.website}: ${error.message}`
//         );
//       } finally {
//         await emailPage.close();
//       }
//     }
//   } catch (error) {
//     console.error(`Error extracting details: ${error.message}`);
//     return null;
//   }

//   return businessData;
// }

// async function autoScroll(page) {
//   await page.evaluate(async () => {
//     const wrapper = document.querySelector('div[role="feed"]');

//     await new Promise((resolve) => {
//       let totalHeight = 0;
//       const distance = 500;
//       const scrollDelay = 1000;

//       const timer = setInterval(async () => {
//         const scrollHeightBefore = wrapper.scrollHeight;
//         wrapper.scrollBy(0, distance);
//         totalHeight += distance;

//         if (totalHeight >= scrollHeightBefore) {
//           totalHeight = 0;
//           await new Promise((r) => setTimeout(r, scrollDelay));

//           const scrollHeightAfter = wrapper.scrollHeight;
//           if (scrollHeightAfter <= scrollHeightBefore) {
//             clearInterval(timer);
//             resolve();
//           }
//         }
//       }, 200);
//     });
//   });
// }
