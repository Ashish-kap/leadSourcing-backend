import scraperQueue from "../../services/queue.js";

const scrapeData = async (req, res) => {
  try {
    const job = await scraperQueue.add({
      keyword: req.body.keyword,
      city: req.body.city,
      state: req.body.state,
    });

    res.json({
      jobId: job.id,
      statusUrl: `/jobs/${job.id}`,
    });
  } catch (error) {
    console.error("Error fetching job:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getData = async (req, res) => {
  try {
    const job = await scraperQueue.getJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const progress = job.progress() || { processed: 0, total: 0 };

    res.json({
      id: job.id,
      status: await job.getState(),
      progress: {
        current: progress.processed,
        total: progress.total,
        percentage:
          progress.total > 0
            ? Math.round((progress.processed / progress.total) * 100)
            : 0,
      },
      result: job.returnvalue,
    });
  } catch (error) {
    console.error("Error fetching job:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export default { scrapeData, getData };
