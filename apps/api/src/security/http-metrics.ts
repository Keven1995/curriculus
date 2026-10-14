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

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class HttpMetrics {
  private readonly requests = new Map<string, number>();

  record(method: string, route: string | undefined, statusCode: number): void {
    const safeMethod = METHODS.has(method) ? method : "OTHER";
    const safeRoute = route && ROUTES.has(route) ? route : "unmatched";
    const statusClass = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      ? `${Math.floor(statusCode / 100)}xx`
      : "other";
    const key = `${safeMethod}\u0000${safeRoute}\u0000${statusClass}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
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
    return `${lines.join("\n")}\n`;
  }
}
