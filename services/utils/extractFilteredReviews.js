import logger from "../logger.js";

// Backward-compatible API: second arg may be a number (years) or an options object
// Options shape: { reviewTimeRange?: number|null, ratingFilter?: 'negative' | { allowedRatings: number[] } }
export async function extractFilteredReviews(
  page,
  reviewTimeRangeOrOptions = null
) {
  let reviewTimeRange = null;
  let ratingFilter = null;

  if (
    reviewTimeRangeOrOptions &&
    typeof reviewTimeRangeOrOptions === "object" &&
    !Number.isFinite(reviewTimeRangeOrOptions)
  ) {
    reviewTimeRange =
      reviewTimeRangeOrOptions.reviewTimeRange ?? null;
    ratingFilter = reviewTimeRangeOrOptions.ratingFilter ?? null;
  } else {
    reviewTimeRange = reviewTimeRangeOrOptions;
  }

  // If no filters requested at all, skip work like before
  if (reviewTimeRange == null && !ratingFilter) {
    return [];
  }

  try {
    // Check if page is closed before proceeding
    if (page.isClosed()) {
      logger.error("EXTRACT_REVIEWS", "Page is already closed");
      return [];
    }

    // Wait for reviews container to load with increased timeout
    await page
      .waitForSelector(".m6QErb.Pf6ghf", { timeout: 10000 })
      .catch(() => {
        logger.warn("EXTRACT_REVIEWS", "Reviews container not found");
        return null;
      });

    // Check again if page is still open after waiting
    if (page.isClosed()) {
      logger.error("EXTRACT_REVIEWS", "Page closed during wait");
      return [];
    }

    // If extracting negative reviews, sort by lowest rating first
    if (ratingFilter === "negative") {
      logger.info("EXTRACT_REVIEWS", "Sorting reviews by lowest rating for negative review extraction");
      await sortReviewsByLowestRating(page);
    }

    // Scroll through review sections to load content
    await autoScrollReviews(page);

    // Check once more before evaluation
    if (page.isClosed()) {
      logger.error("EXTRACT_REVIEWS", "Page closed during scroll");
      return [];
    }

    const reviews = await page.evaluate((timeRangeYears, ratingFilterArg) => {
      const reviewElements = Array.from(
        document.querySelectorAll("[data-review-id]")
      );
      const filteredReviews = [];
      const currentDate = new Date();
      const cutoffDate = new Date();
      if (Number.isFinite(timeRangeYears)) {
        cutoffDate.setFullYear(currentDate.getFullYear() - timeRangeYears);
      }

      // If filtering for negative reviews, first check if any negative reviews exist
      if (ratingFilterArg === "negative") {
        const hasNegativeReviews = reviewElements.some((reviewEl) => {
          const ratingEl = reviewEl.querySelector('[role="img"][aria-label]');
          const ratingMatch = ratingEl
            ?.getAttribute("aria-label")
            ?.match(/\d+/);
          const rating = ratingMatch ? parseInt(ratingMatch[0]) : null;
          return rating === 1 || rating === 2;
        });

        if (!hasNegativeReviews) {
          console.log("No negative reviews found, skipping extraction");
          return [];
        }
      }

      // Helper function to parse relative dates
      function parseRelativeDate(dateText) {
        const cleanText = dateText.replace("Edited", "").trim();
        const lowerText = cleanText.toLowerCase();
        const now = new Date();
        const date = new Date(now);

        if (/(\d+)\s*days?/.test(lowerText)) {
          const days = parseInt(lowerText.match(/(\d+)/)[0]);
          date.setDate(now.getDate() - days);
        } else if (/(\d+)\s*weeks?/.test(lowerText)) {
          const weeks = parseInt(lowerText.match(/(\d+)/)[0]);
          date.setDate(now.getDate() - weeks * 7);
        } else if (/(\d+)\s*months?/.test(lowerText)) {
          const months = parseInt(lowerText.match(/(\d+)/)[0]);
          date.setMonth(now.getMonth() - months);
        } else if (/(\d+)\s*years?/.test(lowerText)) {
          const years = parseInt(lowerText.match(/(\d+)/)[0]);
          date.setFullYear(now.getFullYear() - years);
        }
        return date;
      }

      // Track seen reviews to prevent duplicates
      const seenReviews = new Set();

      reviewElements.forEach((reviewEl) => {
        // Get date element using more specific selector
        const dateElement = reviewEl.querySelector(".rsqaWe");
        if (!dateElement) return;

        const dateText = dateElement.textContent.trim();
        const reviewDate = parseRelativeDate(dateText);

        const withinTimeRange =
          !Number.isFinite(timeRangeYears) || reviewDate >= cutoffDate;
        if (withinTimeRange) {
          // Get review text - handles multi-line structure
          const textElement = reviewEl.querySelector(".wiI7pd");
          const reviewText = textElement?.textContent?.trim() || "";

          // Get rating from aria-label
          const ratingEl = reviewEl.querySelector('[role="img"][aria-label]');
          const ratingMatch = ratingEl
            ?.getAttribute("aria-label")
            ?.match(/\d+/);
          const rating = ratingMatch ? parseInt(ratingMatch[0]) : null;

          // Rating filter logic
          let passesRatingFilter = true;
          if (ratingFilterArg) {
            if (ratingFilterArg === "negative") {
              passesRatingFilter = rating === 1 || rating === 2;
            } else if (
              typeof ratingFilterArg === "object" &&
              Array.isArray(ratingFilterArg.allowedRatings)
            ) {
              passesRatingFilter = ratingFilterArg.allowedRatings.includes(rating);
            }
          }
          if (!passesRatingFilter) return;

          // Extract reviewer name with robust fallbacks
          // 1) Many review containers expose the reviewer name on the root via aria-label
          // 2) Otherwise fall back to the visible name element within the header
          let reviewerName = reviewEl.getAttribute("aria-label") || "";
          if (!reviewerName) {
            const nameEl = reviewEl.querySelector(".d4r55.fontTitleMedium");
            reviewerName = nameEl?.textContent?.trim() || "";
          }
          // Sometimes Google shows generic text like "Review" — treat that as missing
          if (/^review$/i.test(reviewerName)) {
            reviewerName = "";
          }

          // Create a unique key for deduplication based on text, rating, and reviewer
          const reviewKey = `${reviewText}|${rating}|${reviewerName}`;
          
          // Skip if we've already seen this exact review
          if (seenReviews.has(reviewKey)) {
            return;
          }
          
          seenReviews.add(reviewKey);

          filteredReviews.push({
            text: reviewText,
            rating,
            date: reviewDate.toISOString(),
            relative_date: dateText,
            reviewerName,
          });
        }
      });

      return filteredReviews;
    }, reviewTimeRange, ratingFilter);

    return reviews;
  } catch (error) {
    // Handle specific puppeteer errors
    if (error.message && error.message.includes("detached Frame")) {
      logger.error(
        "EXTRACT_REVIEWS",
        "Frame detached - page likely navigated or closed"
      );
      return [];
    }
    if (error.message && error.message.includes("Target closed")) {
      logger.error("EXTRACT_REVIEWS", "Page was closed during operation");
      return [];
    }
    logger.error("EXTRACT_REVIEWS", "Error extracting filtered reviews", error);
    return [];
  }
}

