import dotenv from "dotenv";
dotenv.config();
import { verifyEmail } from "./utils/emailVerifier.js";

function getCoordsFromUrl(u) {
  // matches ...!3d24.379259!4d91.4136279...
  const m = u.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  return m
    ? { latitude: parseFloat(m[1]), longitude: parseFloat(m[3]) }
    : { latitude: null, longitude: null };
}

export async function extractBusinessDetails(
  page,
  browser,
  searchTerm,
  searchLocation,
  ratingFilter = null,
  reviewFilter = null,
  isExtractEmail = false
) {
  // --- NEW: wait for the header & rating cluster to render (don’t hard-fail if rating is missing) ---
  try {
    await page.waitForSelector("h1.DUwDvf.lfPIob", {
      visible: true,
      timeout: 7000,
    });
  } catch (_) {} // some places have slow paint; we’ll still attempt evaluate

  try {
    await page.waitForSelector('.F7nice .ceNzKf[role="img"]', {
      visible: true,
      timeout: 7000,
    });
  } catch (_) {}

  // --- NEW: parse coords from page.url() (reliable) ---
  const { latitude, longitude } = getCoordsFromUrl(page.url());

  let businessData;
  try {
    businessData = await Promise.race([
      page.evaluate(
        (searchTerm, searchLocation, ratingFilter, reviewFilter) => {
          const qs = (sel) => document.querySelector(sel);
          const txt = (el) => el?.textContent?.trim() || null;

          // Name (place header)
          const name = txt(qs("h1.DUwDvf.lfPIob"));

          // Category: specifically the category button near the title
          const category = txt(qs('button[jsaction="pane.wfvdle18.category"]'));

          // Rating value from aria-label of the stars beside the rating
          const ratingEl = qs('.F7nice .ceNzKf[role="img"]');
          const ratingLabel = ratingEl?.getAttribute("aria-label") || "";
          const ratingMatch = ratingLabel.match(/(\d+(?:\.\d+)?)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          // Review count (the little “(123)” with aria-label “123 reviews” or “1 review”)
          const reviewBadge = qs(
            '.F7nice [aria-label$="reviews"], .F7nice [aria-label$="review"]'
          );
          const reviewCountLabel =
            reviewBadge?.getAttribute("aria-label") || "";
          const reviewCountMatch = reviewCountLabel.match(/(\d+)\s+reviews?$/i);
          const reviewCount = reviewCountMatch
            ? parseInt(reviewCountMatch[1], 10)
            : 0;

          // Optional filters (applied on parsed values)
          if (ratingFilter && typeof rating === "number") {
            const { operator, value } = ratingFilter;
            const bad =
              (operator === "gt" && !(rating > value)) ||
              (operator === "gte" && !(rating >= value)) ||
              (operator === "lt" && !(rating < value)) ||
              (operator === "lte" && !(rating <= value));
            if (bad) return null;
          }
          if (reviewFilter) {
            const { operator, value } = reviewFilter;
            const c = reviewCount;
            const bad =
              (operator === "gt" && !(c > value)) ||
              (operator === "gte" && !(c >= value)) ||
              (operator === "lt" && !(c < value)) ||
              (operator === "lte" && !(c <= value));
            if (bad) return null;
          }

          // Phone (works)
          const phoneHref = qs(
            'a[aria-label="Call phone number"]'
          )?.getAttribute("href");
          const phone = phoneHref ? phoneHref.replace("tel:", "") : null;

          // Address (works)
          const addressBtn = qs('button[aria-label^="Address:"]');
          const address = addressBtn
            ? addressBtn
                .getAttribute("aria-label")
                .replace(/^Address:\s*/, "")
                .trim()
            : null;

          // Website: sometimes anchor, sometimes button
          let website =
            qs('a[aria-label="Website"]')?.getAttribute("href") || null;
          if (!website) {
            const websiteBtn = qs('button[aria-label="Website"]');
            website = websiteBtn?.getAttribute("data-href") || null;
          }

          return {
            name,
            phone,
            website,
            address,
            // coords set outside (more reliable), we’ll fill them after evaluate
            latitude: null,
            longitude: null,
            rating: typeof rating === "number" ? rating : null,
            rating_count: String(reviewCount),
            category: category || null,
            search_term: searchTerm,
            search_type: "Google Maps",
            search_location: searchLocation,
            email: null,
          };
        },
        searchTerm,
        searchLocation,
        ratingFilter,
        reviewFilter
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Business data extraction timed out")),
          10000
        )
      ),
    ]);

    if (!businessData) return null;

    // inject reliable coords parsed from the URL
    businessData.latitude = latitude;
    businessData.longitude = longitude;

    // --- Email extraction (unchanged, just guarded) ---
    if (
      isExtractEmail &&
      businessData.website &&
      !businessData.website.startsWith("javascript:")
    ) {
      let emailPage;
      try {
        emailPage = await newPageWithRetry(browser, 2);
        const emailResult = await Promise.race([
          (async () => {
            if (businessData.website.startsWith("mailto:")) {
              return businessData.website.replace("mailto:", "");
            }
            await emailPage.goto(businessData.website, {
              waitUntil: "domcontentloaded",
              timeout: 7000,
            });
            const email = await emailPage.evaluate(() => {
              const re = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
              return document.body.textContent.match(re)?.[0] || null;
            });
            return email;
          })(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Email extraction timed out")),
              7000
            )
          ),
        ]);

        if (emailResult) {
          try {
            const verificationResult = await verifyEmail(emailResult, {
              heloHost: process.env.HELO_HOST,
              mailFrom: process.env.MAIL_FROM,
              connectionTimeoutMs: 5000,
              commandTimeoutMs: 5000,
            });
            businessData.email =
              verificationResult.result === "deliverable" ? emailResult : null;
          } catch (_) {
            businessData.email = null;
          }
        } else {
          businessData.email = null;
        }
      } catch (_) {
        businessData.email = null;
      } finally {
        try {
          await emailPage?.close();
        } catch {}
      }
    } else {
      businessData.email = null;
    }
  } catch (_) {
    return null;
  }

  return businessData;
}
