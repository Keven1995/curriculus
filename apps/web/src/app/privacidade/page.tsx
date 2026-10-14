import styles from "../page.module.css";

export default function PrivacyPage() {
  return (
    <main className={`${styles.page} ${styles.legalPage}`}>
      <a className={styles.legalBackLink} href="/">← Voltar ao Curriculus</a>
      <h1>Privacidade e dados pessoais</h1>
      <p className={styles.legalDraftNotice}>
        RASCUNHO PARA REVISÃO — esta página ainda não identifica o controlador, não define a base legal final e não foi validada juridicamente nem com os fornecedores. Não publicar nem habilitar pagamentos públicos antes de concluir essas revisões.
      </p>

      <h2>Quem é responsável pelo tratamento?</h2>
      <p>
        A pessoa jurídica ou física controladora do Curriculus, seu endereço e o canal de privacidade ainda precisam ser identificados antes da publicação. O contato do encarregado, quando aplicável, também deve ser confirmado. Este rascunho não substitui essas informações.
      </p>

      <h2>Quais dados e para quais finalidades?</h2>
      <ul>
        <li>Texto do currículo e descrição da vaga colada pela pessoa usuária para comparar requisitos e criar sugestões solicitadas.</li>
        <li>Após a confirmação, o PDF de referência é enviado à API do Curriculus e processado em memória numa só leitura para extrair texto e evidências visuais. O arquivo original não é gravado em disco nem enviado ao modelo; o texto extraído segue para o provedor de IA configurado. O estilo visual compatível fica associado à sessão até gerar o PDF final ou expirar.</li>
        <li>O PDF final usa o texto revisado no editor, incluindo edições manuais e sugestões de IA aprovadas e aplicadas. Ao solicitar o PDF, esse texto é enviado à API para geração; o backend valida o tamanho, a sessão, as sugestões e a aprovação do pagamento. No modo local, a aprovação é simulada. O layout visual pode vir do template associado; texto e fotos do PDF de referência não são copiados, e fotos incorporadas não são reutilizadas.</li>
        <li>Análise estruturada para mostrar a prévia e, após autorização do fluxo de pagamento, montar o PDF solicitado. As decisões de aprovação ficam no navegador e os IDs aprovados são validados pelo servidor. O currículo em texto (.txt) continua sendo montado localmente e não é enviado de volta ao Curriculus.</li>
        <li>E-mail informado no checkout, transmitido ao Mercado Pago para solicitar a cobrança e não persistido pelo Curriculus.</li>
        <li>Identificador do pedido, identificador do pagamento, valor, moeda e estado financeiro para processar e reconciliar a cobrança. O prazo de retenção desses registros está pendente de validação jurídica.</li>
      </ul>
      <p>
        O Curriculus não se destina a avaliar empregabilidade, classificar candidatos, selecionar pessoas, garantir entrevista ou decisão de contratação. Não venda os dados nem use o conteúdo para treinar modelos. Evite enviar dados sensíveis e informações de terceiros.
      </p>

      <h2>Base legal</h2>
      <p>
        A base legal deve ser definida por finalidade com orientação jurídica, sem consentimento genérico. A execução do serviço solicitado é uma hipótese a avaliar para currículo, vaga e análise; obrigações legais ou regulatórias podem se aplicar aos registros financeiros. Essas hipóteses não são uma conclusão jurídica e precisam ser confirmadas pelo controlador antes do lançamento.
      </p>

      <h2>Fornecedores e transferências</h2>
      <p>
        A arquitetura prevista utiliza o provedor de IA configurado no ambiente para processar a análise, Neon para banco de dados, Render para a API, Vercel para a aplicação web e Mercado Pago para pagamentos. A participação efetiva de cada fornecedor, seus subprocessadores, contratos, regiões de processamento e eventual transferência internacional precisam ser confirmados para o ambiente de produção. O mecanismo legal de transferência, quando necessário, também está pendente de avaliação.
      </p>

      <h2>Retenção e exclusão</h2>
      <ul>
        <li>Sem pagamento: currículo, vaga e análise expiram 24 horas após a criação da sessão.</li>
        <li>Após gerar o documento pago: currículo, vaga e análise são removidos do banco; o PDF fica disponível em armazenamento privado por até 24 horas.</li>
        <li>Extrações temporárias não associadas a uma sessão ficam em memória por até 30 minutos. O estilo visual associado segue o prazo da sessão, de até 24 horas, e é removido ao gerar o PDF final ou excluir a sessão. O PDF solicitado fica em armazenamento privado por até 24 horas (no teste local, até o encerramento do servidor).</li>
        <li>A pessoa pode solicitar a exclusão antecipada pelo controle “Excluir os dados desta sessão”. Se houver Pix pendente, o serviço tenta cancelá-lo antes; se não conseguir confirmar o cancelamento, não apaga a sessão e solicita uma nova tentativa.</li>
        <li>Pedidos e metadados financeiros ficam separados do conteúdo curricular e podem ser mantidos pelo prazo legal aplicável. O prazo exato, cópias de segurança e ciclo de retenção dos fornecedores ainda precisam ser documentados.</li>
      </ul>

      <h2>Direitos e canal de atendimento</h2>
      <p>
        A pessoa titular pode solicitar confirmação, acesso, correção, informação sobre compartilhamentos e demais direitos aplicáveis. O canal e os dados do controlador/encarregado ainda precisam ser informados antes da publicação. A exclusão técnica desta sessão está disponível na própria interface, observada a preservação separada de registros financeiros exigidos por lei.
      </p>

      <h2>Revisão antes do lançamento</h2>
      <p>
        Confirmar a identidade e o contato do controlador, bases legais por finalidade, contratos e instruções aos operadores, subprocessadores, regiões, transferências internacionais, retenção financeira e de backups, e revisar este texto com profissional jurídico e de privacidade.
      </p>
      <p><a className={styles.legalBackLink} href="/termos">Ler o rascunho dos Termos de Uso</a></p>
    </main>
  );
}
