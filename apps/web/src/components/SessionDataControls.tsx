"use client";

import React, { useState } from "react";
import { deleteSessionData, PrivacyRequestError } from "../lib/privacy-client";

type SessionDataControlsProps = {
  sessionId: string;
  styles: Record<string, string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  onDeleted: () => void;
};

export function SessionDataControls({
  sessionId,
  styles,
  apiBaseUrl,
  fetcher,
  onDeleted,
}: SessionDataControlsProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");

  async function confirmDeletion() {
    if (isDeleting) return;
    setError("");
    setIsDeleting(true);
    let deleted = false;
    try {
      await deleteSessionData(sessionId, { apiBaseUrl, fetcher });
      deleted = true;
      setIsDeleting(false);
      onDeleted();
    } catch (requestError) {
      setError(
        requestError instanceof PrivacyRequestError
          ? requestError.message
          : "Não foi possível concluir a exclusão. Tente novamente.",
      );
    } finally {
      if (!deleted) setIsDeleting(false);
    }
  }

  return (
    <section className={styles.dataDeletion} aria-labelledby="data-deletion-title">
      {!isConfirming ? (
        <button
          className={styles.dataDeletionTrigger}
          type="button"
          onClick={() => setIsConfirming(true)}
        >
          Excluir os dados desta sessão
        </button>
      ) : (
        <div className={styles.dataDeletionConfirmation} role="group" aria-labelledby="data-deletion-title">
          <h3 id="data-deletion-title">Confirmar exclusão desta sessão?</h3>
          <p>
            O currículo, a vaga, a análise e qualquer PDF desta sessão serão removidos. Se houver um Pix pendente,
            tentaremos cancelá-lo primeiro; se o cancelamento falhar, os dados não serão apagados e você poderá tentar novamente.
            Cobranças aprovadas não recebem reembolso automático, e seus metadados financeiros podem precisar ser mantidos
            pelo prazo legal aplicável.
          </p>
          {error && <p className={styles.dataDeletionError} role="alert">{error}</p>}
          <div className={styles.dataDeletionActions}>
            <button type="button" onClick={confirmDeletion} disabled={isDeleting}>
              {isDeleting ? "Excluindo dados…" : "Confirmar exclusão"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsConfirming(false);
                setError("");
              }}
              disabled={isDeleting}
            >
              Manter meus dados
            </button>
          </div>
          {isDeleting && <p className={styles.status} role="status">Processando exclusão segura…</p>}
        </div>
      )}
    </section>
  );
}
