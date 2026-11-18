import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:1234';
const ROOM_NAME = import.meta.env.VITE_ROOM_NAME || 'crdt-sandbox-room';
const INSTANCE_NAME = import.meta.env.VITE_INSTANCE_NAME || 'Local Peer';

/**
 * Aplica a diferença mínima (diff por prefixo/sufixo comum) em uma instância Y.Text.
 * Isso garante operações CRDT reais caractere por caractere (ytext.insert / ytext.delete)
 * em vez de sobrescrever a string inteira, preservando edições concorrentes offline.
 */
function applyYTextDiff(ydoc, ytext, nextValue) {
  if (!ytext) return;
  const prevValue = ytext.toString();
  if (prevValue === nextValue) return;

  let start = 0;
  while (
    start < prevValue.length &&
    start < nextValue.length &&
    prevValue[start] === nextValue[start]
  ) {
    start++;
  }

  let prevEnd = prevValue.length;
  let nextEnd = nextValue.length;

  while (
    prevEnd > start &&
    nextEnd > start &&
    prevValue[prevEnd - 1] === nextValue[nextEnd - 1]
  ) {
    prevEnd--;
    nextEnd--;
  }

  const deleteCount = prevEnd - start;
  const insertText = nextValue.slice(start, nextEnd);

  ydoc.transact(() => {
    if (deleteCount > 0) {
      ytext.delete(start, deleteCount);
    }
    if (insertText.length > 0) {
      ytext.insert(start, insertText);
    }
  });
}

/**
 * Factory helpers para criar nós CRDT (Y.Map, Y.Array, Y.Text)
 * antes de inseri-los na árvore do documento Yjs.
 */
function createAlternativeYMap(textoInicial = '', isCorrect = false) {
  const altMap = new Y.Map();
  const textoYText = new Y.Text();
  if (textoInicial) {
    textoYText.insert(0, textoInicial);
  }
  altMap.set('id', crypto.randomUUID());
  altMap.set('texto', textoYText);
  altMap.set('isCorrect', Boolean(isCorrect));
  return altMap;
}

function createQuestionYMap(
  enunciadoInicial = 'Nova questão colaborativa...',
  alternativasIniciais = [
    { texto: 'Alternativa A', isCorrect: true },
    { texto: 'Alternativa B', isCorrect: false },
  ]
) {
  const questionMap = new Y.Map();
  const enunciadoYText = new Y.Text();
  if (enunciadoInicial) {
    enunciadoYText.insert(0, enunciadoInicial);
  }

  const alternativasYArray = new Y.Array();
  const altMaps = alternativasIniciais.map((alt) =>
    createAlternativeYMap(alt.texto, alt.isCorrect)
  );
  if (altMaps.length > 0) {
    alternativasYArray.insert(0, altMaps);
  }

  questionMap.set('id', crypto.randomUUID());
  questionMap.set('enunciado', enunciadoYText);
  questionMap.set('alternativas', alternativasYArray);
  return questionMap;
}

function createQuizYMap(
  tituloInicial = 'Quiz de Sistemas Distribuídos & CRDTs',
  withStarterQuestion = true
) {
  const quizMap = new Y.Map();
  const titleYText = new Y.Text();
  if (tituloInicial) {
    titleYText.insert(0, tituloInicial);
  }

  const questionsYArray = new Y.Array();
  if (withStarterQuestion) {
    questionsYArray.insert(0, [
      createQuestionYMap(
        'Qual propriedade garante que duas réplicas CRDT com o mesmo conjunto de atualizações atinjam exatamente o mesmo estado sem coordenação central?',
        [
          {
            texto: 'Convergência Forte Eventual (Strong Eventual Consistency - SEC)',
            isCorrect: true,
          },
          {
            texto: 'Consenso Distribuído via Two-Phase Commit (2PC)',
            isCorrect: false,
          },
          {
            texto: 'Bloqueio Pessimista Global (Distributed Locking)',
            isCorrect: false,
          },
        ]
      ),
    ]);
  }

  quizMap.set('id', crypto.randomUUID());
  quizMap.set('title', titleYText);
  quizMap.set('questions', questionsYArray);
  return quizMap;
}

/**
 * Input reativo vinculado diretamente a um Y.Text para edição caractere por caractere.
 */
