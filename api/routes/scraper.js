// import express from "express";
// import scraperQueue from "../../services/queue.js";

// const router = express.Router();

// router.post("/scrape", async (req, res) => {
//   const job = await scraperQueue.add({
//     keyword: req.body.keyword,
//     city: req.body.city,
//     state: req.body.state,
//   });

//   res.json({
//     jobId: job.id,
//     statusUrl: `/jobs/${job.id}`,
//   });
// });

// router.get("/jobs/:id", async (req, res) => {
//   try {
//     const job = await scraperQueue.getJob(req.params.id);

//     if (!job) {
//       return res.status(404).json({ error: "Job not found" });
//     }

//     const progress = job.progress() || { processed: 0, total: 0 };

//     res.json({
//       id: job.id,
//       status: await job.getState(),
//       progress: {
//         current: progress.processed,
//         total: progress.total,
//         percentage:
//           progress.total > 0
//             ? Math.round((progress.processed / progress.total) * 100)
//             : 0,
//       },
//       result: job.returnvalue,
//     });
//   } catch (error) {
//     console.error("Error fetching job:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// export default router;

import express from "express";
import scrapController from "../controllers/scrape.js";
const router = express.Router();

router.post("/scrape", scrapController.scrapeData);
router.get("/jobs/:id", scrapController.getData);

export default router; 
