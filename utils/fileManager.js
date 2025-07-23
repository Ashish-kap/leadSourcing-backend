// utils/fileManager.js
import fs from "fs";
import path from "path";
import { promisify } from "util";
import cron from "node-schedule";

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);

const RETENTION_HOURS = process.env.FILE_RETENTION_HOURS || 24;
const CLEANUP_SCHEDULE = process.env.CLEANUP_SCHEDULE || "0 3 * * *"; // Daily at 3 AM


export class FileManager {
  constructor() {
    this.resultsDir = path.join(process.cwd(), "results");
    this.initCleanup();
  }

  async generateFilename(jobId, keyword, location) {
    const timestamp = Date.now();
    return `${jobId}_${keyword}_${location}_${timestamp}.csv`
      .replace(/ /g, "_")
      .replace(/[^a-z0-9_\-.]/gi, "");
  }

  async cleanOldFiles() {
    try {
      const files = await readdir(this.resultsDir);
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(this.resultsDir, file);
        const stats = await stat(filePath);
        const ageHours = (now - stats.mtimeMs) / (1000 * 60 * 60);

        if (ageHours > RETENTION_HOURS) {
          await unlink(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      }
    } catch (error) {
      console.error("File cleanup error:", error);
    }
  }

  initCleanup() {
    if (process.env.ENABLE_CLEANUP !== "false") {
      cron.scheduleJob(CLEANUP_SCHEDULE, () => this.cleanOldFiles());
    }
  }
}

export const fileManager = new FileManager();
