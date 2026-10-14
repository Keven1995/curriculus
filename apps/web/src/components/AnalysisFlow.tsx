"use client";

import React, { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AnalysisClientError,
  requestAnalysis,
  updateSuggestionDecision,
  type AnalysisApiResponse,
  type SuggestionDecision,
  type SuggestionDecisions,
} from "../lib/analysis-client";
import { validateIntake, type IntakeInput } from "../lib/intake";
import { extractResumeTextFromPdf, ResumePdfError } from "../lib/resume-pdf";
import { AnalysisPreview } from "./AnalysisPreview";
import { FinalResumeEditor } from "./FinalResumeEditor";
import { PixCheckout } from "./PixCheckout";
import { SessionDataControls } from "./SessionDataControls";
import {
  deleteImportedLayout,
  importReferencePdf,
  isResumeLayoutFeatureEnabled,
  ResumeLayoutClientError,
  type ResumeLayoutImportResponse,
} from "../lib/resume-layout-client";

type SelectedLayoutReference = Pick<ResumeLayoutImportResponse, "templateId" | "template">;

type AnalysisFlowProps = {
  styles: Record<string, string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  pdfTextExtractor?: typeof extractResumeTextFromPdf;
};

const emptyForm: IntakeInput = {
  jobDescription: "",
  resume: "",
  acknowledged: false,
};

