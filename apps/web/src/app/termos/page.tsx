import styles from "../page.module.css";

export default function TermsPage() {
  return (
    <main className={`${styles.page} ${styles.legalPage}`}>
      <a className={styles.legalBackLink} href="/">← Voltar ao Curriculus</a>
      <h1>Termos de Uso</h1>
      <p className={styles.legalDraftNotice}>
        RASCUNHO PARA REVISÃO — estes termos ainda dependem da identificação do responsável pelo serviço, da definição da política de cancelamento/reembolso e de revisão jurídica. Não são termos finais para operação pública.
      </p>

      <h2>O que o Curriculus faz</h2>
      <p>
        O Curriculus é uma ferramenta de apoio para organizar e ajustar a apresentação do currículo a uma vaga informada pela própria pessoa usuária. Não é agência de emprego, recrutador, sistema de seleção ou avaliação de candidatos e não garante entrevista, contratação ou resultado profissional.
      </p>

      <h2>Uso e revisão do conteúdo</h2>
      <ul>
        <li>Envie somente dados que tenha autorização para compartilhar. Evite dados sensíveis desnecessários e dados pessoais de terceiros.</li>
        <li>As sugestões devem se basear no currículo enviado, mas você é responsável por revisar a precisão, confirmar pontos destacados e aprovar cada alteração. É possível editar e baixar um arquivo de texto no próprio navegador; o PDF é um serviço opcional separado.</li>
        <li>Não use o serviço para tomar decisões de contratação, criar rankings ou avaliar a empregabilidade de outras pessoas.</li>
        <li>Não envie conteúdo ilícito, enganoso ou que viole direitos de terceiros.</li>
      </ul>

      <h2>Preço e pagamento</h2>
      <p>
        O preço previsto para gerar o PDF é R$ 1,99, pago via Pix quando a cobrança estiver habilitada. O PDF só pode ser gerado após confirmação do pagamento pelo servidor. A edição e o download local em texto não iniciam cobrança. A cobrança pública permanece desativada até a validação operacional, comercial, de segurança e de privacidade.
      </p>
      <p>
        A política de cancelamento e reembolso, inclusive para pagamentos aprovados e solicitações de exclusão, ainda precisa ser definida e revisada antes da operação pública. A exclusão de dados não inicia reembolso automático; registros financeiros podem ser mantidos separadamente pelo prazo legal aplicável.
      </p>

      <h2>Disponibilidade e retenção</h2>
      <p>
        Sessões sem pagamento expiram após 24 horas. Depois de gerar o PDF, currículo, vaga e análise são apagados do banco e o arquivo fica disponível por até 24 horas. Uma solicitação de exclusão antecipada tenta cancelar primeiro uma cobrança Pix pendente; se não for possível confirmar o cancelamento, a exclusão não é concluída e pode ser tentada novamente.
      </p>

      <h2>Propriedade e serviço</h2>
      <p>
        A pessoa usuária continua responsável pelo conteúdo que envia e revisa. O serviço precisa processar esse conteúdo e compartilhá-lo com os fornecedores necessários para executar as funções solicitadas, conforme a Política de Privacidade. A descrição final dos operadores, bases legais, transferências e responsabilidades está pendente de validação.
      </p>

      <h2>Responsável e questões jurídicas</h2>
      <p>
        Identificação legal, endereço, canal de atendimento, foro e demais cláusulas obrigatórias ainda precisam ser preenchidos e revisados por profissional jurídico. A utilização pública do serviço fica bloqueada até essa revisão e até a publicação de documentos finais.
      </p>
      <p><a className={styles.legalBackLink} href="/privacidade">Ler o rascunho da Política de Privacidade</a></p>
    </main>
  );
}
