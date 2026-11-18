# CRDT Sandbox

Repositório desenvolvido para os **Trabalhos 5 e 6 da disciplina de Sistemas Distribuídos (2026)**, com o objetivo de demonstrar na prática o funcionamento de **CRDTs (*Conflict-free Replicated Data Types*)** e aplicações **local-first** utilizando a biblioteca **Yjs** para edição colaborativa em tempo real e suporte a operações offline.

---

## Arquitetura (3 Nós em Rede)

O sistema é composto por 3 contêineres comunicando-se via rede:

1. **`backend` (Porta `1234`)**: Servidor de sinalização/retransmissão WebSocket em Node.js (`y-websocket`) sem banco de dados. Apenas retransmite os vetores de estado binários do Yjs em memória.
2. **`alice` (Porta `3000`)**: Instância React representando o cliente **Alice**.
3. **`bob` (Porta `3001`)**: Instância React representando o cliente **Bob**.

---

## Como Executar

Certifique-se de ter o **Docker** e o **Docker Compose** instalados. Na raiz do projeto, execute:

```bash
docker compose up --build
```

Após a inicialização, abra duas janelas do navegador lado a lado:

- **Alice:** http://localhost:3000
- **Bob:** http://localhost:3001

---

## Tutorial de Uso e Simulação de Falha (Partição de Rede)

### 1. Cenário Normal (Sincronização em Tempo Real)
1. Com **Alice** e **Bob** abertos e com o indicador **Conectado** (verde), digite no título do quiz ou no enunciado de qualquer questão em uma das janelas.
2. Observe que cada caractere digitado e cada marcação de alternativa correta (`Correta`/`Incorreta`) aparece instantaneamente na outra janela.

### 2. Cenário de Falha (Partição de Rede e Edição Concorrente Offline)
Para simular uma queda de rede ou partição entre os nós sem interromper a aplicação (*local-first*):

1. Na janela da **Alice** (`localhost:3000`), clique no botão **Desconectar** no canto superior direito.
   - O indicador mudará para **Desconectado** (vermelho) e um aviso de modo offline aparecerá.
2. **Enquanto desconectada**, faça alterações na **Alice**:
   - Edite o **início** do enunciado de uma questão;
   - Adicione uma nova alternativa ou altere uma existente.
3. Simultaneamente, na janela do **Bob** (`localhost:3001`, ainda conectado):
   - Edite o **final** do mesmo enunciado;
   - Marque ou desmarque uma alternativa como correta, ou adicione uma nova questão.
4. **Recuperação da Falha:** Volte na janela da **Alice** e clique em **Conectar**.
5. **Resultado Esperado:**
   - Os nós trocam automaticamente seus vetores de estado (*State Vectors*) via WebSocket;
   - As alterações concorrentes feitas no mesmo texto por Alice e Bob são mescladas caractere por caractere **sem perda de dados e sem conflitos**, convergindo ambas as telas para exatamente o mesmo estado final.
