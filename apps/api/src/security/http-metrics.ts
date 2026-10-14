const ROUTES = new Set([
  "/health",
  "/metrics",
  "/sessions/:sessionId/data",
  "/analyses",
  "/sessions/:sessionId/payments/pix",
  "/sessions/:sessionId/payments/status",
  "/sessions/:sessionId/documents",
  "/documents/:sessionId",
  "/features",
  "/resume-layouts/import",
  "/resume-layouts/:templateId",
  "/webhooks/mercadopago",
]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]);
const STAGES = new Set(["upload", "extraction", "analysis", "review_submission", "pdf_generation"]);
const MAX_STAGE_SAMPLES = 2_048;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly stageDurations = new Map<string, number[]>();

  record(method: string, route: string | undefined, statusCode: number): void {
    const safeMethod = METHODS.has(method) ? method : "OTHER";
    const safeRoute = route && ROUTES.has(route) ? route : "unmatched";
    const statusClass = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      ? `${Math.floor(statusCode / 100)}xx`
      : "other";
    const key = `${safeMethod}\u0000${safeRoute}\u0000${statusClass}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
  }

  recordStage(stage: string, durationMs: number): void {
    if (!STAGES.has(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = this.stageDurations.get(stage) ?? [];
    samples.push(durationMs);
    if (samples.length > MAX_STAGE_SAMPLES) samples.shift();
    this.stageDurations.set(stage, samples);
  }

  renderPrometheus(): string {
    const lines = [
      "# HELP curriculus_http_requests_total Total HTTP responses by method, route template, and status class.",
      "# TYPE curriculus_http_requests_total counter",
    ];
    for (const [key, count] of [...this.requests].sort(([left], [right]) => left.localeCompare(right))) {
      const [method, route, statusClass] = key.split("\u0000");
      lines.push(
        `curriculus_http_requests_total{method="${escapeLabel(method!)}",route="${escapeLabel(route!)}",status_class="${escapeLabel(statusClass!)}"} ${count}`,
      );
    }
    lines.push(
      "# HELP curriculus_stage_duration_ms Rolling p50/p95 stage duration in milliseconds over at most 2048 observations per stage.",
      "# TYPE curriculus_stage_duration_ms gauge",
      "# HELP curriculus_stage_duration_samples Number of observations in the rolling stage window.",
      "# TYPE curriculus_stage_duration_samples gauge",
    );
    for (const [stage, rawSamples] of [...this.stageDurations].sort(([left], [right]) => left.localeCompare(right))) {
      const samples = rawSamples.slice().sort((left, right) => left - right);
      for (const quantile of [0.5, 0.95]) {
        const index = (samples.length - 1) * quantile;
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const value = samples[lower]! + (samples[upper]! - samples[lower]!) * (index - lower);
        lines.push(`curriculus_stage_duration_ms{stage="${stage}",quantile="${quantile}"} ${Number(value.toFixed(3))}`);
      }
      lines.push(`curriculus_stage_duration_samples{stage="${stage}"} ${samples.length}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
