import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { Agent, request as httpRequest } from "node:http";
import PDFDocument from "pdfkit";
import type { AnalysisOutput } from "../src/analyses/analysis-output.js";
import type { AnalysisService, AnalysisUsage } from "../src/analyses/analysis-service.js";
import { DocumentService, type DocumentRepository, type PrivateDocumentStorage } from "../src/documents/document-service.js";
import { renderResumePdf } from "../src/documents/pdf-renderer.js";
import type {
  OrderRecord,
  StoredAnalysisSession,
} from "../src/persistence/session-repository.js";
import { createApp } from "../src/app.js";
import { extractPdfLayout } from "../src/resume-layout/pdf-layout-extractor.js";
import { renderLayoutTextResumePdf } from "../src/resume-layout/layout-text-pdf-renderer.js";
import { ResumeLayoutService } from "../src/resume-layout/resume-layout-service.js";
import type { ResumeLayoutTemplate } from "../src/resume-layout/resume-layout-types.js";
import type { ResumeLayoutTemplateStore } from "../src/resume-layout/resume-layout-store.js";
import type { SessionRepository } from "../src/persistence/session-repository.js";

const ITERATIONS = 30;
const WARMUP_ITERATIONS = 3;
const DAY_MS = 24 * 60 * 60 * 1_000;
const analysis: AnalysisOutput = { jobRequirements: [], suggestions: [], documentStructure: { sectionOrder: [], suggestionOrder: [] } };
const usage: AnalysisUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: null };

type Scenario = {
  id: "small-1p-short" | "large-2p-long" | "typical-3p-1mib" | "large-10p-5mib";
  sourcePages: number;
  sourcePdf: Buffer;
  resume: string;
  jobDescription: string;
};

class MemoryLayoutStore implements ResumeLayoutTemplateStore {
  private readonly templates = new Map<string, ResumeLayoutTemplate>();
  async storeTemporaryResumeLayout(id: string, template: ResumeLayoutTemplate): Promise<Date> {
    this.templates.set(id, template);
    return new Date(Date.now() + DAY_MS);
  }
  async findTemporaryResumeLayout(id: string): Promise<ResumeLayoutTemplate | null> { return this.templates.get(id) ?? null; }
  async deleteTemporaryResumeLayout(id: string): Promise<boolean> { return this.templates.delete(id); }
  async deleteExpiredTemporaryResumeLayouts(): Promise<number> { return 0; }
}

class BenchmarkDocumentRepository implements DocumentRepository {
  private session: StoredAnalysisSession | null = null;
  private order: OrderRecord | null = null;
  private generated: { sessionId: string; storageKey: string; expiresAt: Date; layoutFallback?: boolean } | null = null;

  prepare(sessionId: string, resume: string, layout: ResumeLayoutTemplate): void {
    const now = new Date();
    this.session = {
      id: sessionId,
      status: "analysis_ready",
      jobDescription: "Descrição sintética de benchmark; sem dados pessoais.",
      resume,
      analysis,
      usage,
      resumeLayoutTemplate: layout,
      createdAt: now,
      expiresAt: new Date(now.getTime() + DAY_MS),
    };
    this.order = {
      id: randomUUID(),
      sessionId,
      amountCents: 199,
      currency: "BRL",
      status: "approved",
      providerPaymentId: "benchmark-approved",
      pixQrCode: null,
      pixQrCodeBase64: null,
      createdAt: now,
      updatedAt: now,
      checkoutExpiresAt: new Date(now.getTime() + DAY_MS),
    };
    this.generated = null;
  }

  async isReady() { return true; }
  async findActiveSession(id: string) { return this.session?.id === id ? this.session : null; }
  async findOrderBySessionId(id: string) { return this.order?.sessionId === id ? this.order : null; }
  async findGeneratedDocument(id: string) { return this.generated?.sessionId === id ? this.generated : null; }
  async markDocumentGenerated(id: string, storageKey: string, layoutFallback = false) {
    if (this.session?.id !== id || this.order?.status !== "approved") return false;
    this.generated = { sessionId: id, storageKey, expiresAt: new Date(Date.now() + DAY_MS), layoutFallback };
    return true;
  }
  async findExpiredDocuments() { return []; }
  async findActiveDocumentStorageKeys() { return this.generated ? [this.generated.storageKey] : []; }
  async deleteExpiredDocumentRecord() { return false; }
}

class MemoryDocumentStorage implements PrivateDocumentStorage {
  private readonly files = new Map<string, Buffer>();
  async write(key: string, contents: Buffer) { this.files.set(key, contents); }
  async read(key: string) { return this.files.get(key) ?? null; }
  async list() { return [...this.files.keys()].map((key) => ({ key, modifiedAt: new Date() })); }
  async delete(key: string) { this.files.delete(key); }
}

