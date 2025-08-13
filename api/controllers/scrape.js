import scraperQueue from "../../services/queue.js";

const scrapeData = async (req, res) => {
  try {
    const {
      keyword,
      city = null,
      countryCode,
      stateCode = null,
      maxRecords = 50,
      minRating = 0,
      reviewsWithinLastYears = 0,
    } = req.body;

    // Validate mandatory fields
    if (!keyword) {
      return res.status(400).json({
        error: "keyword is required",
      });
    }

    if (!countryCode) {
      return res.status(400).json({
        error: "countryCode is required",
      });
    }

    // Validate numeric parameters
    if (
      maxRecords &&
      (isNaN(maxRecords) || maxRecords < 1 || maxRecords > 1000)
    ) {
      return res.status(400).json({
        error: "maxRecords must be a number between 1 and 1000",
      });
    }

    if (minRating && (isNaN(minRating) || minRating < 0 || minRating > 5)) {
      return res.status(400).json({
        error: "minRating must be a number between 0 and 5",
      });
    }

    if (
      reviewsWithinLastYears &&
      (isNaN(reviewsWithinLastYears) ||
        reviewsWithinLastYears < 0 ||
        reviewsWithinLastYears > 10)
    ) {
      return res.status(400).json({
        error: "reviewsWithinLastYears must be a number between 0 and 10",
      });
    }

    // Create job with all parameters
    const job = await scraperQueue.add({
      keyword: keyword.trim(),
      city: city ? city.trim() : null,
      stateCode: stateCode ? stateCode.trim() : null,
      countryCode: countryCode.trim().toUpperCase(), // Standardize country code
      maxRecords: parseInt(maxRecords),
      minRating: parseFloat(minRating),
      reviewsWithinLastYears: parseInt(reviewsWithinLastYears),
    });

    res.json({
      jobId: job.id,
      statusUrl: `/jobs/${job.id}`,
      message: "Scraping job queued successfully",
      jobParams: {
        keyword,
        city,
        stateCode,
        countryCode,
        maxRecords: parseInt(maxRecords),
        minRating: parseFloat(minRating),
        reviewsWithinLastYears: parseInt(reviewsWithinLastYears),
        // estimatedLocations: getEstimatedLocations(city, state, country),
      },
    });
  } catch (error) {
    console.error("Error creating scraping job:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
};

// const getData = async (req, res) => {
//   try {
//     const job = await scraperQueue.getJob(req.params.id);

//     if (!job) {
//       return res.status(404).json({ error: "Job not found" });
//     }

//     // const progress = job.progress() || { processed: 0, total: 0 };
//     const progress = job.progress();
//     let percentage = 0;
//     let details = {};

//     // Handle both number and object progress formats
//     if (typeof progress === "number") {
//       percentage = progress;
//     } else if (typeof progress === "object") {
//       percentage = progress.percentage || 0;
//       details = progress;
//     }

//     res.json({
//       id: job.id,
//       status: await job.getState(),
//       progress: {
//         percentage,
//         details,
//       },
//       result: job.returnvalue,
//     });

//     // res.json({
//     //   id: job.id,
//     //   status: await job.getState(),
//     //   progress: {
//     //     current: progress.processed,
//     //     total: progress.total,
//     //     percentage:
//     //       progress.total > 0
//     //         ? Math.round((progress.processed / progress.total) * 100)
//     //         : 0,
//     //   },
//     //   result: job.returnvalue,
//     // });
//   } catch (error) {
//     console.error("Error fetching job:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

const getData = async (req, res) => {
  try {
    const job = await scraperQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const progress = job.progress();
    let percentage = 0;
    let details = {};

    console.log("progr",progress)

    // Handle both number and object progress
    if (typeof progress === "number") {
      percentage = progress;
    } else if (typeof progress === "object") {
      percentage = progress.percentage || 0;
      details = progress;
    }

    res.json({
      id: job.id,
      status: await job.getState(),
      progress: {
        percentage,
        details,
      },
      result: job.returnvalue,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
};

export default { scrapeData, getData };
