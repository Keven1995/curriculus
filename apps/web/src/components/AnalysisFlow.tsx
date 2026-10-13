"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AnalysisClientError,
  requestAnalysis,
  updateSuggestionDecision,
  type AnalysisApiResponse,
  type SuggestionDecision,
  type SuggestionDecisions,
} from "../lib/analysis-client";
import { validateIntake, type IntakeInput } from "../lib/intake";
import { AnalysisPreview } from "./AnalysisPreview";
import { PixCheckout } from "./PixCheckout";

type AnalysisFlowProps = {
  styles: Record<string, string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

const emptyForm: IntakeInput = {
  jobUrl: "",
  jobDescription: "",
  resume: "",
  acknowledged: false,
};

export function AnalysisFlow({ styles, apiBaseUrl, fetcher }: AnalysisFlowProps) {
  const [form, setForm] = useState<IntakeInput>(emptyForm);
  const [errors, setErrors] = useState<ReturnType<typeof validateIntake>>({});
  const [message, setMessage] = useState("");
  const [analysisResponse, setAnalysisResponse] = useState<AnalysisApiResponse | null>(null);
  const [decisions, setDecisions] = useState<SuggestionDecisions>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const previewTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (analysisResponse) previewTitleRef.current?.focus();
  }, [analysisResponse]);

  function updateForm<K extends keyof IntakeInput>(field: K, value: IntakeInput[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors({});
    setMessage("");
    setAnalysisResponse(null);
    setDecisions({});
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const validationErrors = validateIntake(form);
    if (!validationErrors.job && !form.jobDescription.trim()) {
      validationErrors.job = "Cole a descrição completa da vaga; a leitura automática do link ainda não está disponível.";
    }
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      setMessage("Revise os campos indicados antes de continuar.");
      return;
    }

    setMessage("");
    setAnalysisResponse(null);
    setDecisions({});
    setIsSubmitting(true);
    try {
      const response = await requestAnalysis(form, { apiBaseUrl, fetcher });
      setAnalysisResponse(response);
    } catch (error) {
      setMessage(
        error instanceof AnalysisClientError
          ? error.message
          : "Não foi possível concluir a análise. Tente novamente mais tarde.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function decideSuggestion(id: string, decision: SuggestionDecision) {
    setDecisions((current) => updateSuggestionDecision(current, id, decision));
  }

  return (
    <>
      <section className={styles.formSection} aria-labelledby="form-title">
        <div className={styles.sectionHeading}>
          <span className={styles.step} aria-hidden="true">01</span>
          <div>
            <h2 id="form-title">Vamos começar pelo contexto</h2>
            <p>Informe a vaga e cole seu currículo para comparar.</p>
          </div>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
          <div className={styles.field}>
            <label htmlFor="job-url">Link da vaga <span>(opcional)</span></label>
            <input
              id="job-url"
              type="url"
              inputMode="url"
              placeholder="https://empresa.com/vaga"
              value={form.jobUrl}
              disabled={isSubmitting}
              onChange={(event) => updateForm("jobUrl", event.target.value)}
              aria-invalid={Boolean(errors.job)}
              aria-describedby={errors.job ? "job-help job-error" : "job-help"}
            />
            <p className={styles.help} id="job-help">
              O link é apenas referência: a leitura automática ainda não está disponível. Cole a descrição completa abaixo.
            </p>
            {errors.job && <p className={styles.error} id="job-error">{errors.job}</p>}
          </div>

          <div className={styles.field}>
            <label htmlFor="job-description">Descrição da vaga <span>(necessária para análise)</span></label>
            <textarea
              id="job-description"
              rows={5}
              placeholder="Cole aqui as responsabilidades e os requisitos da oportunidade..."
              value={form.jobDescription}
              disabled={isSubmitting}
              onChange={(event) => updateForm("jobDescription", event.target.value)}
              aria-invalid={Boolean(errors.job)}
              aria-describedby={errors.job ? "job-description-error" : undefined}
            />
            {errors.job && <p className={styles.error} id="job-description-error">{errors.job}</p>}
          </div>

          <div className={styles.field}>
            <label htmlFor="resume">Seu currículo em texto</label>
            <textarea
              id="resume"
              rows={9}
              placeholder="Cole seu currículo aqui. Você pode incluir experiências, formação e competências relevantes..."
              value={form.resume}
              disabled={isSubmitting}
              onChange={(event) => updateForm("resume", event.target.value)}
              aria-invalid={Boolean(errors.resume)}
              aria-describedby={errors.resume ? "resume-help resume-error" : "resume-help"}
            />
            <p className={styles.help} id="resume-help">
              Evite incluir CPF, RG, endereço residencial, dados bancários, informações sensíveis ou dados de outras pessoas.
            </p>
            {errors.resume && <p className={styles.error} id="resume-error">{errors.resume}</p>}
          </div>

          <aside className={styles.privacyNotice} id="aviso-de-dados" aria-labelledby="privacy-title">
            <span className={styles.privacyIcon} aria-hidden="true">i</span>
            <div>
              <h3 id="privacy-title">Seus dados devem servir apenas a este objetivo</h3>
              <p>
                Currículo e descrição da vaga são enviados ao serviço para gerar sugestões, não para avaliar sua empregabilidade. Fornecedores necessários poderão processar os dados para prestar o serviço. Sessões sem pagamento expiram em 24 horas.
              </p>
              <p className={styles.prototypeNote}>
                A análise só será realizada quando o serviço estiver habilitado. Nenhum pagamento ou documento final é solicitado nesta etapa.
              </p>
            </div>
          </aside>

          <div className={styles.consentField}>
            <input
              id="acknowledged"
              type="checkbox"
              checked={form.acknowledged}
              disabled={isSubmitting}
              onChange={(event) => updateForm("acknowledged", event.target.checked)}
              aria-invalid={Boolean(errors.acknowledged)}
              aria-describedby={errors.acknowledged ? "acknowledgement-error" : undefined}
            />
            <label htmlFor="acknowledged">
              Li o aviso sobre o uso dos dados e confirmo que não incluí informações sensíveis desnecessárias ou dados de terceiros.
            </label>
          </div>
          {errors.acknowledged && (
            <p className={styles.error} id="acknowledgement-error">{errors.acknowledged}</p>
          )}

          <button className={styles.submitButton} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Analisando…" : "Gerar sugestões"} <span aria-hidden="true">→</span>
          </button>
          <p className={styles.submitNote}>
            Você revisa cada sugestão. Aprovar ou rejeitar não inicia cobrança nem gera um documento.
          </p>
          {(message || isSubmitting) && (
            <p className={isSubmitting || Object.keys(errors).length > 0 ? styles.status : styles.errorStatus}
              role={isSubmitting || Object.keys(errors).length > 0 ? "status" : "alert"}
              aria-live={isSubmitting || Object.keys(errors).length > 0 ? "polite" : "assertive"}
            >
              {isSubmitting ? "Enviando seus textos para análise…" : message}
            </p>
          )}
        </form>
      </section>

      {analysisResponse && (
        <>
          <p className={styles.expirationNote}>
            Esta prévia temporária fica disponível até {new Date(analysisResponse.expiresAt).toISOString().replace("T", " ").slice(0, 16)} UTC.
          </p>
          <AnalysisPreview
            analysis={analysisResponse.analysis}
            decisions={decisions}
            onDecision={decideSuggestion}
            styles={styles}
            previewTitleRef={previewTitleRef}
          />
          <PixCheckout
            sessionId={analysisResponse.sessionId}
            styles={styles}
            apiBaseUrl={apiBaseUrl}
            fetcher={fetcher}
          />
        </>
      )}
    </>
  );
}
