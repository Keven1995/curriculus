import type {
  AnalysisProvider,
  GenerateAnalysisRequest,
  GeneratedAnalysis,
} from "./openai-responses-provider.js";

export const MOCK_ANALYSIS_FIXTURE = {
  resume: "Trabalhei com Java para construir APIs REST. Tenho experiencia com documentacao tecnica.",
  jobDescription:
    "Vaga para pessoa desenvolvedora com experiência em Java, construção de APIs REST e liderança de equipes.",
} as const;

const fixtureOutput = {
  jobRequirements: [
    {
      id: "req-java",
      requirement: "Experiência com Java",
      status: "demonstrated",
      evidence: ["Java"],
      pointsToConfirm: [],
    },
    {
      id: "req-rest",
      requirement: "Desenvolvimento de APIs REST",
      status: "partially_demonstrated",
      evidence: ["APIs REST"],
      pointsToConfirm: ["Confirme seu nível de participação e responsabilidade no desenvolvimento."],
    },
    {
      id: "req-leadership",
      requirement: "Liderança de equipes",
      status: "not_demonstrated",
      evidence: [],
      pointsToConfirm: ["Confirme se você já liderou equipes; essa informação não aparece no currículo de exemplo."],
    },
  ],
  suggestions: [
    {
      id: "suggestion-experience-1",
      category: "job_alignment",
      section: "Experiência",
      originalText: "Trabalhei com Java para construir APIs REST.",
      suggestedText: "Desenvolvi APIs REST com Java.",
      relatedRequirementIds: ["req-java", "req-rest"],
      rationale: "Organiza a experiência já descrita e destaca as tecnologias citadas, sem acrescentar fatos.",
      sourceFacts: ["Java", "APIs REST"],
      pointsToConfirm: [],
    },
    {
      id: "suggestion-proofreading-1",
      category: "proofreading",
      section: "Ortografia e pontuação",
      originalText: "experiencia com documentacao tecnica",
      suggestedText: "experiência com documentação técnica",
      relatedRequirementIds: [],
      rationale: "Corrige a acentuação conforme a ortografia brasileira.",
      sourceFacts: [],
      pointsToConfirm: [],
    },
  ],
  documentStructure: {
    sectionOrder: ["Experiência", "Ortografia e pontuação"],
    suggestionOrder: ["suggestion-experience-1", "suggestion-proofreading-1"],
  },
};

const emptyOutput = {
  jobRequirements: [],
  suggestions: [],
  documentStructure: { sectionOrder: [], suggestionOrder: [] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFixtureText(value: unknown): string | null {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : null;
}

function selectOutput(input: string): typeof fixtureOutput | typeof emptyOutput {
  try {
    const parsed: unknown = JSON.parse(input);
    if (
      isRecord(parsed) &&
      normalizeFixtureText(parsed.resume) === normalizeFixtureText(MOCK_ANALYSIS_FIXTURE.resume) &&
      normalizeFixtureText(parsed.jobDescription) === normalizeFixtureText(MOCK_ANALYSIS_FIXTURE.jobDescription)
    ) {
      return fixtureOutput;
    }
  } catch {
    // The empty, schema-valid response keeps malformed mock input from becoming a claim.
  }

  // The mock intentionally does not infer facts for arbitrary user-provided content.
  return emptyOutput;
}

/** A deterministic, network-free provider for local development and tests only. */
export class MockAnalysisProvider implements AnalysisProvider {
  async generate(request: GenerateAnalysisRequest): Promise<GeneratedAnalysis> {
    return {
      outputText: JSON.stringify(selectOutput(request.input)),
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
