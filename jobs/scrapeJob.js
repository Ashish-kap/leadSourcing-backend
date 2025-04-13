
import { runScraper } from "../services/scraper.service.js";

export default async function(job) {
  try {
    // Initialize progress with object format
    await job.progress({ processed: 0, total: 0 });
    
    const result = await runScraper(job.data, job);
    return result;
  } catch (error) {
    // Update progress with error
    const currentProgress = job.progress() || { processed: 0, total: 0 };
    await job.progress({
      ...currentProgress,
      error: error.message
    });
    throw error;
  }
}