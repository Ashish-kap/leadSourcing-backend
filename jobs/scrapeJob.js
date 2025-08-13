import { runScraper } from "../services/scraper3.service.js";

export default async function (job) {
  try {
    // Initialize progress with object format
    // await job.progress({ processed: 0, total: 0 });

    await job.progress(0);

    const result = await runScraper(job.data, job);
    return result;
  } catch (error) {
    // Update progress with error
    // const currentProgress = job.progress() || { processed: 0, total: 0 };
    // await job.progress({
    //   ...currentProgress,
    //   error: error.message
    // });
    // throw error;

    await job.progress(100, { error: error.message });
    throw error;
  }
}