// Helper function to scroll through reviews
async function autoScrollReviews(page) {
  try {
    // Check if page is closed before proceeding
    if (page.isClosed()) {
      return;
    }

    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const reviewSection = document.querySelector(".m6QErb.Pf6ghf");
        if (!reviewSection) return resolve();

        let lastHeight = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 20; // Prevent infinite loops

        const scrollInterval = setInterval(() => {
          reviewSection.scrollTop += 1000;
          scrollAttempts++;

          if (
            reviewSection.scrollTop === lastHeight ||
            scrollAttempts >= maxScrollAttempts
          ) {
            clearInterval(scrollInterval);
            resolve();
          }
          lastHeight = reviewSection.scrollTop;
        }, 500);
      });
    });
  } catch (error) {
    // Silently fail if frame is detached during scrolling
    if (
      error.message &&
      (error.message.includes("detached Frame") ||
        error.message.includes("Target closed"))
    ) {
      logger.info(
        "AUTO_SCROLL_REVIEWS",
        "Page closed during scroll, continuing..."
      );
      return;
    }
    logger.error("AUTO_SCROLL_REVIEWS", "Error during auto scroll", error);
  }
}

// Helper function to sort reviews by lowest rating
async function sortReviewsByLowestRating(page) {
  try {
    // Check if page is closed before proceeding
    if (page.isClosed()) {
      return;
    }

    await page.evaluate(async () => {
      // Wait for sort button to be available
      const sortButton = document.querySelector('button[aria-label="Sort reviews"]');
      if (!sortButton) {
        console.log("Sort button not found");
        return;
      }

      console.log("Clicking sort button to open dropdown");
      // Click the sort button
      sortButton.click();
      
      // Wait a bit for the dropdown to appear
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Look for the "Lowest rating" option in the dropdown
      // Based on the HTML structure, the "Lowest rating" option has data-index="3"
      const lowestRatingOption = document.querySelector('[data-index="3"]') || 
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(el => 
          el.textContent.includes("Lowest rating")
        );

      if (lowestRatingOption) {
        lowestRatingOption.click();
        console.log("Selected 'Lowest rating' sort option");
        
        // Wait for the page to update with sorted reviews
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log("Lowest rating option not found in sort menu, continuing with current order");
      }
    });
  } catch (error) {
    // Silently fail if frame is detached during sorting
    if (
      error.message &&
      (error.message.includes("detached Frame") ||
        error.message.includes("Target closed"))
    ) {
      logger.info(
        "SORT_REVIEWS",
        "Page closed during sort, continuing..."
      );
      return;
    }
    logger.error("SORT_REVIEWS", "Error during sort reviews", error);
  }
}
