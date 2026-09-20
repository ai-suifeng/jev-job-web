import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildJevRequest, evaluateJev, screenResume, segmentResume } from "../src/screen.js";
import { createApp } from "../src/server.js";

const input = {
  job: {
    title: "Java 高级开发",
    requirements: [
      { id: "years", text: "至少 5 年 Java 后端经验" },
      { id: "delivery", text: "亲自参与已上线项目" },
      { id: "performance", text: "性能优化经验", required: false }
    ]
  },
  resume: {
    id: "candidate-1",
    text: "Java 后端开发 7 年，负责订单服务。\n本人主导支付项目开发，2023 年正式上线。\n没有性能优化经验。"
  }
};

function choice(label, probabilities = { [label]: 0.95 }) {
  return { type: "choice", choice: label, probabilities, confidence: 0.9 };
}

function response(statuses, evidenceIds) {
  const answers = {};
  statuses.forEach((status, index) => {
    answers[`status_${index}`] = choice(status);
    answers[`evidence_${index}`] = choice(evidenceIds[index]);
  });
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 20 } };
}

test("builds one independent status and evidence judgment per HR condition", () => {
  const request = buildJevRequest(input, "2026-09-20");
  assert.equal(request.model, "jev-latest");
  assert.equal(Object.keys(request.questions).length, 6);
  assert.match(request.questions.status_0.instructions.task, /至少 5 年 Java 后端经验/);
  assert.match(request.questions.status_0.instructions.task, /2026-09-20/);
  assert.deepEqual(Object.keys(request.questions.status_0.criteria), ["met", "unmet", "unknown"]);
  assert.ok(request.questions.evidence_0.criteria.none);
  assert.equal(request.state.resume_segments.length, 3);
});

test("selected evidence is an exact substring of the submitted resume", async () => {
  const result = await screenResume(input, {
    evaluate: async () => response(["met", "met", "unmet"], ["s1", "s2", "s3"])
  });
  assert.equal(result.recommendation, "match");
  assert.equal(result.requirements[2].status, "unmet");
  assert.match(result.requirements[1].evidence.text, /2023 年正式上线/);
  for (const item of result.requirements) {
    assert.equal(input.resume.text.slice(item.evidence.start, item.evidence.end), item.evidence.text);
  }
});

test("an explicitly unmet required condition yields not_match", async () => {
  const result = await screenResume(input, {
    evaluate: async () => response(["unmet", "met", "unknown"], ["s1", "s1", "none"])
  });
  assert.equal(result.recommendation, "not_match");
});

test("a job with only preferred conditions still needs human review", async () => {
  const optionalInput = {
    ...input,
    job: { ...input.job, requirements: input.job.requirements.map((item) => ({ ...item, required: false })) }
  };
  const result = await screenResume(optionalInput, {
    evaluate: async () => response(["met", "met", "met"], ["s1", "s1", "s1"])
  });
  assert.equal(result.recommendation, "review");
});

test("binary and graded bonuses add points without changing required-condition decisions", async () => {
  const bonusInput = {
    job: {
      title: "Java 高级开发",
      requirements: [
        { id: "years", text: "至少 5 年 Java 经验" },
        { id: "company", text: "在指定企业正式任职", required: false, bonusPoints: 10 },
        { id: "complex", text: "复杂系统经验", required: false, bonusPoints: 20,
          levels: ["无可核实经历", "参与模块开发", "负责关键模块", "主导系统架构"] }
      ]
    },
    resume: { text: "Java 开发 7 年。\n在指定企业正式任职 2 年。\n主导过生产系统架构设计与上线。" }
  };
  const request = buildJevRequest(bonusInput);
  assert.equal(request.questions.status_1.type, "choice");
  assert.equal(request.questions.status_2.type, "score");
  assert.deepEqual(request.questions.status_2.criteria, bonusInput.job.requirements[2].levels);
  const result = await screenResume(bonusInput, {
    evaluate: async () => ({
      model: "jev-1.13.0",
      answers: {
        status_0: choice("met"), evidence_0: choice("s1"),
        status_1: choice("met"), evidence_1: choice("s2"),
        status_2: { type: "score", score: 2.4, confidence: 0.7,
          probabilities: { "0": 0, "1": 0.2, "2": 0.2, "3": 0.6 } },
        evidence_2: choice("s3")
      }
    })
  });
  assert.equal(result.recommendation, "match");
  assert.equal(result.requirements[1].bonusPointsEarned, 10);
  assert.equal(result.requirements[2].status, "scored");
  assert.equal(result.requirements[2].bonusPointsEarned, 16);
  assert.deepEqual(result.bonus, { earned: 26, possible: 30 });
});

