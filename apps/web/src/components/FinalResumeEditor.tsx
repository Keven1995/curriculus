"use client";

import React, { useState } from "react";
import {
  buildResumeWithApprovedSuggestions,
  approvedSuggestionIds,
  type AnalysisOutput,
  type SuggestionDecisions,
} from "../lib/analysis-client";

type FinalResumeEditorProps = {
  originalResume: string;
  analysis: AnalysisOutput;
  decisions: SuggestionDecisions;
  styles: Record<string, string>;
  onDraftChange?: (resumeText: string, appliedSuggestionIds: readonly string[]) => void;
};

export function FinalResumeEditor({
  originalResume,
  analysis,
  decisions,
  styles,
  onDraftChange,
}: FinalResumeEditorProps) {
  const [resumeText, setResumeText] = useState(originalResume);
  const [appliedIds, setAppliedIds] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const currentApprovedIds = approvedSuggestionIds(analysis, decisions);
  const isApprovalSnapshotCurrent = currentApprovedIds.length === appliedIds.length &&
    currentApprovedIds.every((id) => appliedIds.includes(id));
  const approvedCount = analysis.suggestions.filter(
    (suggestion) => decisions[suggestion.id] === "approved",
  ).length;
  const hasApprovedSuggestions = approvedCount > 0;

  function applyApprovedSuggestions() {
    const nextText = buildResumeWithApprovedSuggestions(originalResume, analysis, decisions);
    setResumeText(nextText);
    setAppliedIds(currentApprovedIds);
    onDraftChange?.(nextText, currentApprovedIds);
    setStatusMessage("Sugestões aprovadas aplicadas. Revise o currículo completo antes de baixar.");
  }

  function downloadResume() {
    if (!resumeText.trim()) return;
    const file = new Blob([resumeText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "curriculo-revisado.txt";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <section className={styles.finalResumeSection} aria-labelledby="final-resume-title">
      <div className={styles.checkoutHeading}>
        <span className={styles.step} aria-hidden="true">03</span>
        <div>
          <h2 id="final-resume-title">Monte e salve seu currículo</h2>
          <p>Revise o texto completo. Os ajustes feitos aqui também serão usados no PDF final.</p>
        </div>
      </div>

      <div className={styles.finalResumeCard}>
        <label htmlFor="final-resume">Currículo final editável</label>
        <textarea
          id="final-resume"
          rows={18}
          value={resumeText}
          maxLength={80_000}
          onChange={(event) => {
            const nextText = event.target.value;
            setResumeText(nextText);
            onDraftChange?.(nextText, appliedIds);
            setStatusMessage("");
          }}
        />
        <p className={styles.help}>
          Para inserir as sugestões aprovadas no PDF, clique no botão antes de baixar. As edições manuais feitas depois também irão para o PDF. Se mudar as aprovações, aplique novamente; isso reconstrói o texto a partir do currículo original e substitui as edições manuais desta caixa. Limite de 80.000 caracteres.
        </p>
        {!isApprovalSnapshotCurrent && (
          <p className={styles.status} role="status">
            As aprovações mudaram. Atualize o texto conforme as aprovações atuais antes de gerar o PDF.
          </p>
        )}
        {statusMessage && <p className={styles.status} role="status">{statusMessage}</p>}
        <div className={styles.finalResumeActions}>
          <button
            className={styles.finalResumeApplyButton}
            type="button"
            onClick={applyApprovedSuggestions}
            disabled={!hasApprovedSuggestions && isApprovalSnapshotCurrent}
          >
            Aplicar sugestões aprovadas ({approvedCount})
          </button>
          <button
            className={styles.submitButton}
            type="button"
            onClick={downloadResume}
            disabled={!resumeText.trim()}
          >
            Baixar currículo em texto (.txt)
          </button>
        </div>
        <p className={styles.finalResumePrivacy} role="note">
          O arquivo é montado e baixado neste navegador; não é enviado ao servidor nem exige pagamento. Confira todas as informações antes de usar o currículo.
        </p>
      </div>
    </section>
  );
}
