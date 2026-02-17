import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  process.env.API_KEY = "test-key";

  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("micro generate is deterministic with same input+seed", async () => {
  await withServer(async (baseUrl) => {
    const payload = {
      text: "4 + □ = 10",
      N: 5,
      difficulty: "same",
      seed: "abc-123"
    };

    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify(payload)
      }),
      fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify(payload)
      })
    ]);

    const b1 = (await r1.json()) as { problems: Array<{ render_text: string }> };
    const b2 = (await r2.json()) as { problems: Array<{ render_text: string }> };

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(
      b1.problems.map((p) => p.render_text),
      b2.problems.map((p) => p.render_text)
    );
  });
});

test("micro detect parses known family and returns confidence", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "□ + 3 = 9", N: 4, difficulty: "easy", seed: 10 })
    });

    const body = (await res.json()) as {
      schema_version: string;
      detected: { family: string; confidence: number };
      need_confirm: boolean;
      request_id: string;
    };

    assert.equal(res.status, 200);
    assert.equal(body.schema_version, "micro_generate_response_v1");
    assert.equal(body.detected.family, "blank_plus_a_eq_b");
    assert.equal(body.detected.confidence > 0.75, true);
    assert.equal(body.need_confirm, false);
    assert.equal(typeof body.request_id, "string");
  });
});

test("low confidence returns need_confirm with choices", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "これは算数の文です", N: 4, difficulty: "easy", seed: "s" })
    });

    const body = (await res.json()) as {
      detected: { family: string; confidence: number };
      need_confirm: boolean;
      confirm_choices?: string[];
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected.family, "unknown");
    assert.equal(body.detected.confidence < 0.75, true);
    assert.equal(body.need_confirm, true);
    assert.equal(Array.isArray(body.confirm_choices), true);
    assert.equal((body.confirm_choices ?? []).length >= 2, true);
  });
});

test("compare_totals_diff_mc detection has priority and no confirm", async () => {
  await withServer(async (baseUrl) => {
    const text =
      "あかは18こ、きいろは23こです。Aさんはあかを27こ、Bさんはきいろを12こふやしました。どちらが何こ多いですか。あわせて考えましょう。";
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text, N: 4, difficulty: "same", seed: "cmp-seed" })
    });

    const body = (await res.json()) as {
      detected: { family: string; confidence: number };
      need_confirm: boolean;
      problems: Array<{ family: string; render_text: string }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected.family, "compare_totals_diff_mc");
    assert.equal(body.detected.confidence >= 0.75, true);
    assert.equal(body.need_confirm, false);
    assert.equal(body.problems.every((p) => p.family === "compare_totals_diff_mc"), true);
    assert.equal(body.problems.every((p) => p.render_text.includes("どちらが")), true);
  });
});

test("compare_totals_diff_mc deterministic with same seed", async () => {
  await withServer(async (baseUrl) => {
    const payload = {
      text: "あかは10こ、きいろは7こ。あか5こ、きいろ2こふえました。どちらが何こ多い？あわせる。",
      N: 5,
      difficulty: "same",
      seed: "same-seed-compare"
    };

    const r1 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify(payload)
    });
    const r2 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify(payload)
    });

    const b1 = (await r1.json()) as { problems: Array<{ render_text: string }> };
    const b2 = (await r2.json()) as { problems: Array<{ render_text: string }> };
    assert.deepEqual(
      b1.problems.map((p) => p.render_text),
      b2.problems.map((p) => p.render_text)
    );
  });
});

test("compare_totals_diff_mc validator keeps blank consistent", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "あかは8こ、きいろは4こ。あか3こ、きいろ6こふえた。どちらが何こ多い？あわせる。",
        N: 4,
        difficulty: "easy",
        seed: "validator-compare"
      })
    });

    const body = (await res.json()) as {
      problems: Array<{ family: string; params: Record<string, number>; answer: number }>;
    };

    assert.equal(res.status, 200);
    for (const p of body.problems) {
      if (p.family !== "compare_totals_diff_mc") continue;
      const computed = Math.abs((p.params.a + p.params.c) - (p.params.b + p.params.d));
      assert.equal(p.params.blank, computed);
      assert.equal(p.answer, computed);
    }
  });
});
