# CRDT Sandbox — Quiz Builder Local-First

Prova de Conceito (PoC) de uma aplicação **local-first** utilizando **CRDTs (Yjs)** e sincronização via **WebSocket (`y-websocket`)**.

## Arquitetura

- **Backend (`/backend`)**: Node.js 20+ atuando exclusivamente como servidor de sinalização/retransmissão WebSocket em memória com `y-websocket`. Sem banco de dados e sem parse de JSON.
- **Frontend (`/frontend`)**: React + Vite + Tailwind CSS conectado via `yjs` e `y-websocket`.
- **Topologia do CRDT (`Y.Doc`)**:
  - `app-state` (`Y.Map`)
    - `quizzes` (`Y.Array<Y.Map>`)
      - `title` (`Y.Text`)
      - `questions` (`Y.Array<Y.Map>`)
        - `enunciado` (`Y.Text` — edição colaborativa caractere por caractere)
        - `alternativas` (`Y.Array<Y.Map>`)
          - `texto` (`Y.Text`)
          - `isCorrect` (`Boolean` — atualizado via `.set('isCorrect', value)`)

## Como Executar com Docker Compose

```bash
docker compose up --build
```

- **Backend (Relay y-websocket)**: `ws://localhost:1234`
- **Frontend A (Alice)**: http://localhost:3000
- **Frontend B (Bob)**: http://localhost:3001
