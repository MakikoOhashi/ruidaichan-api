import { Router } from "express";

export const extractRouter = Router();

extractRouter.post("/", (_req, res) => {
  // ダミー（Phase2の形を固定する）
  res.json({
    template_id: "nencho_count_multi_v1",
    subquestion_count: 3,
    items_hint: [
      { category: "fruit", object_hint: "apple", count_range: [3, 10] },
      { category: "stationery", object_hint: "ruler", count_range: [3, 10] }
    ],
    confidence: 0.8
  });
});
