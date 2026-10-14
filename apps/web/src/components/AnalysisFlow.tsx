"use client";

import React, { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AnalysisClientError,
  requestAnalysis,
  approvedSuggestionIds,
  updateSuggestionDecision,
  type AnalysisApiResponse,
  type SuggestionDecision,
  type SuggestionDecisions,
} from "../lib/analysis-client";
import { validateIntake, type IntakeInput } from "../lib/intake";
import { AnalysisPreview } from "./AnalysisPreview";
import { FinalResumeEditor } from "./FinalResumeEditor";
import { PixCheckout } from "./PixCheckout";
import { SessionDataControls } from "./SessionDataControls";
import {
  deleteImportedLayout,
  importReferencePdf,
  ResumeLayoutClientError,
  type ResumeLayoutImportResponse,
} from "../lib/resume-layout-client";

type SelectedLayoutReference = { templateId: string };
type ResumeSource = "manual" | "pdf_pending" | "pdf_imported";

type AnalysisFlowProps = {
  styles: Record<string, string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

const emptyForm: IntakeInput = {
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
  const [finalResumeText, setFinalResumeText] = useState("");
  const [finalResumeAppliedSuggestionIds, setFinalResumeAppliedSuggestionIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState(false);
  const [isReadingPdf, setIsReadingPdf] = useState(false);
  const [resumePdfError, setResumePdfError] = useState("");
  const [resumePdfName, setResumePdfName] = useState("");
  const [resumePdfFile, setResumePdfFile] = useState<File | null>(null);
  const [resumeSource, setResumeSource] = useState<ResumeSource>("manual");
  const [layoutReference, setLayoutReference] = useState<SelectedLayoutReference | null>(null);
  const [layoutNotice, setLayoutNotice] = useState("");
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
    setFinalResumeText("");
    setFinalResumeAppliedSuggestionIds([]);
    setDeletionNotice(false);
    setResumePdfError("");
  }

  async function handleResumePdfChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setResumePdfError("");
    setResumePdfName("");
    setLayoutNotice("");
    setResumePdfFile(file);
    setResumeSource("pdf_pending");
    setResumePdfName(file.name);
    const previousLayout = layoutReference;
    setLayoutReference(null);
    if (previousLayout) {
      await deleteImportedLayout(previousLayout.templateId, { apiBaseUrl, fetcher }).catch(() => undefined);
    }
    setErrors({});
    setMessage("");
    setAnalysisResponse(null);
    setDecisions({});
    setFinalResumeText("");
    setFinalResumeAppliedSuggestionIds([]);
    setDeletionNotice(false);
  }

  function updateResumeText(value: string) {
    if (resumeSource === "pdf_pending") {
      const previousLayout = layoutReference;
      if (previousLayout) void deleteImportedLayout(previousLayout.templateId, { apiBaseUrl, fetcher }).catch(() => undefined);
      setResumePdfFile(null);
      setResumePdfName("");
      setResumeSource("manual");
      setLayoutReference(null);
      setResumePdfError("");
      setLayoutNotice("O PDF não foi processado; o currículo colado será usado com um formato simples.");
    }
    updateForm("resume", value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const hasPendingPdf = resumeSource === "pdf_pending" && resumePdfFile !== null;
    const validationErrors = validateIntake(form, { resumePdfSelected: hasPendingPdf });
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
      let resume = form.resume.trim();
      let templateId = layoutReference?.templateId;
      if (hasPendingPdf && resumePdfFile) {
        setIsReadingPdf(true);
        setResumePdfError("");
        const imported: ResumeLayoutImportResponse = await importReferencePdf(resumePdfFile, { apiBaseUrl, fetcher });
        resume = imported.resumeText;
        setForm((current) => ({ ...current, resume }));
        setResumeSource("pdf_imported");
        setResumePdfFile(null);
        if (imported.layoutAvailable && imported.templateId) {
          templateId = imported.templateId;
          setLayoutReference({ templateId });
          setLayoutNotice("Extraímos o currículo. O PDF final tentará preservar o estilo visual original.");
        } else {
          templateId = undefined;
          setLayoutReference(null);
          setLayoutNotice("Extraímos o conteúdo, mas não foi possível reaplicar o estilo visual deste PDF. O PDF final usará um formato simples.");
        }
      }
      const analysisInput = { ...form, resume };
      const finalValidationErrors = validateIntake(analysisInput);
      if (Object.keys(finalValidationErrors).length > 0) {
        setErrors(finalValidationErrors);
        setMessage("Revise os campos indicados antes de continuar.");
        return;
      }

      const requestOptions = { apiBaseUrl, fetcher, ...(templateId ? { resumeLayoutTemplateId: templateId } : {}) };
      let response: AnalysisApiResponse;
      try {
        response = await requestAnalysis(analysisInput, requestOptions);
      } catch (error) {
        if (
          !(error instanceof AnalysisClientError) ||
          !["TEMPLATE_EXPIRED", "LAYOUT_IMPORT_NOT_AVAILABLE"].includes(error.code) ||
          !templateId
        ) throw error;
        setLayoutReference(null);
        setLayoutNotice("O estilo visual expirou antes da análise. Continuaremos sem ele, sem pedir que você envie o PDF novamente.");
        response = await requestAnalysis(analysisInput, { apiBaseUrl, fetcher });
      }
      setFinalResumeText(resume);
      setFinalResumeAppliedSuggestionIds([]);
      setAnalysisResponse(response);
    } catch (error) {
      if (error instanceof ResumeLayoutClientError) {
        setResumePdfError(error.message);
      } else {
        setMessage(error instanceof AnalysisClientError
          ? error.message
          : "Não foi possível concluir a análise. Tente novamente mais tarde.");
      }
    } finally {
      setIsSubmitting(false);
      setIsReadingPdf(false);
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
    setFinalResumeText("");
    setFinalResumeAppliedSuggestionIds([]);
    setResumePdfFile(null);
    setResumeSource("manual");
    setResumePdfName("");
    if (layoutReference) void deleteImportedLayout(layoutReference.templateId, { apiBaseUrl, fetcher }).catch(() => undefined);
    setLayoutReference(null);
    setLayoutNotice("");
    setDeletionNotice(true);
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
            <h2 id="form-title">Adapte seu currículo à vaga</h2>
            <p>Envie seu currículo em PDF e cole os requisitos da oportunidade. Você revisa cada sugestão antes de gerar o PDF final.</p>
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
            <label htmlFor="resume-pdf">Seu currículo em PDF <span>(recomendado)</span></label>
            <input
              id="resume-pdf"
              type="file"
              accept=".pdf,application/pdf"
              disabled={isSubmitting || isReadingPdf}
              aria-describedby="resume-pdf-help"
              onChange={handleResumePdfChange}
            />
            <p className={styles.help} id="resume-pdf-help">
              PDF de até 10 MiB e 30 páginas. Depois que você confirmar abaixo e iniciar a análise, nosso serviço extrairá o texto e o estilo visual em uma só leitura. PDFs digitalizados como imagem não são compatíveis.
            </p>
            {resumePdfName && (
              <p className={styles.help} role="status">
                {resumeSource === "pdf_pending" ? `Arquivo selecionado: ${resumePdfName}.` : `Texto extraído de ${resumePdfName}. Você pode revisar o conteúdo abaixo.`}
              </p>
            )}
            {resumePdfError && (
              <div className={styles.layoutReferenceError} role="alert">
                <p>{resumePdfError}</p>
                <p>Você pode tentar novamente ou colar o currículo em texto abaixo para continuar.</p>
                {form.resume.trim() && resumeSource === "pdf_pending" && (
                  <button
                    className={styles.layoutReferenceButton}
                    type="button"
                    onClick={() => {
                      setResumePdfFile(null);
                      setResumePdfName("");
                      setResumeSource("manual");
                      setResumePdfError("");
                      setLayoutNotice("Continuaremos com o currículo colado e um formato visual simples.");
                    }}
                  >
                    Continuar com o currículo colado
                  </button>
                )}
              </div>
            )}
            {layoutNotice && <p className={styles.status} role="status">{layoutNotice}</p>}
            <label htmlFor="resume">
              {resumeSource === "pdf_imported" ? "Texto extraído do currículo (você pode revisar)" : "Ou cole o currículo em texto"}
            </label>
            <textarea
              id="resume"
              rows={9}
              placeholder={resumeSource === "pdf_pending" ? "O texto do PDF aparecerá aqui depois que você iniciar a análise. Também pode colar o currículo manualmente." : "Cole aqui o conteúdo do seu currículo..."}
              value={form.resume}
              disabled={isSubmitting || isReadingPdf}
              onChange={(event) => updateResumeText(event.target.value)}
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
                Currículo e descrição da vaga são usados para gerar sugestões, não para avaliar sua empregabilidade. Após sua confirmação, o PDF é enviado à API do Curriculus e processado em memória uma única vez para extrair texto e estilo; o arquivo original não é armazenado nem enviado ao modelo de IA. O texto segue para análise e o estilo visual compatível fica associado à sessão até gerar o PDF ou a expiração. Ao solicitar o PDF final, o texto revisado no editor é enviado à API para montagem e armazenamento privado temporário; sugestões de IA entram quando aprovadas e aplicadas. Fotos incorporadas ao PDF de referência não são reutilizadas. Sessões sem pagamento expiram em 24 horas; após gerar um PDF, currículo, vaga e análise são apagados e o arquivo expira em outras 24 horas. Você também pode pedir a exclusão antecipada abaixo.
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
              Li o aviso e autorizo o processamento do PDF e dos textos para esta análise. Confirmo que não incluí informações sensíveis desnecessárias ou dados de terceiros.
            </label>
          </div>
          {errors.acknowledged && (
            <p className={styles.error} id="acknowledgement-error">{errors.acknowledged}</p>
          )}

          <button className={styles.submitButton} type="submit" disabled={isSubmitting || isReadingPdf}>
            {isReadingPdf ? "Lendo currículo…" : isSubmitting ? "Analisando…" : "Gerar sugestões"} <span aria-hidden="true">→</span>
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
            onDraftChange={(text, appliedIds) => {
              setFinalResumeText(text);
              setFinalResumeAppliedSuggestionIds([...appliedIds]);
            }}
          />
          <PixCheckout
            sessionId={analysisResponse.sessionId}
            localTestMode={analysisResponse.localTestMode === true}
            usesReferenceLayout={analysisResponse.usesReferenceLayout === true}
            approvedSuggestionIds={approvedSuggestionIds(analysisResponse.analysis, decisions)}
            finalResumeText={finalResumeText}
            finalResumeAppliedSuggestionIds={finalResumeAppliedSuggestionIds}
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
