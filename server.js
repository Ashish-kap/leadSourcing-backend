import express from "express";
import cors from "cors";
import scraperRouter from "./api/routes/scraper.js";
import { createBullBoard } from "@bull-board/api";
import { BullAdapter } from "@bull-board/api/bullAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import scraperQueue from "./services/queue.js";
import path from "path";
import { fileURLToPath } from 'url'; // Add this import
import { dirname } from 'path';   


// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Bull Dashboard
const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [new BullAdapter(scraperQueue)],
  serverAdapter,
});

// app.use("/", (req, res) => {
//   res.status(200).json("success");
// });

serverAdapter.setBasePath("/admin");
app.use("/admin", serverAdapter.getRouter());

// Routes
app.use("/api", scraperRouter);

app.use("/", (req,res)=>{
  res.status(200).json({message:"Success"})
});


// // // // Static files for frontend
// app.use(express.static(path.join(__dirname, "dist")));
// app.get("*", (req, res) => {
//   res.sendFile(path.join(__dirname, "dist", "index.html"));
// });


// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/admin`);
});
