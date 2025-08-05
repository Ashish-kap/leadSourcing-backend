import logger from "./logger.js";

async function autoScroll(page) {
  logger.info(
    "AUTO_SCROLL_START",
    "Starting auto scroll with safety mechanisms"
  );

  try {
    const scrollResult = await Promise.race([
      // Main scroll logic
      page.evaluate(async () => {
        const wrapper = document.querySelector('div[role="feed"]');

        if (!wrapper) {
          console.log("[AUTO_SCROLL] Feed wrapper not found");
          return { success: false, reason: "wrapper_not_found" };
        }

        console.log("[AUTO_SCROLL] Feed wrapper found, starting scroll");

        return new Promise((resolve) => {
          let totalHeight = 0;
          let scrollAttempts = 0;
          let lastHeight = wrapper.scrollHeight;
          let stagnantCount = 0;

          const distance = 300; // Smaller distance for Railway
          const scrollDelay = 800; // Shorter delay
          const maxScrollAttempts = 30; // Limit attempts
          const maxStagnantCount = 3; // Stop if height doesn't change

          const timer = setInterval(async () => {
            scrollAttempts++;
            console.log(
              `[AUTO_SCROLL] Attempt ${scrollAttempts}/${maxScrollAttempts}`
            );

            const scrollHeightBefore = wrapper.scrollHeight;
            wrapper.scrollBy(0, distance);
            totalHeight += distance;

            // Check if we've reached limits
            if (scrollAttempts >= maxScrollAttempts) {
              console.log("[AUTO_SCROLL] Max attempts reached");
              clearInterval(timer);
              resolve({
                success: true,
                reason: "max_attempts",
                scrollAttempts,
              });
              return;
            }

            if (totalHeight >= scrollHeightBefore) {
              totalHeight = 0;
              await new Promise((r) => setTimeout(r, scrollDelay));

              const scrollHeightAfter = wrapper.scrollHeight;

              // Check if content stopped loading
              if (scrollHeightAfter <= scrollHeightBefore) {
                stagnantCount++;
                console.log(
                  `[AUTO_SCROLL] Content stagnant: ${stagnantCount}/${maxStagnantCount}`
                );

                if (stagnantCount >= maxStagnantCount) {
                  console.log("[AUTO_SCROLL] Content stopped loading");
                  clearInterval(timer);
                  resolve({
                    success: true,
                    reason: "content_loaded",
                    scrollAttempts,
                  });
                }
              } else {
                stagnantCount = 0; // Reset if new content loaded
                lastHeight = scrollHeightAfter;
              }
            }
          }, 200);
        });
      }),

      // Timeout fallback (30 seconds max)
      new Promise((resolve) =>
        setTimeout(() => {
          logger.warn("AUTO_SCROLL_TIMEOUT", "Auto scroll timed out after 30s");
          resolve({ success: false, reason: "timeout" });
        }, 30000)
      ),
    ]);

    logger.info("AUTO_SCROLL_COMPLETE", "Auto scroll finished", scrollResult);
    return scrollResult;
  } catch (error) {
    logger.error("AUTO_SCROLL_ERROR", "Auto scroll failed", error);
    // Don't throw - continue with whatever listings are already visible
    return { success: false, reason: "error", error: error.message };
  }
}


export default autoScroll