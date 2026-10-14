"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createFinalDocument,
  createLocalTestDocument,
  createPixPayment,
  getPixPaymentStatus,
  PaymentClientError,
  type PixPaymentApiResponse,
  type PixPaymentStatus,
  type FinalDocumentApiResponse,
} from "../lib/payment-client";

type PixCheckoutProps = {
  sessionId: string;
  localTestMode?: boolean;
  usesReferenceLayout?: boolean;
  approvedSuggestionIds: readonly string[];
  styles: Record<string, string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

export function PixCheckout({ sessionId, localTestMode = false, usesReferenceLayout = false, approvedSuggestionIds, styles, apiBaseUrl, fetcher }: PixCheckoutProps) {
  const [payerEmail, setPayerEmail] = useState("");
  const [payment, setPayment] = useState<PixPaymentApiResponse | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<PixPaymentStatus | null>(null);
  const [document, setDocument] = useState<FinalDocumentApiResponse | null>(null);
  const [message, setMessage] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const paymentTitleRef = useRef<HTMLHeadingElement>(null);
  const requestInFlight = useRef(false);

  useEffect(() => {
    if (payment) paymentTitleRef.current?.focus();
  }, [payment]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInFlight.current || payment) return;

    requestInFlight.current = true;
    setMessage("");
    setEmailError("");
    setIsCreating(true);
    try {
      const result = await createPixPayment(sessionId, payerEmail, { apiBaseUrl, fetcher });
      setPayment(result);
      setPaymentStatus(result.status);
    } catch (error) {
      const errorMessage = error instanceof PaymentClientError
        ? error.message
        : "Não foi possível gerar o Pix. Tente novamente mais tarde.";
      if (error instanceof PaymentClientError && error.code === "INVALID_EMAIL") {
        setEmailError(errorMessage);
      } else {
        setMessage(errorMessage);
      }
    } finally {
      requestInFlight.current = false;
      setIsCreating(false);
    }
  }

  async function checkPaymentStatus() {
    if (isChecking || !payment) return;
    setMessage("");
    setIsChecking(true);
    try {
      const status = await getPixPaymentStatus(sessionId, { apiBaseUrl, fetcher });
      setPaymentStatus(status);
      if (status === "approved") {
        setMessage("Pagamento confirmado. Você já pode gerar seu currículo final em PDF.");
      } else if (status === "pending") {
        setMessage("Ainda não recebemos a confirmação. Se você já pagou, tente novamente em instantes.");
      } else {
        setMessage("Esta cobrança não foi aprovada. Não é possível gerar o documento.");
      }
    } catch (error) {
      setMessage(error instanceof PaymentClientError ? error.message : "Não foi possível verificar o pagamento.");
    } finally {
      setIsChecking(false);
    }
  }

  async function generateDocument() {
    if (isGenerating || paymentStatus !== "approved" || document) return;
    setMessage("");
    setIsGenerating(true);
    try {
      const result = await createFinalDocument(sessionId, approvedSuggestionIds, { apiBaseUrl, fetcher });
      setDocument(result);
      setMessage("Seu currículo final em PDF está pronto para baixar.");
    } catch (error) {
      setMessage(error instanceof PaymentClientError ? error.message : "Não foi possível gerar o currículo.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function generateLocalTestPdf() {
    if (!localTestMode || isGenerating || document || approvedSuggestionIds.length === 0) return;
    setMessage("");
    setIsGenerating(true);
    try {
      const result = await createLocalTestDocument(sessionId, approvedSuggestionIds, { apiBaseUrl, fetcher });
      setDocument(result);
      setMessage("PDF de teste gerado. Nenhum pagamento real foi feito.");
    } catch (error) {
      setMessage(error instanceof PaymentClientError ? error.message : "Não foi possível gerar o PDF de teste.");
    } finally {
      setIsGenerating(false);
    }
  }

  const downloadUrl = document
    ? `${(apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "")}${document.downloadPath}`
    : "";
  const feedbackIsStatus = Boolean(document) ||
    (paymentStatus === "approved" && message.startsWith("Pagamento confirmado")) ||
    (paymentStatus === "pending" && message.startsWith("Ainda não recebemos"));

  if (localTestMode) {
    return (
      <section className={styles.checkoutSection} aria-labelledby="checkout-title">
        <div className={styles.checkoutHeading}>
          <span className={styles.step} aria-hidden="true">04</span>
          <div>
            <h2 id="checkout-title">PDF no ambiente de teste</h2>
            <p>Gere o documento usando apenas as sugestões que você aprovou.</p>
          </div>
        </div>
        <div className={styles.checkoutCard}>
          <p className={styles.checkoutDescription}>
            Sandbox local: a aprovação é simulada. Nenhum Pix real é criado, nenhum e-mail é enviado e nenhum pagamento é cobrado.
          </p>
          {usesReferenceLayout && <p className={styles.checkoutPrivacy}>O PDF será gerado no layout extraído do PDF que você enviou no início, usando somente as sugestões aprovadas nesta sessão.</p>}
          {!document && (
            <button
              className={styles.submitButton}
              type="button"
              onClick={generateLocalTestPdf}
              disabled={isGenerating || approvedSuggestionIds.length === 0}
            >
              {isGenerating ? "Gerando PDF de teste…" : "Gerar PDF de teste (sem cobrança)"}
            </button>
          )}
          {approvedSuggestionIds.length === 0 && !document && (
            <p className={styles.help}>Aprove ao menos uma sugestão antes de gerar o PDF de teste.</p>
          )}
          {document && (
            <p>
              <a className={styles.submitButton} href={downloadUrl} rel="noreferrer">
                Baixar currículo em PDF
              </a>
              <span className={styles.help}>
                Arquivo temporário deste ambiente de teste; disponível até {new Date(document.expiresAt).toISOString().replace("T", " ").slice(0, 16)} UTC.
              </span>
            </p>
          )}
          {(message || isGenerating) && (
            <p
              className={isGenerating || document ? styles.status : styles.errorStatus}
              role={isGenerating || document ? "status" : "alert"}
              aria-live={isGenerating || document ? "polite" : "assertive"}
            >
              {isGenerating ? "Montando o PDF no armazenamento temporário local…" : message}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.checkoutSection} aria-labelledby="checkout-title">
      <div className={styles.checkoutHeading}>
        <span className={styles.step} aria-hidden="true">04</span>
        <div>
          <h2 id="checkout-title">Se quiser, continue com o Pix</h2>
          <p>Confira o total e o que esta cobrança pretende desbloquear.</p>
        </div>
      </div>

      <div className={styles.checkoutCard}>
        <p className={styles.checkoutPrice}>
          Total <strong>R$ 1,99</strong>
        </p>
        <p className={styles.checkoutDescription}>
          Após a confirmação do pagamento, você poderá gerar um PDF com o currículo original e somente as sugestões que aprovar. O arquivo ficará disponível por 24 horas.
        </p>
        {usesReferenceLayout && <p className={styles.checkoutPrivacy}>O PDF final usará também o layout visual extraído do PDF de referência que você enviou no início; o conteúdo continuará sendo o currículo desta sessão com apenas as sugestões aprovadas.</p>}
        <p className={styles.checkoutPrivacy}>
          O e-mail é enviado ao Mercado Pago para criar a cobrança e não é gravado no Curriculus.
        </p>

        {!payment && (
          <form className={styles.checkoutForm} onSubmit={handleSubmit} noValidate aria-busy={isCreating}>
            <div className={styles.field}>
              <label htmlFor="payer-email">E-mail para o pagamento Pix</label>
              <input
                id="payer-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                maxLength={254}
                value={payerEmail}
                disabled={isCreating}
                onChange={(event) => {
                  setPayerEmail(event.target.value);
                  setMessage("");
                  setEmailError("");
                }}
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? "payer-email-help payer-email-error" : "payer-email-help"}
              />
              <p id="payer-email-help" className={styles.help}>
                Usado somente para solicitar esta cobrança ao Mercado Pago.
              </p>
              {emailError && <p className={styles.error} id="payer-email-error" role="alert">{emailError}</p>}
            </div>
            <button className={styles.submitButton} type="submit" disabled={isCreating}>
              {isCreating ? "Gerando Pix…" : "Gerar código Pix de R$ 1,99"}
            </button>
            <p className={styles.checkoutWarning}>
              Pagamentos públicos continuam desativados por padrão. Use somente um ambiente de teste.
            </p>
            {(message || isCreating) && (
              <p
                className={isCreating ? styles.status : styles.errorStatus}
                role={isCreating ? "status" : "alert"}
                aria-live={isCreating ? "polite" : "assertive"}
              >
                {isCreating ? "Solicitando a cobrança Pix…" : message}
              </p>
            )}
          </form>
        )}

        {payment && (
          <div className={styles.pixResult}>
            <h3 ref={paymentTitleRef} tabIndex={-1}>Pix gerado</h3>
            <p role="status" aria-live="polite">
              Cobrança pendente de R$ 1,99. O vencimento é {new Date(payment.expiresAt).toISOString().replace("T", " ").slice(0, 16)} UTC.
            </p>
            <img
              className={styles.pixQrImage}
              src={`data:image/png;base64,${payment.qrCodeBase64}`}
              alt="QR Code Pix de R$ 1,99"
              width="240"
              height="240"
            />
            <label className={styles.pixCodeLabel} htmlFor="pix-copy-code">Código Pix copia e cola</label>
            <textarea
              id="pix-copy-code"
              className={styles.pixCode}
              readOnly
              rows={4}
              value={payment.qrCode}
            />
            {paymentStatus !== "approved" && (
              <button className={styles.submitButton} type="button" onClick={checkPaymentStatus} disabled={isChecking}>
                {isChecking ? "Verificando pagamento…" : "Verificar pagamento"}
              </button>
            )}
            {paymentStatus === "approved" && !document && (
              <button className={styles.submitButton} type="button" onClick={generateDocument} disabled={isGenerating}>
                {isGenerating ? "Gerando PDF…" : "Gerar currículo final em PDF"}
              </button>
            )}
            {document && (
              <p>
                <a className={styles.submitButton} href={downloadUrl} rel="noreferrer">
                  Baixar currículo em PDF
                </a>
                <span className={styles.help}>
                  Disponível até {new Date(document.expiresAt).toISOString().replace("T", " ").slice(0, 16)} UTC.
                </span>
              </p>
            )}
            {(message || isChecking || isGenerating) && (
              <p
                className={isChecking || isGenerating || feedbackIsStatus ? styles.status : styles.errorStatus}
                role={isChecking || isGenerating || feedbackIsStatus ? "status" : "alert"}
                aria-live={isChecking || isGenerating || feedbackIsStatus ? "polite" : "assertive"}
              >
                {isChecking ? "Consultando a confirmação do Mercado Pago…" : isGenerating ? "Montando o PDF a partir da análise existente…" : message}
              </p>
            )}
            <p className={styles.checkoutWarning}>
              A confirmação depende do webhook do Mercado Pago. Pagamentos públicos seguem desativados até a validação operacional; a geração usa a análise existente, sem nova chamada à IA.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