test("a graded bonus without evidence earns no points and requires review when it scores highly", async () => {
  const bonusInput = {
    ...input,
    job: { ...input.job, requirements: [{ id: "complex", text: "复杂系统经验", required: false,
      bonusPoints: 20, levels: ["无证据", "参与", "主导"] }] }
  };
  const result = await screenResume(bonusInput, {
    evaluate: async () => ({ answers: {
      status_0: { type: "score", score: 1.8, confidence: 0.8,
        probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 } },
      evidence_0: choice("none")
    } })
  });
  assert.equal(result.requirements[0].status, "review");
  assert.deepEqual(result.bonus, { earned: 0, possible: 20 });
});

test("missing facts, uncertain judgments, and missing evidence require review", async () => {
  const missing = await screenResume(input, {
    evaluate: async () => response(["unknown", "met", "unknown"], ["none", "s1", "none"])
  });
  assert.equal(missing.recommendation, "review");
  assert.equal(missing.requirements[0].status, "unknown");

  const uncertain = await screenResume(input, {
    evaluate: async () => {
      const value = response(["met", "met", "unknown"], ["s1", "s1", "none"]);
      value.answers.status_0 = choice("met", { met: 0.55, unmet: 0.2, unknown: 0.25 });
      value.answers.evidence_1 = choice("none");
      return value;
    }
  });
  assert.equal(uncertain.recommendation, "review");
  assert.equal(uncertain.requirements[0].status, "review");
  assert.match(uncertain.requirements[0].reviewReason, /概率低/);
  assert.equal(uncertain.requirements[1].status, "review");
  assert.match(uncertain.requirements[1].reviewReason, /证据/);
});

test("rejects invalid input and malformed Jev response", async () => {
  assert.throws(() => buildJevRequest({ ...input, resume: { text: " " } }), /resume.text/);
  assert.throws(() => buildJevRequest({ ...input, job: { ...input.job, requirements: [input.job.requirements[0], input.job.requirements[0]] } }), /重复/);
  assert.throws(() => buildJevRequest({ ...input, job: { ...input.job, requirements: [{ id: "invalid", text: "加分", bonusPoints: 10 }] } }), /bonusPoints/);
  assert.throws(() => buildJevRequest({ ...input, job: { ...input.job, requirements: [{ id: "invalid", text: "加分", required: false, bonusPoints: 10, levels: ["只有一级"] }] } }), /levels/);
  await assert.rejects(screenResume(input, { evaluate: async () => ({ answers: {} }) }), /无效的判断结果/);
  assert.ok(segmentResume("第一段。\n第二段。", 10).every(({ text, start }) => "第一段。\n第二段。".slice(start, start + text.length) === text));
});

test("sends the documented TypeSafe HTTP request without exposing the key in output", async () => {
  let captured;
  const request = buildJevRequest(input);
  const result = await evaluateJev(request, {
    apiKey: "test-secret",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify(response(["met", "met", "unknown"], ["s1", "s1", "none"])), { status: 200 });
    }
  });
  assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.deepEqual(JSON.parse(captured.options.body), request);
  assert.equal(result.model, "jev-1.13.0");
});

const app = createApp({ screen: async (body) => ({ resumeId: body.resume.id, recommendation: "review" }) });
after(() => app.close());

test("POST /screen accepts JSON and returns the screening result", async () => {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const result = await fetch(`${base}/screen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { resumeId: "candidate-1", recommendation: "review" });
  const invalid = await fetch(`${base}/screen`, { method: "POST", body: "not-json" });
  assert.equal(invalid.status, 400);
});
