"use client";

import React, { useState } from "react";
import {
  buildResumeWithApprovedSuggestions,
  type AnalysisOutput,
  type SuggestionDecisions,
} from "../lib/analysis-client";

type FinalResumeEditorProps = {
  originalResume: string;
  analysis: AnalysisOutput;
  decisions: SuggestionDecisions;
  styles: Record<string, string>;
};

export function FinalResumeEditor({
  originalResume,
  analysis,
  decisions,
  styles,
}: FinalResumeEditorProps) {
  const [resumeText, setResumeText] = useState(originalResume);
  const [statusMessage, setStatusMessage] = useState("");
  const approvedCount = analysis.suggestions.filter(
    (suggestion) => decisions[suggestion.id] === "approved",
  ).length;
  const hasApprovedSuggestions = approvedCount > 0;

  function applyApprovedSuggestions() {
    setResumeText(buildResumeWithApprovedSuggestions(originalResume, analysis, decisions));
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
          <p>Revise o texto completo, faça outros ajustes se quiser e baixe uma cópia no seu dispositivo.</p>
        </div>
      </div>

      <div className={styles.finalResumeCard}>
        <label htmlFor="final-resume">Currículo final editável</label>
        <textarea
          id="final-resume"
          rows={18}
          value={resumeText}
          onChange={(event) => {
            setResumeText(event.target.value);
            setStatusMessage("");
          }}
        />
        <p className={styles.help}>
          Para inserir as sugestões aprovadas, clique no botão antes de baixar. Aplicar novamente reconstrói o texto a partir do currículo original e substitui as edições manuais desta caixa.
        </p>
        {statusMessage && <p className={styles.status} role="status">{statusMessage}</p>}
        <div className={styles.finalResumeActions}>
          <button
            className={styles.finalResumeApplyButton}
            type="button"
            onClick={applyApprovedSuggestions}
            disabled={!hasApprovedSuggestions}
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