async function makePdf(pages: number, linesPerPage: number, targetBytes = 0): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 40 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  for (let page = 0; page < pages; page += 1) {
    if (page > 0) document.addPage();
    document.font("Helvetica-Bold").fontSize(18).text("Currículo sintético de benchmark", { continued: false });
    document.moveDown();
    document.font("Helvetica").fontSize(10);
    for (let line = 0; line < linesPerPage; line += 1) {
      document.text(`Experiência sintética ${page + 1}.${line + 1}: documentação, colaboração e resultados verificáveis.`, { width: 500 });
    }
  }
  document.end();
  const pdf = await ended;
  if (targetBytes <= pdf.length) return pdf;
  // Trailing PDF comments preserve the visible document while exercising representative upload sizes.
  const paddingHeader = Buffer.from("\n% Synthetic Curriculus upload fixture padding ", "ascii");
  const paddingBytes = targetBytes - pdf.length - paddingHeader.length - 1;
  return Buffer.concat([pdf, paddingHeader, Buffer.alloc(paddingBytes, 0x78), Buffer.from("\n")]);
}

function scenarioText(lines: number): string {
  return ["PESSOA FICTÍCIA", "CONTATO", "benchmark@example.test", "EXPERIÊNCIA", ...Array.from(
    { length: lines },
    (_, index) => `Experiência sintética ${index + 1}: documentação, colaboração e resultados verificáveis.`,
  ), "FORMAÇÃO", "Formação sintética para benchmark."].join("\n");
}

async function buildScenarios(): Promise<Scenario[]> {
  return [
    {
      id: "small-1p-short",
      sourcePages: 1,
      sourcePdf: await makePdf(1, 8),
      resume: scenarioText(8),
      jobDescription: "Vaga sintética curta: organização e comunicação.",
    },
    {
      id: "typical-3p-1mib",
      sourcePages: 3,
      sourcePdf: await makePdf(3, 20, 1 * 1024 * 1024),
      resume: scenarioText(45),
      jobDescription: `Vaga sintética típica: ${"comunicação, experiência e colaboração. ".repeat(40)}`,
    },
    {
      id: "large-2p-long",
      sourcePages: 2,
      sourcePdf: await makePdf(2, 28),
      resume: scenarioText(120),
      jobDescription: `Vaga sintética longa: ${"requisitos de comunicação, colaboração e organização. ".repeat(100)}`,
    },
    {
      id: "large-10p-5mib",
      sourcePages: 10,
      sourcePdf: await makePdf(10, 20, 5 * 1024 * 1024),
      resume: scenarioText(250),
      jobDescription: `Vaga sintética longa: ${"requisitos de comunicação, colaboração e organização. ".repeat(100)}`,
    },
  ];
}

async function measure(action: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await action();
  return performance.now() - started;
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value = sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
  return Number(value.toFixed(2));
}

function stageMetricsFromPrometheus(output: string, stage: string) {
  const readValue = (quantile: string) => {
    const match = output.match(new RegExp(`curriculus_stage_duration_ms\\{stage="${stage}",quantile="${quantile}"\\} ([0-9.]+)`));
    return match ? Number(match[1]) : undefined;
  };
  const count = output.match(new RegExp(`curriculus_stage_duration_samples\\{stage="${stage}"\\} ([0-9]+)`));
  const p50Ms = readValue("0.5");
  const p95Ms = readValue("0.95");
  if (p50Ms === undefined || p95Ms === undefined || !count) throw new Error(`Missing ${stage} stage metrics.`);
  return { samples: Number(count[1]), p50Ms, p95Ms };
}

function sampleSummary(values: number[]) {
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    samples: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function postPdfOverLoopback(url: string, fileName: string, bytes: Buffer, agent: Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let uploadFinishedAt: number | undefined;
    const request = httpRequest(url, {
      agent,
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.length),
        "x-file-name": encodeURIComponent(fileName),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode !== 201) {
          reject(new Error("Synthetic loopback PDF upload failed."));
          return;
        }
        if (uploadFinishedAt === undefined) {
          reject(new Error("Synthetic loopback upload did not finish writing."));
          return;
        }
        resolve(uploadFinishedAt - startedAt);
      });
    });
    request.once("error", reject);
    request.once("finish", () => { uploadFinishedAt = performance.now(); });
    request.end(bytes);
  });
}

async function measureStage(action: () => Promise<void>) {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await action();
  const values: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) values.push(await measure(action));
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    samples: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
  };
}

