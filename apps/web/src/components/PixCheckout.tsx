"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createPixPayment,
  PaymentClientError,
  type PixPaymentApiResponse,
} from "../lib/payment-client";

type PixCheckoutProps = {
  sessionId: string;
  styles: Record<string, string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

export function PixCheckout({ sessionId, styles, apiBaseUrl, fetcher }: PixCheckoutProps) {
  const [payerEmail, setPayerEmail] = useState("");
  const [payment, setPayment] = useState<PixPaymentApiResponse | null>(null);
  const [message, setMessage] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
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

  return (
    <section className={styles.checkoutSection} aria-labelledby="checkout-title">
      <div className={styles.checkoutHeading}>
        <span className={styles.step} aria-hidden="true">03</span>
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
          A cobrança se refere à geração futura do currículo com as sugestões que você aprovar. O pagamento pode ser confirmado automaticamente pelo webhook, mas a geração e a liberação do documento ainda não estão implementadas.
        </p>
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
              Não use cobranças em ambiente público: a integração permanece desativada por padrão e a entrega do documento ainda não está disponível.
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
            <p className={styles.checkoutWarning}>
              Pague somente em ambiente de teste. O webhook pode confirmar a cobrança, mas não haverá liberação do documento nesta versão.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
