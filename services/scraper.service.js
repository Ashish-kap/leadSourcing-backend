import puppeteer from "puppeteer";
import { mkdirSync, existsSync } from "fs";

// export async function runScraper({ keyword, city, state }) {
//   const results = [];
//   const formattedCity = city.replace(/ /g, "+");
//   const formattedState = state ? `+${state.replace(/ /g, "+")}` : "";

//   const browser = await puppeteer.launch({
//     headless: "new",
//     args: ["--no-sandbox"],
//   });

//   try {
//     const page = await browser.newPage();
//     const searchUrl = `https://www.google.com/maps/search/${keyword}+in+${formattedCity}${formattedState}`;
//     console.log(`Scraping URL: ${searchUrl}`);

//     // Step 1: Get listing URLs
//     await page.goto(searchUrl, {
//       waitUntil: "networkidle2",
//       timeout: 60000,
//     });
//     await autoScroll(page);

//     const listingUrls = await page.evaluate(() => {
//       return Array.from(document.querySelectorAll(".Nv2PK"))
//         .map((listing) => {
//           const anchor = listing.querySelector("a.hfpxzc");
//           return anchor ? anchor.href : null;
//         })
//         .filter(Boolean);
//     });

//     console.log(`Found ${listingUrls.length} listings`);

//     // Step 2: Process listings in batches
//     const BATCH_SIZE = 3;
//     for (let i = 0; i < listingUrls.length; i += BATCH_SIZE) {
//       const batch = listingUrls.slice(i, i + BATCH_SIZE);
//       const batchResults = await Promise.all(
//         batch.map(async (url, index) => {
//           const detailPage = await browser.newPage();
//           try {
//             await detailPage.goto(url, {
//               waitUntil: "domcontentloaded",
//               timeout: 30000,
//             });
//             const businessData = await extractBusinessDetails(
//               detailPage,
//               browser,
//               keyword,
//               `${city}, ${state}`
//             );
//             return { url, ...businessData };
//           } catch (error) {
//             console.error(`Error processing ${url}:`, error.message);
//             return null;
//           } finally {
//             await detailPage.close();
//           }
//         })
//       );
//       results.push(...batchResults.filter(Boolean));
//       console.log(
//         `Processed ${Math.min(i + BATCH_SIZE, listingUrls.length)}/${
//           listingUrls.length
//         } listings`
//       );
//     }

//     // Step 3: Generate CSV
//     await generateCSV(results, keyword, city, state);
//     return results;
//   } catch (error) {
//     console.error("Scraping failed:", error);
//     throw error;
//   } finally {
//     await browser.close();
//   }
// }

// services/scraper.service.js (updated)
export async function runScraper({ keyword, city, state }, job) {
  const results = [];
  const formattedCity = city.replace(/ /g, "+");
  const formattedState = state ? `+${state.replace(/ /g, "+")}` : "";

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    const searchUrl = `https://www.google.com/maps/search/${keyword}+in+${formattedCity}${formattedState}`;

    // Initial progress update
    await job.progress({ processed: 0, total: 0 });

    // Step 1: Get listing URLs
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await autoScroll(page);

    const listingUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".Nv2PK"))
        .map((listing) => {
          const anchor = listing.querySelector("a.hfpxzc");
          return anchor ? anchor.href : null;
        })
        .filter(Boolean);
    });

    // Update progress with total listings
    await job.progress({ processed: 0, total: listingUrls.length });

    // Step 2: Process listings in batches
    const BATCH_SIZE = 3;
    for (let i = 0; i < listingUrls.length; i += BATCH_SIZE) {
      const batch = listingUrls.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (url) => {
          const detailPage = await browser.newPage();
          try {
            await detailPage.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
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

function createResultsDirectory() {
  const dirPath = "./results";
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const wrapper = document.querySelector('div[role="feed"]');

    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 1000;
      const scrollDelay = 3000;

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

// async function generateCSV(data, keyword, city, state) {
//   createResultsDirectory();

//   const filename = `${keyword}_${city}_${state}`
//     .replace(/ /g, "_")
//     .replace(/[^a-z0-9_]/gi, "");

//   const csvWriter = createObjectCsvWriter({
//     path: `./results/${filename + "-" + Date.now()}.csv`,
//     header: [
//       { id: "url", title: "URL" },
//       { id: "name", title: "NAME" },
//       { id: "phone", title: "PHONE" },
//       { id: "website", title: "WEBSITE" },
//       { id: "email", title: "EMAIL" },
//       { id: "address", title: "ADDRESS" },
//       { id: "latitude", title: "LATITUDE" },
//       { id: "longitude", title: "LONGITUDE" },
//       { id: "rating", title: "RATING" },
//       { id: "rating_count", title: "RATING_COUNT" },
//       { id: "category", title: "CATEGORY" },
//       { id: "search_term", title: "SEARCH_TERM" },
//       { id: "search_type", title: "SEARCH_TYPE" },
//       { id: "search_location", title: "SEARCH_LOCATION" },
//     ],
//   });

//   try {
//     await csvWriter.writeRecords(data);
//     console.log(`Successfully generated CSV with ${data.length} records`);
//   } catch (error) {
//     console.error("CSV write error:", error);
//     throw error;
//   }
// }
