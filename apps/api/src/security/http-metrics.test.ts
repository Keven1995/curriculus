import assert from "node:assert/strict";
import test from "node:test";
import { HttpMetrics } from "./http-metrics.js";

test("keeps metric labels bounded to route templates and standard methods/status classes", () => {
  const metrics = new HttpMetrics();
  metrics.record("GET", "/sessions/first-secret-id/data?email=private@example.test", 204);
  metrics.record("GET", "/sessions/second-secret-id/data", 204);
  metrics.record("CUSTOM-USER-METHOD", "/unknown/private/path", 9999);

  const output = metrics.renderPrometheus();
  assert.match(output, /method="GET",route="unmatched",status_class="2xx"/);
  assert.match(output, /method="OTHER",route="unmatched",status_class="other"/);
  assert.equal(output.includes("first-secret-id"), false);
  assert.equal(output.includes("second-secret-id"), false);
  assert.equal(output.includes("private@example.test"), false);
  assert.equal(output.includes("CUSTOM-USER-METHOD"), false);
});

test("records known routes using only their registered templates", () => {
  const metrics = new HttpMetrics();
  metrics.record("DELETE", "/sessions/:sessionId/data", 429);
  metrics.record("DELETE", "/resume-layouts/:templateId", 204);

  assert.match(
    metrics.renderPrometheus(),
    /method="DELETE",route="\/sessions\/:sessionId\/data",status_class="4xx"\} 1/,
  );
  assert.match(
    metrics.renderPrometheus(),
    /method="DELETE",route="\/resume-layouts\/:templateId",status_class="2xx"\} 1/,
  );
});

test("records bounded p50 and p95 operation timings without accepting dynamic labels", () => {
  const metrics = new HttpMetrics();
  metrics.recordStage("extraction", 10);
  metrics.recordStage("extraction", 20);
  metrics.recordStage("extraction", 30);
  metrics.recordStage("extraction", 40);
  metrics.recordStage("extraction", 50);
  metrics.recordStage("private@example.test", 999);

  const output = metrics.renderPrometheus();
  assert.match(output, /curriculus_stage_duration_ms\{stage="extraction",quantile="0\.5"\} 30/);
  assert.match(output, /curriculus_stage_duration_ms\{stage="extraction",quantile="0\.95"\} 48/);
  assert.match(output, /curriculus_stage_duration_samples\{stage="extraction"\} 5/);
  assert.equal(output.includes("private@example.test"), false);
});
