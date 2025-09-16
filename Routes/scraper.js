import express from "express";
import jobController from "./../api/controllers/jobController.js";
import scrapeController from "./../api/controllers/scrape.js";
import * as authController from "./../api/controllers/authController.js";

const router = express.Router();

// Protect all routes
router.use(authController.protect);

// Job management routes
router.get("/dashboard", jobController.getUserDashboard);
router.get("/jobs", jobController.getUserJobs);
router.get("/:jobId", jobController.getJobDetails);
router.delete("/delete/:jobId", jobController.deleteJob);
router.get("/:jobId/download", jobController.downloadJobResultCSV);

// Scraping routes
router.post("/scrape", scrapeController.scrapeData);
router.get("/status/:jobId", scrapeController.getJobStatus);
router.post("/kill/:jobId", jobController.killJob);

export default router;
