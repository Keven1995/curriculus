import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import React from "react";
import axe from "axe-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnalysisPreview } from "./AnalysisPreview";
import type { AnalysisOutput, SuggestionDecisions } from "../lib/analysis-client";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});

const analysis: AnalysisOutput = {
  jobRequirements: [
    {
      id: "req-1",
      requirement: "Experiência com Java",
      status: "demonstrated",
      evidence: ["Trabalhei com Java."],
      pointsToConfirm: [],
    },
    {
      id: "req-2",
      requirement: "Experiência com liderança",
      status: "not_demonstrated",
      evidence: [],
      pointsToConfirm: ["Confirme se você já liderou uma equipe."],
    },
  ],
  suggestions: [
    {
      id: "suggestion-1",
      category: "job_alignment",
      section: "Experiência",
      originalText: "Trabalhei com Java.",
      suggestedText: "Desenvolvi soluções usando Java.",
      relatedRequirementIds: ["req-1"],
      rationale: "Deixa a experiência relevante mais direta.",
      sourceFacts: ["Trabalhei com Java."],
      pointsToConfirm: ["Confirme se a contribuição descrita representa seu trabalho."],
      sourceRange: { start: 0, end: 20 },
    },
  ],
  documentStructure: {
    sectionOrder: ["Experiência"],
    suggestionOrder: ["suggestion-1"],
  },
};

test.afterEach(() => cleanup());

test("renders the full diff, requirement context, evidence, and confirmation points", () => {
  render(
    <AnalysisPreview
      analysis={analysis}
      decisions={{}}
      onDecision={() => undefined}
      styles={styles}
    />,
  );

  assert.ok(screen.getByRole("heading", { name: "Revise as sugestões" }));
  assert.ok(screen.getByRole("note").textContent?.includes("a redação sugerida é uma proposta, não um fato verificado"));
  assert.equal(screen.getAllByText("Trabalhei com Java.").length, 2);
  assert.ok(screen.getByText("Desenvolvi soluções usando Java."));
  assert.ok(screen.getByText("Deixa a experiência relevante mais direta."));
  assert.ok(screen.getByText("Confirme se a contribuição descrita representa seu trabalho."));
  assert.ok(screen.getByText("Experiência com liderança"));
  assert.ok(screen.getByText("Confirme se você já liderou uma equipe."));
  assert.match(screen.getByText(/Aprovadas: 0/).textContent ?? "", /Pendentes: 1/);
});

test("explains an analysis with no suggestions without presenting a blank preview", () => {
  render(
    <AnalysisPreview
      analysis={{ ...analysis, suggestions: [], documentStructure: { ...analysis.documentStructure, suggestionOrder: [] } }}
      decisions={{}}
      onDecision={() => undefined}
      styles={styles}
    />,
  );

  assert.ok(screen.getByText(/Não identificamos trechos que precisem de sugestão/));
});

test("offers keyboard-accessible approve and reject buttons with state feedback", () => {
  let decisions: SuggestionDecisions = {};
  const view = render(
    <AnalysisPreview
      analysis={analysis}
      decisions={decisions}
      onDecision={(id, decision) => {
        decisions = { ...decisions, [id]: decision };
        view.rerender(
          <AnalysisPreview
            analysis={analysis}
            decisions={decisions}
            onDecision={(nextId, nextDecision) => {
              decisions = { ...decisions, [nextId]: nextDecision };
            }}
            styles={styles}
          />,
        );
      }}
      styles={styles}
    />,
  );

  const approve = screen.getByRole("button", { name: "Aprovar sugestão: Experiência" });
  assert.equal(approve.getAttribute("aria-pressed"), "false");
  fireEvent.click(approve);

  assert.equal(decisions["suggestion-1"], "approved");
  assert.equal(screen.getByRole("button", { name: "Aprovar sugestão: Experiência" }).getAttribute("aria-pressed"), "true");
  assert.ok(screen.getByText("Aprovada localmente"));
  assert.match(screen.getByText(/Aprovadas: 1/).textContent ?? "", /Pendentes: 0/);
});

test("identifies proofreading corrections separately and allows approving them", () => {
  const proofreadingAnalysis: AnalysisOutput = {
    ...analysis,
    jobRequirements: [],
    suggestions: [{
      ...analysis.suggestions[0]!,
      category: "proofreading",
      section: "Ortografia e pontuação",
      originalText: "experiencia",
      suggestedText: "experiência",
      relatedRequirementIds: [],
      sourceFacts: [],
      rationale: "Corrige a acentuação conforme a ortografia brasileira.",
      pointsToConfirm: [],
    }],
    documentStructure: {
      sectionOrder: ["Ortografia e pontuação"],
      suggestionOrder: ["suggestion-1"],
    },
  };

  render(
    <AnalysisPreview
      analysis={proofreadingAnalysis}
      decisions={{}}
      onDecision={() => undefined}
      styles={styles}
    />,
  );

  assert.ok(screen.getByText("Revisão ortográfica"));
  assert.ok(screen.getByText("experiência"));
  assert.ok(screen.getByRole("button", { name: "Aprovar correção ortográfica: Ortografia e pontuação" }));
});

test("blocks copy and context menu only inside the preview and explains the limits", () => {
  const { container } = render(
    <AnalysisPreview
      analysis={analysis}
      decisions={{}}
      onDecision={() => undefined}
      styles={styles}
    />,
  );
  const protectedRegion = container.querySelector("[data-protected-preview]");
  assert.ok(protectedRegion);

  const copyEvent = new window.Event("copy", { bubbles: true, cancelable: true });
  protectedRegion.dispatchEvent(copyEvent);
  const menuEvent = new window.Event("contextmenu", { bubbles: true, cancelable: true });
  protectedRegion.dispatchEvent(menuEvent);

  assert.equal(copyEvent.defaultPrevented, true);
  assert.equal(menuEvent.defaultPrevented, true);
  assert.ok(screen.getByText(/não impedem capturas de tela, OCR ou reprodução/i));
  assert.equal(container.querySelectorAll("[aria-hidden='true']").length > 0, true);
});

test("has no automated WCAG A/AA accessibility violations in the preview", async () => {
  const { container } = render(
    <AnalysisPreview
      analysis={analysis}
      decisions={{}}
      onDecision={() => undefined}
      styles={styles}
    />,
  );
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });

  assert.deepEqual(
    results.violations.map(({ id, impact }) => ({ id, impact })),
    [],
  );
});
