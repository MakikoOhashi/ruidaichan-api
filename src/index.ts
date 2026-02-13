import express from "express";
import { extractRouter } from "./routes/extract.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/extract", extractRouter);

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`ruidaichan-api listening on :${port}`);
});