export function AnalysisFlow({ styles, apiBaseUrl, fetcher, pdfTextExtractor }: AnalysisFlowProps) {
  const [form, setForm] = useState<IntakeInput>(emptyForm);
  const [errors, setErrors] = useState<ReturnType<typeof validateIntake>>({});
  const [message, setMessage] = useState("");
  const [analysisResponse, setAnalysisResponse] = useState<AnalysisApiResponse | null>(null);
  const [decisions, setDecisions] = useState<SuggestionDecisions>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState(false);
  const [isReadingPdf, setIsReadingPdf] = useState(false);
  const [resumePdfError, setResumePdfError] = useState("");
  const [resumePdfName, setResumePdfName] = useState("");
  const [layoutFeatureEnabled, setLayoutFeatureEnabled] = useState(false);
  const [layoutReference, setLayoutReference] = useState<SelectedLayoutReference | null>(null);
  const [layoutImportError, setLayoutImportError] = useState("");
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
    setDeletionNotice(false);
    setResumePdfError("");
  }

  async function handleResumePdfChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setResumePdfError("");
    setResumePdfName("");
    setLayoutImportError("");
    setIsReadingPdf(true);
    const previousLayout = layoutReference;
    setLayoutReference(null);
    if (previousLayout) {
      await deleteImportedLayout(previousLayout.templateId, { apiBaseUrl, fetcher }).catch(() => undefined);
    }
    try {
      const text = await (pdfTextExtractor ?? extractResumeTextFromPdf)(file);
      setForm((current) => ({ ...current, resume: text }));
      setErrors((current) => ({ ...current, resume: undefined }));
      setMessage("");
      setAnalysisResponse(null);
      setDecisions({});
      setDeletionNotice(false);
      setResumePdfName(file.name);
      let canPreserveLayout = layoutFeatureEnabled;
      if (!canPreserveLayout) {
        canPreserveLayout = await isResumeLayoutFeatureEnabled({ apiBaseUrl, fetcher });
        setLayoutFeatureEnabled(canPreserveLayout);
      }
      if (canPreserveLayout) {
        try {
          const imported = await importReferencePdf(file, { apiBaseUrl, fetcher });
          setLayoutReference({ templateId: imported.templateId, template: imported.template });
          setLayoutImportError("");
        } catch (error) {
          setLayoutImportError(error instanceof ResumeLayoutClientError
            ? error.message
            : "Não foi possível importar o visual do PDF. Você pode tentar novamente ou continuar sem o layout.");
        }
      }
    } catch (error) {
      setResumePdfError(error instanceof ResumePdfError
        ? error.message
        : "Não foi possível ler o PDF. Confira o arquivo e tente novamente.");
    } finally {
      setIsReadingPdf(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    if (layoutImportError) {
      setMessage("O layout do PDF ainda não foi importado. Tente novamente com o arquivo ou escolha continuar sem layout.");
      return;
    }
    const validationErrors = validateIntake(form);
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
      const response = await requestAnalysis(form, {
        apiBaseUrl,
        fetcher,
        ...(layoutReference ? { resumeLayoutTemplateId: layoutReference.templateId } : {}),
      });
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

  function handleSessionDeleted() {
    setForm(emptyForm);
    setErrors({});
    setMessage("");
    setAnalysisResponse(null);
    setDecisions({});
    if (layoutReference) void deleteImportedLayout(layoutReference.templateId, { apiBaseUrl, fetcher }).catch(() => undefined);
    setLayoutReference(null);
    setLayoutImportError("");
    setResumePdfName("");
    setDeletionNotice(true);
  }

  function continueWithoutLayout() {
    if (layoutReference) void deleteImportedLayout(layoutReference.templateId, { apiBaseUrl, fetcher }).catch(() => undefined);
    setLayoutReference(null);
    setLayoutImportError("");
    setMessage("A análise continuará sem reaplicar o visual do PDF de referência.");
  }

  return (
    <>
      {deletionNotice && (
        <p className={styles.deletionNotice} role="status" aria-live="polite">
          Os dados desta sessão foram removidos. Os metadados financeiros, quando existentes, são mantidos separadamente conforme as obrigações aplicáveis.
        </p>
      )}
      <section className={styles.formSection} aria-labelledby="form-title">
        <div className={styles.sectionHeading}>
          <span className={styles.step} aria-hidden="true">01</span>
          <div>
            <h2 id="form-title">Vamos começar pelo contexto</h2>
            <p>Compare o currículo com a vaga e receba também sugestões de ortografia e gramática do português brasileiro.</p>
          </div>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate aria-busy={isSubmitting || isReadingPdf}>
          <div className={styles.field}>
            <label htmlFor="job-description">Descrição da vaga</label>
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
            <label htmlFor="resume-pdf">Anexar currículo em PDF <span>(opcional)</span></label>
            <input
              id="resume-pdf"
              type="file"
              accept=".pdf,application/pdf"
              disabled={isSubmitting || isReadingPdf}
              aria-describedby="resume-pdf-help"
              onChange={handleResumePdfChange}
            />
            <p className={styles.help} id="resume-pdf-help">
              PDF textual de até 10 MiB e 30 páginas. A leitura acontece neste navegador; somente o texto extraído é enviado para análise. PDFs digitalizados como imagem não são compatíveis.
            </p>
            {isReadingPdf && <p className={styles.status} role="status">Lendo o texto do PDF neste navegador…</p>}
            {resumePdfName && !isReadingPdf && (
              <p className={styles.help} role="status">Texto extraído de {resumePdfName}. Revise ou edite abaixo antes de continuar.</p>
            )}
            {resumePdfError && <p className={styles.error} role="alert">{resumePdfError}</p>}
            {layoutReference && (
              <div className={styles.layoutReferenceNotice}>
                <strong>Layout vinculado ao PDF final</strong>
                <p>
                  O PDF gerado após a revisão usará a sidebar {layoutReference.template.palette.sidebar} e o cabeçalho {layoutReference.template.palette.headerApprox}.
                  {" "}Detecção aproximada ({Math.round(layoutReference.template.detection.confidence * 100)}%). O conteúdo virá do currículo desta sessão; fotos incorporadas ao PDF não são copiadas.
                </p>
                <button className={styles.layoutReferenceButton} type="button" onClick={continueWithoutLayout}>
                  Remover layout de referência
                </button>
              </div>
            )}
            {layoutImportError && (
              <div className={styles.layoutReferenceError} role="alert">
                <p>O texto foi lido, mas o visual do PDF não foi importado: {layoutImportError}</p>
                <button className={styles.layoutReferenceButton} type="button" onClick={continueWithoutLayout}>
                  Continuar sem layout de referência
                </button>
              </div>
            )}
            {resumePdfName && !layoutFeatureEnabled && !layoutReference && (
              <p className={styles.help} role="status">
                Neste ambiente, o PDF é usado para extrair texto. A preservação do visual está disponível no teste local (`npm run dev:local-test`).
              </p>
            )}
            <textarea
              id="resume"
              rows={9}
              placeholder="O texto extraído do PDF aparecerá aqui; você também pode colar ou editar seu currículo..."
              value={form.resume}
              disabled={isSubmitting || isReadingPdf}
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
                Currículo e descrição da vaga são usados para gerar sugestões, não para avaliar sua empregabilidade. O texto do PDF é extraído neste navegador e enviado à análise. No teste local, o PDF original também é enviado somente à API local para extrair o visual do PDF final; o arquivo não é guardado em disco. O layout fornece apenas estilo; o conteúdo do PDF final vem do currículo desta sessão e somente as sugestões aprovadas são aplicadas. Fotos incorporadas ao PDF de referência não são reutilizadas. Sessões sem pagamento expiram em 24 horas; após gerar um PDF, currículo, vaga e análise são apagados e o arquivo expira em outras 24 horas. Você também pode pedir a exclusão antecipada abaixo.
              </p>
              <p className={styles.prototypeNote}>
                Consulte os <a href="/privacidade">rascunhos da Política de Privacidade</a> e dos <a href="/termos">Termos de Uso</a>. Eles ainda precisam de revisão jurídica e validação dos fornecedores antes de uso público.
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

          <button className={styles.submitButton} type="submit" disabled={isSubmitting || isReadingPdf || Boolean(layoutImportError)}>
            {isReadingPdf ? "Lendo PDF…" : isSubmitting ? "Analisando…" : "Gerar sugestões"} <span aria-hidden="true">→</span>
          </button>
          <p className={styles.submitNote}>
            Você revisa cada sugestão, inclusive as correções de escrita. Depois, pode editar e baixar o currículo em texto sem cobrança; o PDF pago é opcional.
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
          <FinalResumeEditor
            key={analysisResponse.sessionId}
            originalResume={form.resume.trim()}
            analysis={analysisResponse.analysis}
            decisions={decisions}
            styles={styles}
          />
          <PixCheckout
            sessionId={analysisResponse.sessionId}
            localTestMode={analysisResponse.localTestMode === true}
            usesReferenceLayout={analysisResponse.usesReferenceLayout === true}
            approvedSuggestionIds={Object.entries(decisions)
              .filter(([, decision]) => decision === "approved")
              .map(([id]) => id)}
            styles={styles}
            apiBaseUrl={apiBaseUrl}
            fetcher={fetcher}
          />
          <SessionDataControls
            sessionId={analysisResponse.sessionId}
            styles={styles}
            apiBaseUrl={apiBaseUrl}
            fetcher={fetcher}
            onDeleted={handleSessionDeleted}
          />
        </>
      )}
    </>
  );
}