async function main(): Promise<void> {
  const scenarios = await buildScenarios();
  const rateLimitPolicies = {
    global: { limit: 1_000, windowMs: 60_000 },
    analysis: { limit: 1_000, windowMs: 60_000 },
    analysisDaily: { limit: 1_000, windowMs: 60_000 },
    layoutImport: { limit: 1_000, windowMs: 60_000 },
    documentGeneration: { limit: 1_000, windowMs: 60_000 },
  } as const;
  const report = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    note: "Somente dados sintéticos; sem chamadas externas, acesso ao banco real ou dados pessoais. O upload loopback não representa rede externa.",
    methodology: {
      iterations: ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      upload: "uploadRequestEndToEnd via Fastify inject é mantido apenas para comparação com a baseline anterior. clientUploadTransfer e serverUploadReceive usam HTTP real em 127.0.0.1; o primeiro termina quando o corpo foi escrito no socket, o segundo mede onRequest até raw end, ambos antes da extração. Loopback não equivale à rede de produção.",
      extraction: "extractPdfLayout direto; tempo isolado do parser e classificador.",
      analysis: "POST /analyses com serviço determinístico mockado e repositório em memória; não representa latência nem custo de IA real.",
      reviewSubmission: "POST /sessions/:id/documents via Fastify inject; inclui validação, renderer, storage e persistência em memória; não mede PostgreSQL.",
      pdfGeneration: "Tempo do renderer v3 medido isoladamente com o template extraído do mesmo cenário.",
      fileSizeProfiles: "Os perfis de 1 MiB e 5 MiB usam padding de comentário sintético após %%EOF para representar bytes de transporte; parsing de PDFs com imagens/estrutura complexa pode ter custo diferente.",
      percentile: "Interpolação linear entre amostras ordenadas (quantil 0,50 e 0,95).",
    },
    scenarios: [] as Array<Record<string, unknown>>,
  };

  for (const scenario of scenarios) {
    const extracted = await extractPdfLayout(scenario.sourcePdf, `${scenario.id}.pdf`);
    const layoutStore = new MemoryLayoutStore();
    const layoutService = new ResumeLayoutService(layoutStore);
    const metricsToken = "synthetic-benchmark-metrics-token-with-more-than-32-bytes";
    const uploadApp = createApp({
      resumeLayoutService: layoutService,
      resumeLayoutImportEnabled: true,
      rateLimitPolicies,
      metricsToken,
    });
    const upload = await measureStage(async () => {
      const response = await uploadApp.inject({
        method: "POST",
        url: "/resume-layouts/import",
        headers: { "content-type": "application/pdf", "x-file-name": `${scenario.id}.pdf` },
        payload: scenario.sourcePdf,
      });
      if (response.statusCode !== 201) throw new Error("Synthetic upload benchmark failed.");
    });
    await uploadApp.close();

    const loopbackApp = createApp({
      resumeLayoutService: new ResumeLayoutService(new MemoryLayoutStore()),
      resumeLayoutImportEnabled: true,
      rateLimitPolicies,
      metricsToken,
    });
    const loopbackAddress = await loopbackApp.listen({ port: 0, host: "127.0.0.1" });
    const loopbackUrl = new URL("/resume-layouts/import", loopbackAddress).toString();
    const loopbackAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    const clientUploadDurations: number[] = [];
    const loopbackUploadEndToEnd = await measureStage(async () => {
      clientUploadDurations.push(await postPdfOverLoopback(loopbackUrl, `${scenario.id}.pdf`, scenario.sourcePdf, loopbackAgent));
    });
    const loopbackMetricsResponse = await loopbackApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    if (loopbackMetricsResponse.statusCode !== 200) throw new Error("Synthetic loopback upload metrics were unavailable.");
    const serverUploadReceive = stageMetricsFromPrometheus(loopbackMetricsResponse.body, "upload");
    loopbackAgent.destroy();
    await loopbackApp.close();

    const extraction = await measureStage(async () => {
      await extractPdfLayout(scenario.sourcePdf, `${scenario.id}.pdf`);
    });

    const analysisRepository = {
      async isReady() { return true; },
      async createSession() {
        const now = new Date();
        return { id: randomUUID(), createdAt: now, expiresAt: new Date(now.getTime() + DAY_MS) };
      },
    } as unknown as SessionRepository;
    const analysisService: AnalysisService = {
      async analyze() { return { analysis, usage }; },
    };
    const analysisApp = createApp({ analysisService, sessionRepository: analysisRepository, rateLimitPolicies });
    const analysisRequest = JSON.stringify({
      jobDescription: scenario.jobDescription,
      resume: scenario.resume,
      dataNoticeAcknowledged: true,
    });
    const analysisTiming = await measureStage(async () => {
      const response = await analysisApp.inject({
        method: "POST",
        url: "/analyses",
        headers: { "content-type": "application/json" },
        payload: analysisRequest,
      });
      if (response.statusCode !== 201) throw new Error("Synthetic analysis benchmark failed.");
    });
    await analysisApp.close();

    const documentRepository = new BenchmarkDocumentRepository();
    const renderTimings: number[] = [];
    const documentService = new DocumentService(
      documentRepository,
      new MemoryDocumentStorage(),
      "synthetic-benchmark-secret-with-at-least-32-characters",
      async (resume, layout) => {
        const started = performance.now();
        const pdf = layout
          ? await renderLayoutTextResumePdf(layout, resume)
          : await renderResumePdf(resume);
        renderTimings.push(performance.now() - started);
        return pdf;
      },
    );
    const reviewApp = createApp({ documentService, rateLimitPolicies });
    const reviewRenderTimingStart = renderTimings.length;
    const reviewSubmission = await measureStage(async () => {
      const sessionId = randomUUID();
      documentRepository.prepare(sessionId, scenario.resume, extracted.template);
      const response = await reviewApp.inject({
        method: "POST",
        url: `/sessions/${sessionId}/documents`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ approvedSuggestionIds: [], finalResumeText: scenario.resume }),
      });
      if (response.statusCode !== 201) throw new Error("Synthetic reviewed-document benchmark failed.");
    });
    const sequentialRenderTimings = renderTimings.slice(reviewRenderTimingStart + WARMUP_ITERATIONS);
    const concurrentRenderCounts: number[] = [];
    const concurrentReviewedSubmission = await measureStage(async () => {
      const sessionId = randomUUID();
      documentRepository.prepare(sessionId, scenario.resume, extracted.template);
      const renderCountBefore = renderTimings.length;
      const payload = JSON.stringify({ approvedSuggestionIds: [], finalResumeText: scenario.resume });
      const [first, second] = await Promise.all([
        reviewApp.inject({ method: "POST", url: `/sessions/${sessionId}/documents`, headers: { "content-type": "application/json" }, payload }),
        reviewApp.inject({ method: "POST", url: `/sessions/${sessionId}/documents`, headers: { "content-type": "application/json" }, payload }),
      ]);
      if (first.statusCode !== 200 && first.statusCode !== 201) throw new Error("Synthetic concurrent document request failed.");
      if (second.statusCode !== 200 && second.statusCode !== 201) throw new Error("Synthetic concurrent document request failed.");
      concurrentRenderCounts.push(renderTimings.length - renderCountBefore);
    });
    await reviewApp.close();

    const pdfGeneration = await measureStage(async () => {
      await renderLayoutTextResumePdf(extracted.template, scenario.resume);
    });

    report.scenarios.push({
      id: scenario.id,
      sourcePages: scenario.sourcePages,
      sourcePdfBytes: scenario.sourcePdf.length,
      resumeCharacters: Array.from(scenario.resume).length,
      jobDescriptionCharacters: Array.from(scenario.jobDescription).length,
      stages: {
        uploadRequestEndToEnd: upload,
        uploadLoopbackRequestEndToEnd: loopbackUploadEndToEnd,
        clientUploadTransfer: sampleSummary(clientUploadDurations),
        serverUploadReceive,
        pdfExtraction: extraction,
        analysisWithMockProvider: analysisTiming,
        reviewedSubmissionEndToEnd: reviewSubmission,
        concurrentDuplicateReviewedSubmission: {
          ...concurrentReviewedSubmission,
          renderInvocationsPerPair: Number((concurrentRenderCounts.reduce((sum, count) => sum + count, 0) / concurrentRenderCounts.length).toFixed(2)),
        },
        pdfRendering: pdfGeneration,
        pdfRenderingWithinReviewedSubmission: {
          samples: sequentialRenderTimings.length,
          p50Ms: percentile(sequentialRenderTimings.slice().sort((a, b) => a - b), 0.5),
          p95Ms: percentile(sequentialRenderTimings.slice().sort((a, b) => a - b), 0.95),
        },
      },
    });
  }

  const defaultDirectory = resolve(
    process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".",
    "Temp",
    "opencode",
    "curriculus-sprint3-performance",
  );
  const outputPath = process.env.PERFORMANCE_OUTPUT_PATH ?? join(defaultDirectory, "after.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Synthetic performance report: ${outputPath}`);
  for (const scenario of report.scenarios) {
    const stages = scenario.stages as Record<string, { p50Ms: number; p95Ms: number }>;
    console.log(`${scenario.id}: ${Object.entries(stages).map(([stage, value]) => `${stage} p50=${value.p50Ms}ms p95=${value.p95Ms}ms`).join(" | ")}`);
  }
}

await main();
