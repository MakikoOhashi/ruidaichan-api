import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { extractRouter } from "./routes/extract.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiKey = process.env.API_KEY;

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
    );
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const extractLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" }
});

app.use("/extract", extractLimiter, (req, res, next) => {
  if (!apiKey) {
    return res.status(500).json({ error: "server_misconfigured" });
  }

  if (req.header("x-api-key") !== apiKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  return next();
});

app.use("/extract", extractRouter);

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`ruidaichan-api listening on :${port}`);
});