function CollaborativeTextField({
  ydoc,
  ytext,
  placeholder,
  className,
  multiline = false,
  id,
}) {
  const [value, setValue] = useState(() => (ytext ? ytext.toString() : ''));

  useEffect(() => {
    if (!ytext) {
      setValue('');
      return;
    }
    setValue(ytext.toString());

    const observer = () => {
      setValue(ytext.toString());
    };

    ytext.observe(observer);
    return () => {
      ytext.unobserve(observer);
    };
  }, [ytext]);

  const handleChange = (e) => {
    const nextVal = e.target.value;
    setValue(nextVal);
    applyYTextDiff(ydoc, ytext, nextVal);
  };

  if (multiline) {
    return (
      <textarea
        id={id}
        rows={2}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className={className}
      />
    );
  }

  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      className={className}
    />
  );
}

export default function App() {
  const ydocRef = useRef(null);
  const providerRef = useRef(null);
  const appStateRef = useRef(null);

  // Começa conectado conforme requisito
  const [isConnected, setIsConnected] = useState(true);
  const [wsStatus, setWsStatus] = useState('connected');
  const [selectedQuizIndex, setSelectedQuizIndex] = useState(0);
  const [, setRenderTick] = useState(0);

  const forceUpdate = useCallback(() => {
    setRenderTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const appState = ydoc.getMap('app-state');

    const provider = new WebsocketProvider(WS_URL, ROOM_NAME, ydoc, {
      connect: true,
    });

    ydocRef.current = ydoc;
    providerRef.current = provider;
    appStateRef.current = appState;

    const handleStatus = (event) => {
      setWsStatus(event.status);
    };

    const handleSync = (isSynced) => {
      if (!isSynced) return;
      // Inicializa a estrutura padrão caso ainda não exista no cluster após sincronizar.
      // Para evitar condição de corrida quando Alice e Bob sobem juntos no docker-compose,
      // Alice cria imediatamente no sync e qualquer outra instância aguarda um pequeno backoff.
      const initIfEmpty = () => {
        if (!appState.has('quizzes')) {
          ydoc.transact(() => {
            if (!appState.has('quizzes')) {
              const quizzesYArray = new Y.Array();
              quizzesYArray.insert(0, [createQuizYMap()]);
              appState.set('quizzes', quizzesYArray);
            }
          });
        }
        forceUpdate();
      };

      if (INSTANCE_NAME.toLowerCase() === 'alice') {
        initIfEmpty();
      } else {
        setTimeout(initIfEmpty, 350);
      }
    };

    const handleDeepObserver = () => {
      forceUpdate();
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    appState.observeDeep(handleDeepObserver);

    return () => {
      appState.unobserveDeep(handleDeepObserver);
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      provider.destroy();
      ydoc.destroy();
    };
  }, [forceUpdate]);

  // Garante que app-state possua o Y.Array 'quizzes' caso o usuário interaja antes de qualquer sync
  const ensureQuizzesArray = () => {
    const ydoc = ydocRef.current;
    const appState = appStateRef.current;
    if (!ydoc || !appState) return null;

    let quizzes = appState.get('quizzes');
    if (!quizzes) {
      ydoc.transact(() => {
        if (!appState.has('quizzes')) {
          const newQuizzes = new Y.Array();
          appState.set('quizzes', newQuizzes);
        }
      });
      quizzes = appState.get('quizzes');
    }
    return quizzes;
  };

  // Alterna conexão do WebSocket Provider (Desconectar / Conectar)
  const handleToggleConnection = () => {
    const provider = providerRef.current;
    if (!provider) return;

    if (isConnected) {
      provider.disconnect();
      setIsConnected(false);
      setWsStatus('disconnected');
    } else {
      provider.connect();
      setIsConnected(true);
    }
  };

  // Operações de mutação no CRDT
  const handleAddQuiz = () => {
    const ydoc = ydocRef.current;
    const quizzes = ensureQuizzesArray();
    if (!ydoc || !quizzes) return;

    ydoc.transact(() => {
      const nextNumber = quizzes.length + 1;
      const newQuiz = createQuizYMap(`Novo Quiz #${nextNumber}`, true);
      quizzes.push([newQuiz]);
    });
    setSelectedQuizIndex(quizzes.length - 1);
  };

  const handleRemoveQuiz = (quizIdx) => {
    const ydoc = ydocRef.current;
    const quizzes = ensureQuizzesArray();
    if (!ydoc || !quizzes || quizzes.length <= 1) return;

    ydoc.transact(() => {
      quizzes.delete(quizIdx, 1);
    });
    setSelectedQuizIndex((prev) => Math.max(0, Math.min(prev, quizzes.length - 1)));
  };

  const handleAddQuestion = (quizMap) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !quizMap) return;

    const questions = quizMap.get('questions');
    if (!questions) return;

    ydoc.transact(() => {
      const nextQuestionNumber = questions.length + 1;
      const questionMap = createQuestionYMap(
        `Questão ${nextQuestionNumber}: Digite o enunciado aqui...`,
        [
          { texto: 'Primeira alternativa', isCorrect: true },
          { texto: 'Segunda alternativa', isCorrect: false },
        ]
      );
      questions.push([questionMap]);
    });
  };

  const handleRemoveQuestion = (quizMap, questionIdx) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !quizMap) return;

    const questions = quizMap.get('questions');
    if (!questions) return;

    ydoc.transact(() => {
      questions.delete(questionIdx, 1);
    });
  };

  const handleAddAlternative = (questionMap) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !questionMap) return;

    const alternativas = questionMap.get('alternativas');
    if (!alternativas) return;

    ydoc.transact(() => {
      const letra = String.fromCharCode(65 + alternativas.length);
      const novaAlt = createAlternativeYMap(`Alternativa ${letra}`, false);
      alternativas.push([novaAlt]);
    });
  };

  const handleRemoveAlternative = (questionMap, altIdx) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !questionMap) return;

    const alternativas = questionMap.get('alternativas');
    if (!alternativas) return;

    ydoc.transact(() => {
      alternativas.delete(altIdx, 1);
    });
  };

  const handleToggleAlternativeCorrect = (altMap) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !altMap) return;

    ydoc.transact(() => {
      const currentVal = Boolean(altMap.get('isCorrect'));
      altMap.set('isCorrect', !currentVal);
    });
  };

  const appState = appStateRef.current;
  const quizzesYArray = appState ? appState.get('quizzes') : null;
  const quizzesList = quizzesYArray ? quizzesYArray.toArray() : [];
  const activeQuizIndex =
    quizzesList.length > 0
      ? Math.min(selectedQuizIndex, quizzesList.length - 1)
      : 0;
  const activeQuiz = quizzesList[activeQuizIndex] || null;
  const questionsYArray = activeQuiz ? activeQuiz.get('questions') : null;
  const questionsList = questionsYArray ? questionsYArray.toArray() : [];

  const isAlice = INSTANCE_NAME.toLowerCase() === 'alice';
  const isBob = INSTANCE_NAME.toLowerCase() === 'bob';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navbar com Controle de Rede CRDT */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`h-10 w-10 rounded-xl flex items-center justify-center font-bold text-sm border ${
                isAlice
                  ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                  : isBob
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                  : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
              }`}
            >
              {INSTANCE_NAME.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-bold tracking-tight text-white">
                  CRDT Sandbox
                </h1>
                <span
                  className={`text-xs font-semibold px-2.5 py-0.5 rounded-md border ${
                    isAlice
                      ? 'bg-sky-500/10 border-sky-500/30 text-sky-300'
                      : isBob
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300'
                  }`}
                >
                  Réplica: {INSTANCE_NAME}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Y.Map(&quot;app-state&quot;) → quizzes → questions (Y.Text + Y.Array)
              </p>
            </div>
          </div>

          {/* Indicador de Conexão + Botão Conectar/Desconectar */}
          <div className="flex items-center gap-3">
            <div
              id="connection-status-indicator"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isConnected
                  ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
                  : 'bg-rose-950/60 border-rose-700/60 text-rose-300'
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  isConnected
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-rose-500'
                }`}
              />
              <span>
                {isConnected
                  ? wsStatus === 'connected'
                    ? 'Conectado (Sincronizando em Tempo Real)'
                    : 'Conectado (Reconectando ao Relay...)'
                  : 'Desconectado (Edição Local-First Offline)'}
              </span>
            </div>

            <button
              id="toggle-connection-btn"
              type="button"
              onClick={handleToggleConnection}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all shadow-sm cursor-pointer ${
                isConnected
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {isConnected ? 'Desconectar' : 'Conectar'}
            </button>
          </div>
        </div>
      </header>

      {/* Banner de aviso quando em modo Offline */}
      {!isConnected && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5 text-center text-xs text-amber-200">
          <strong>Modo Offline Ativo:</strong> Você chamou{' '}
          <code className="bg-amber-950/80 px-1.5 py-0.5 rounded text-amber-300">
            provider.disconnect()
          </code>
          . Todas as edições em enunciados e alternativas continuam funcionando no{' '}
          <code className="bg-amber-950/80 px-1.5 py-0.5 rounded text-amber-300">
            Y.Doc
          </code>{' '}
          em memória local e serão mescladas automaticamente sem conflitos ao clicar em{' '}
          <strong>Conectar</strong>.
        </div>
      )}

      {/* Conteúdo Principal */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Seletor de Quizzes dentro de app-state */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                Lista de Quizzes em <code className="text-emerald-400">app-state</code>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Selecione um quiz ou crie um novo para testar concorrência entre Alice e Bob.
              </p>
            </div>
            <button
              id="add-quiz-btn"
              type="button"
              onClick={handleAddQuiz}
              className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 text-xs font-medium transition-colors cursor-pointer"
            >
              + Novo Quiz
            </button>
          </div>

          {quizzesList.length === 0 ? (
            <div className="text-center py-6 border border-dashed border-slate-800 rounded-lg">
              <p className="text-sm text-slate-400 mb-3">
                Nenhum quiz inicializado no CRDT ainda.
              </p>
              <button
                type="button"
                onClick={handleAddQuiz}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Inicializar Primeiro Quiz
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {quizzesList.map((quizMap, idx) => {
                const quizId = quizMap.get('id') || `quiz-${idx}`;
                const titleAttr = quizMap.get('title');
                const titleText =
                  titleAttr instanceof Y.Text
                    ? titleAttr.toString()
                    : String(titleAttr || `Quiz #${idx + 1}`);
                const isSelected = idx === activeQuizIndex;

                return (
                  <div
                    key={quizId}
                    className={`group flex items-center rounded-lg border text-xs font-medium transition-all ${
                      isSelected
                        ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedQuizIndex(idx)}
                      className="px-3.5 py-2 text-left cursor-pointer"
                    >
                      {titleText.trim() || `Quiz Sem Título #${idx + 1}`}
                    </button>
                    {quizzesList.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveQuiz(idx)}
                        title="Remover Quiz"
                        className="pr-2.5 pl-1 py-2 text-slate-500 hover:text-rose-400 transition-colors cursor-pointer"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Editor do Quiz Ativo e suas Questões */}
        {activeQuiz && (
          <section className="space-y-6">
            {/* Cabeçalho do Quiz Ativo */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
              <label
                htmlFor="quiz-title-input"
                className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2"
              >
                Título do Quiz (Y.Text Colaborativo)
              </label>
              {activeQuiz.get('title') instanceof Y.Text ? (
                <CollaborativeTextField
                  id="quiz-title-input"
                  ydoc={ydocRef.current}
                  ytext={activeQuiz.get('title')}
                  placeholder="Digite o título do quiz..."
                  className="w-full rounded-lg bg-slate-950 border border-slate-800 focus:border-emerald-500/70 focus:outline-none px-3.5 py-2.5 text-base font-semibold text-white placeholder-slate-600 transition-colors"
                />
              ) : (
                <input
                  id="quiz-title-input"
                  type="text"
                  value={String(activeQuiz.get('title') || '')}
                  onChange={(e) =>
                    ydocRef.current?.transact(() => {
                      activeQuiz.set('title', e.target.value);
                    })
                  }
                  className="w-full rounded-lg bg-slate-950 border border-slate-800 focus:border-emerald-500/70 focus:outline-none px-3.5 py-2.5 text-base font-semibold text-white"
                />
              )}
            </div>

            {/* Lista de Questões (Y.Array de Y.Map) */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-300">
                  Questões do Quiz ({questionsList.length})
                </h3>
                <button
                  id="add-question-btn"
                  type="button"
                  onClick={() => handleAddQuestion(activeQuiz)}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors shadow-sm cursor-pointer"
                >
                  + Adicionar Questão
                </button>
              </div>

              {questionsList.length === 0 ? (
                <div className="bg-slate-900/50 border border-dashed border-slate-800 rounded-xl p-8 text-center">
                  <p className="text-sm text-slate-400 mb-3">
                    Este quiz ainda não possui questões.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleAddQuestion(activeQuiz)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Criar Primeira Questão
                  </button>
                </div>
              ) : (
                questionsList.map((questionMap, qIdx) => {
                  const questionId = questionMap.get('id') || `q-${qIdx}`;
                  const enunciadoYText = questionMap.get('enunciado');
                  const alternativasYArray = questionMap.get('alternativas');
                  const alternativasList = alternativasYArray
                    ? alternativasYArray.toArray()
                    : [];

                  return (
                    <article
                      key={questionId}
                      className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 shadow-sm"
                    >
                      {/* Topo da Questão */}
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-xs font-semibold">
                              Questão #{qIdx + 1}
                            </span>
                            <span className="text-xs text-slate-500 font-mono">
                              enunciado: Y.Text
                            </span>
                          </div>
                          <CollaborativeTextField
                            id={`question-enunciado-${qIdx}`}
                            ydoc={ydocRef.current}
                            ytext={enunciadoYText}
                            multiline
                            placeholder="Digite o enunciado da questão (edição colaborativa caractere a caractere)..."
                            className="w-full rounded-lg bg-slate-950 border border-slate-800 focus:border-emerald-500/70 focus:outline-none px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 transition-colors resize-y"
                          />
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveQuestion(activeQuiz, qIdx)}
                          className="text-xs text-slate-500 hover:text-rose-400 px-2.5 py-1.5 rounded-lg hover:bg-rose-950/30 transition-colors cursor-pointer"
                          title="Excluir questão"
                        >
                          Remover
                        </button>
                      </div>

                      {/* Lista de Alternativas (Y.Array de Y.Map) */}
                      <div className="space-y-2.5 pt-2 border-t border-slate-800/80">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-slate-400">
                            Alternativas (<code className="text-slate-300">Y.Array&lt;Y.Map&gt;</code>) — marque as corretas (<code className="text-emerald-400">isCorrect</code>)
                          </span>
                          <button
                            type="button"
                            onClick={() => handleAddAlternative(questionMap)}
                            className="text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                          >
                            + Adicionar Alternativa
                          </button>
                        </div>

                        <div className="space-y-2">
                          {alternativasList.map((altMap, altIdx) => {
                            const altId = altMap.get('id') || `alt-${qIdx}-${altIdx}`;
                            const textoYText = altMap.get('texto');
                            const isCorrect = Boolean(altMap.get('isCorrect'));

                            return (
                              <div
                                key={altId}
                                className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
                                  isCorrect
                                    ? 'bg-emerald-950/25 border-emerald-600/40'
                                    : 'bg-slate-950/70 border-slate-800'
                                }`}
                              >
                                {/* Checkbox estilizado vinculado ao booleano isCorrect via .set() */}
                                <label
                                  htmlFor={`alt-check-${qIdx}-${altIdx}`}
                                  className="relative flex items-center cursor-pointer select-none"
                                  title={
                                    isCorrect
                                      ? 'Alternativa marcada como correta'
                                      : 'Marcar como alternativa correta'
                                  }
                                >
                                  <input
                                    id={`alt-check-${qIdx}-${altIdx}`}
                                    type="checkbox"
                                    checked={isCorrect}
                                    onChange={() =>
                                      handleToggleAlternativeCorrect(altMap)
                                    }
                                    className="sr-only peer"
                                  />
                                  <div
                                    className={`h-5 w-5 rounded-md border flex items-center justify-center transition-all ${
                                      isCorrect
                                        ? 'bg-emerald-500 border-emerald-400 text-slate-950 shadow-sm'
                                        : 'bg-slate-900 border-slate-700 hover:border-slate-500 text-transparent'
                                    }`}
                                  >
                                    <svg
                                      className="w-3.5 h-3.5 stroke-[3]"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M5 13l4 4L19 7"
                                      />
                                    </svg>
                                  </div>
                                </label>

                                {/* Texto da alternativa como Y.Text */}
                                <div className="flex-1">
                                  <CollaborativeTextField
                                    id={`alt-text-${qIdx}-${altIdx}`}
                                    ydoc={ydocRef.current}
                                    ytext={textoYText}
                                    placeholder={`Texto da alternativa ${altIdx + 1}...`}
                                    className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
                                  />
                                </div>

                                <span
                                  className={`text-[11px] font-medium px-2 py-0.5 rounded ${
                                    isCorrect
                                      ? 'bg-emerald-500/20 text-emerald-300'
                                      : 'bg-slate-900 text-slate-500'
                                  }`}
                                >
                                  {isCorrect ? 'Correta' : 'Incorreta'}
                                </span>

                                {alternativasList.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleRemoveAlternative(questionMap, altIdx)
                                    }
                                    className="text-slate-500 hover:text-rose-400 px-1.5 py-1 rounded transition-colors cursor-pointer"
                                    title="Remover alternativa"
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
