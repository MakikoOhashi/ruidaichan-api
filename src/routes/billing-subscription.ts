import { Router } from "express";
import { z } from "zod";
import { syncSubscriptionPlan, validateInstallId } from "../lib/free-quota.js";

const requestSchema = z.object({
  product_id: z.string().min(1),
  expires_at: z.string().min(1)
});

export const billingSubscriptionRouter = Router();

billingSubscriptionRouter.post("/", async (req, res) => {
  const installIdRaw = String(req.header("x-install-id") ?? "").trim();
  if (!validateInstallId(installIdRaw)) {
    return res.status(400).json({ error: "invalid_install_id" });
  }

  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const result = await syncSubscriptionPlan({
    installId: installIdRaw,
    productId: parsed.data.product_id,
    expiresAt: parsed.data.expires_at
  });

  if (!result.ok) {
    if (result.error === "unsupported_product_id" || result.error === "invalid_expires_at") {
      return res.status(400).json({ error: result.error });
    }
    return res.status(503).json({ error: "subscription_sync_failed", reason: result.error });
  }

  return res.json({
    ok: true,
    plan_id: result.plan_id,
    product_id: result.product_id,
    expires_at: result.expires_at
  });
});
