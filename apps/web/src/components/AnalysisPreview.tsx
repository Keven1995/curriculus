import React, { type Ref } from "react";
import type {
  AnalysisOutput,
  SuggestionDecision,
  SuggestionDecisions,
} from "../lib/analysis-client";
import { summarizeDecisions } from "../lib/analysis-client";

type AnalysisPreviewProps = {
  analysis: AnalysisOutput;
  decisions: SuggestionDecisions;
  onDecision: (id: string, decision: SuggestionDecision) => void;
  styles: Record<string, string>;
  previewTitleRef?: Ref<HTMLHeadingElement>;
};

const requirementStatusText = {
  demonstrated: "Demonstrado no currículo",
  partially_demonstrated: "Parcialmente demonstrado",
  not_demonstrated: "Não demonstrado no currículo",
} as const;

export function AnalysisPreview({
  analysis,
  decisions,
  onDecision,
  styles,
  previewTitleRef,
}: AnalysisPreviewProps) {
  const summary = summarizeDecisions(analysis.suggestions, decisions);
  const requirementsById = new Map(
    analysis.jobRequirements.map((requirement) => [requirement.id, requirement]),
  );
  const orderedSuggestions = [...analysis.suggestions].sort((left, right) => {
    const leftOrder = analysis.documentStructure.suggestionOrder.indexOf(left.id);
    const rightOrder = analysis.documentStructure.suggestionOrder.indexOf(right.id);
    return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) -
      (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder);
  });

  return (
    <section className={styles.previewSection} aria-labelledby="preview-title">
      <div className={styles.previewHeading}>
        <div>
          <p className={styles.step}>02</p>
          <h2 id="preview-title" tabIndex={-1} ref={previewTitleRef}>Revise as sugestões</h2>
          <p>Compare cada trecho e decida o que representa sua experiência.</p>
        </div>
        <p className={styles.decisionSummary} aria-live="polite">
          Aprovadas: {summary.approved} · Rejeitadas: {summary.rejected} · Pendentes: {summary.pending}
        </p>
      </div>

        <div
          className={styles.protectedPreview}
          data-protected-preview
          onCopy={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        >
        <div className={styles.watermark} aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => <span key={index}>CURRICULUS · PRÉVIA</span>)}
        </div>
        <div className={styles.suggestionList}>
          {orderedSuggestions.length === 0 && (
            <p className={styles.emptySuggestions} role="status">
              Não identificamos trechos que precisem de sugestão. Revise também os requisitos abaixo antes de continuar.
            </p>
          )}
          {orderedSuggestions.map((suggestion) => {
            const decision = decisions[suggestion.id];
            return (
              <article className={styles.suggestionCard} key={suggestion.id}>
                <div className={styles.suggestionTopline}>
                  <h3>{suggestion.section}</h3>
                  <span className={styles.previewBadge}>Prévia</span>
                </div>

                <div className={styles.diff} role="group" aria-label={`Comparação para ${suggestion.section}`}>
                  <div>
                    <span className={styles.diffLabel}>Texto atual</span>
                    <del>{suggestion.originalText}</del>
                  </div>
                  <div>
                    <span className={styles.diffLabel}>Sugestão</span>
                    <ins>{suggestion.suggestedText}</ins>
                  </div>
                </div>

                <p className={styles.rationale}><strong>Por que sugerimos:</strong> {suggestion.rationale}</p>

                {suggestion.sourceFacts.length > 0 && (
                  <div className={styles.contextBlock}>
                    <h4>Evidências no currículo</h4>
                    <ul>{suggestion.sourceFacts.map((fact, index) => <li key={`${fact}-${index}`}>{fact}</li>)}</ul>
                  </div>
                )}

                {suggestion.relatedRequirementIds.length > 0 && (
                  <div className={styles.contextBlock}>
                    <h4>Requisitos relacionados</h4>
                    <ul>
                      {suggestion.relatedRequirementIds.map((id) => {
                        const requirement = requirementsById.get(id);
                        return requirement ? (
                          <li key={id}>
                            <strong>{requirement.requirement}</strong> — {requirementStatusText[requirement.status]}
                          </li>
                        ) : null;
                      })}
                    </ul>
                  </div>
                )}

                {suggestion.pointsToConfirm.length > 0 && (
                  <aside className={styles.confirmationNotice}>
                    <h4>Confirme antes de aprovar</h4>
                    <ul>{suggestion.pointsToConfirm.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}</ul>
                  </aside>
                )}

                <div className={styles.decisionControls} role="group" aria-label={`Decisão para ${suggestion.section}`}>
                  <button
                    type="button"
                    aria-pressed={decision === "approved"}
                    aria-label={`Aprovar sugestão: ${suggestion.section}`}
                    className={styles.approveButton}
                    onClick={() => onDecision(suggestion.id, "approved")}
                  >
                    Aprovar
                  </button>
                  <button
                    type="button"
                    aria-pressed={decision === "rejected"}
                    aria-label={`Rejeitar sugestão: ${suggestion.section}`}
                    className={styles.rejectButton}
                    onClick={() => onDecision(suggestion.id, "rejected")}
                  >
                    Rejeitar
                  </button>
                  {decision && (
                    <span className={styles.decisionFeedback} role="status">
                      {decision === "approved" ? "Aprovada localmente" : "Rejeitada localmente"}
                    </span>
                  )}
                </div>
              </article>
            );
          })}

          {analysis.jobRequirements.length > 0 && (
            <section className={styles.requirementOverview} aria-labelledby="requirements-title">
              <h3 id="requirements-title">Requisitos da vaga analisados</h3>
              <ul>
                {analysis.jobRequirements.map((requirement) => (
                  <li key={requirement.id}>
                    <strong>{requirement.requirement}</strong>
                    <span>{requirementStatusText[requirement.status]}</span>
                    {requirement.pointsToConfirm.length > 0 && (
                      <ul>{requirement.pointsToConfirm.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}</ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      <p className={styles.copyNotice}>
        Esta é uma prévia. A marca d’água e a desativação de copiar e do menu de contexto são apenas dissuasões e não impedem capturas de tela, OCR ou reprodução.
      </p>
      <p className={styles.paymentNotice}>
        Suas decisões ficam apenas nesta página. O preview, por si só, não inicia uma cobrança nem gera o documento final.
      </p>
    </section>
  );
}
