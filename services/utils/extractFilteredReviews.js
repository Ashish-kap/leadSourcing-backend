export async function extractFilteredReviews(page, reviewTimeRange = null) {
  if (reviewTimeRange == null) {
    return []; // No review filtering requested
  }

  try {
    // Wait for reviews container to load
    await page.waitForSelector(".m6QErb.Pf6ghf", { timeout: 10000 });

    // Scroll through review sections to load content
    await autoScrollReviews(page);

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
    console.error("Error extracting filtered reviews:", error);
    return [];
  }
}

// Helper function to scroll through reviews
async function autoScrollReviews(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const reviewSection = document.querySelector(".m6QErb.Pf6ghf");
      if (!reviewSection) return resolve();

      let lastHeight = 0;
      const scrollInterval = setInterval(() => {
        reviewSection.scrollTop += 1000;

        if (reviewSection.scrollTop === lastHeight) {
          clearInterval(scrollInterval);
          resolve();
        }
        lastHeight = reviewSection.scrollTop;
      }, 500);
    });
  });
}
