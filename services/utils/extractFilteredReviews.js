import logger from "../logger.js";

export async function extractFilteredReviews(page, reviewTimeRange = null) {
  if (reviewTimeRange == null) {
    return []; // No review filtering requested
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

    // Scroll through review sections to load content
    await autoScrollReviews(page);

    // Check once more before evaluation
    if (page.isClosed()) {
      logger.error("EXTRACT_REVIEWS", "Page closed during scroll");
      return [];
    }

    const reviews = await page.evaluate((timeRangeYears) => {
      const reviewElements = Array.from(
        document.querySelectorAll("[data-review-id]")
      );
      const filteredReviews = [];
      const currentDate = new Date();
      const cutoffDate = new Date();
      cutoffDate.setFullYear(currentDate.getFullYear() - timeRangeYears);

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

      reviewElements.forEach((reviewEl) => {
        // Get date element using more specific selector
        const dateElement = reviewEl.querySelector(".rsqaWe");
        if (!dateElement) return;

        const dateText = dateElement.textContent.trim();
        const reviewDate = parseRelativeDate(dateText);

        if (reviewDate >= cutoffDate) {
          // Get review text - handles multi-line structure
          const textElement = reviewEl.querySelector(".wiI7pd");
          const reviewText = textElement?.textContent?.trim() || "";

          // Get rating from aria-label
          const ratingEl = reviewEl.querySelector('[role="img"][aria-label]');
          const ratingMatch = ratingEl
            ?.getAttribute("aria-label")
            ?.match(/\d+/);
          const rating = ratingMatch ? parseInt(ratingMatch[0]) : null;

          filteredReviews.push({
            text: reviewText,
            rating,
            date: reviewDate.toISOString(),
            relative_date: dateText,
          });
        }
      });

      return filteredReviews;
    }, reviewTimeRange);

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
