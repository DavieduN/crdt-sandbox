import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:1234';
const ROOM_NAME = import.meta.env.VITE_ROOM_NAME || 'crdt-sandbox-room';
const INSTANCE_NAME = import.meta.env.VITE_INSTANCE_NAME || 'Local Peer';

/**
 * Aplica a diferença mínima (diff por prefixo/sufixo comum) em uma instância Y.Text.
 * Garante operações CRDT caractere por caractere (ytext.insert / ytext.delete).
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
  enunciadoInicial = 'Nova questão...',
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
  tituloInicial = 'Quiz de Sistemas Distribuídos',
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
        'Qual propriedade garante que duas réplicas com o mesmo conjunto de atualizações atinjam exatamente o mesmo estado sem coordenação central?',
        [
          {
            texto: 'Convergência Forte Eventual (Strong Eventual Consistency)',
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
 * Consolida Quizzes, Questões e Alternativas pela sua identidade semântica:
 * - Quiz -> title
 * - Questão -> enunciado
 * - Alternativa -> texto
 *
 * Dessa forma, se Alice e Bob criarem/editarem offline o mesmo "Quiz 1"
 * adicionando perguntas diferentes (Y e Z), ao reconectar tudo é mesclado
 * em um único "Quiz 1" com todas as perguntas (X, Y e Z) sem perda por LWW.
 */
function buildMergedQuizzesView(quizzesYArray) {
  if (!quizzesYArray) return [];

  const rawQuizzes = quizzesYArray.toArray();
  const quizGroupsMap = new Map();

  rawQuizzes.forEach((quizMap, rawQuizIdx) => {
    const titleAttr = quizMap.get('title');
    const titleStr =
      titleAttr instanceof Y.Text
        ? titleAttr.toString()
        : String(titleAttr || '');
    const normalizedTitle = titleStr.trim();
    const quizKey = normalizedTitle
      ? `title:${normalizedTitle}`
      : `id:${quizMap.get('id') || rawQuizIdx}`;

    if (!quizGroupsMap.has(quizKey)) {
      quizGroupsMap.set(quizKey, {
        key: quizKey,
        canonicalQuiz: quizMap,
        quizMaps: [],
        titleYTexts: [],
        questionGroupsMap: new Map(),
      });
    }

    const qGroup = quizGroupsMap.get(quizKey);
    qGroup.quizMaps.push({ quizMap, index: rawQuizIdx });
    if (titleAttr instanceof Y.Text) {
      qGroup.titleYTexts.push(titleAttr);
    }

    const questionsYArray = quizMap.get('questions');
    if (!questionsYArray) return;

    questionsYArray.toArray().forEach((questionMap, rawQuestionIdx) => {
      const enunciadoYText = questionMap.get('enunciado');
      const enunciadoStr =
        enunciadoYText instanceof Y.Text ? enunciadoYText.toString() : '';
      const normalizedEnunciado = enunciadoStr.trim();
      const questionKey = normalizedEnunciado
        ? `enunciado:${normalizedEnunciado}`
        : `id:${questionMap.get('id') || `${rawQuizIdx}-${rawQuestionIdx}`}`;

      if (!qGroup.questionGroupsMap.has(questionKey)) {
        qGroup.questionGroupsMap.set(questionKey, {
          key: questionKey,
          canonicalQuestion: questionMap,
          questionRefs: [],
          enunciadoYTexts: [],
          altGroupsMap: new Map(),
        });
      }

      const questGroup = qGroup.questionGroupsMap.get(questionKey);
      questGroup.questionRefs.push({
        parentQuestionsYArray: questionsYArray,
        questionMap,
        index: rawQuestionIdx,
      });
      if (enunciadoYText instanceof Y.Text) {
        questGroup.enunciadoYTexts.push(enunciadoYText);
      }

      const alternativasYArray = questionMap.get('alternativas');
      if (!alternativasYArray) return;

      alternativasYArray.toArray().forEach((altMap, rawAltIdx) => {
        const textoYText = altMap.get('texto');
        const textoStr =
          textoYText instanceof Y.Text ? textoYText.toString() : '';
        const normalizedTexto = textoStr.trim();
        const altKey = normalizedTexto
          ? `texto:${normalizedTexto}`
          : `id:${
              altMap.get('id') ||
              `${rawQuizIdx}-${rawQuestionIdx}-${rawAltIdx}`
            }`;

        if (!questGroup.altGroupsMap.has(altKey)) {
          questGroup.altGroupsMap.set(altKey, {
            key: altKey,
            canonicalAlt: altMap,
            altRefs: [],
            textoYTexts: [],
          });
        }

        const altGroup = questGroup.altGroupsMap.get(altKey);
        altGroup.altRefs.push({
          parentAlternativasYArray: alternativasYArray,
          altMap,
          index: rawAltIdx,
        });
        if (textoYText instanceof Y.Text) {
          altGroup.textoYTexts.push(textoYText);
        }
      });
    });
  });

  return Array.from(quizGroupsMap.values()).map((qGroup) => ({
    ...qGroup,
    questions: Array.from(qGroup.questionGroupsMap.values()).map(
      (questGroup) => ({
        ...questGroup,
        alternativas: Array.from(questGroup.altGroupsMap.values()),
      })
    ),
  }));
}

function CollaborativeTextField({
  ydoc,
  ytext,
  extraYTexts = [],
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
    if (!ydoc || !ytext) return;

    ydoc.transact(() => {
      applyYTextDiff(ydoc, ytext, nextVal);
      for (const otherYText of extraYTexts) {
        if (otherYText && otherYText !== ytext) {
          applyYTextDiff(ydoc, otherYText, nextVal);
        }
      }
    });
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

  const handleAddQuiz = () => {
    const ydoc = ydocRef.current;
    const quizzes = ensureQuizzesArray();
    if (!ydoc || !quizzes) return;

    const mergedCount = buildMergedQuizzesView(quizzes).length;
    ydoc.transact(() => {
      const nextNumber = mergedCount + 1;
      const newQuiz = createQuizYMap(`Quiz ${nextNumber}`, true);
      quizzes.push([newQuiz]);
    });
    setSelectedQuizIndex(mergedCount);
  };

  const handleRemoveQuizGroup = (quizGroup, totalMergedQuizzes) => {
    const ydoc = ydocRef.current;
    const quizzes = ensureQuizzesArray();
    if (!ydoc || !quizzes || totalMergedQuizzes <= 1) return;

    ydoc.transact(() => {
      const indicesDesc = quizGroup.quizMaps
        .map((item) => item.index)
        .sort((a, b) => b - a);
      for (const idx of indicesDesc) {
        if (idx >= 0 && idx < quizzes.length) {
          quizzes.delete(idx, 1);
        }
      }
    });
    setSelectedQuizIndex((prev) =>
      Math.max(0, Math.min(prev, totalMergedQuizzes - 2))
    );
  };

  const handleAddQuestion = (quizGroup) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !quizGroup?.canonicalQuiz) return;

    const questions = quizGroup.canonicalQuiz.get('questions');
    if (!questions) return;

    ydoc.transact(() => {
      const nextQuestionNumber = quizGroup.questions.length + 1;
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

  const handleRemoveQuestionGroup = (questionGroup) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !questionGroup) return;

    ydoc.transact(() => {
      // Remove em ordem decrescente de índice por Y.Array pai
      const sortedRefs = [...questionGroup.questionRefs].sort(
        (a, b) => b.index - a.index
      );
      for (const ref of sortedRefs) {
        const arr = ref.parentQuestionsYArray;
        if (arr && ref.index >= 0 && ref.index < arr.length) {
          arr.delete(ref.index, 1);
        }
      }
    });
  };

  const handleAddAlternative = (questionGroup) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !questionGroup?.canonicalQuestion) return;

    const alternativas = questionGroup.canonicalQuestion.get('alternativas');
    if (!alternativas) return;

    ydoc.transact(() => {
      const letra = String.fromCharCode(65 + questionGroup.alternativas.length);
      const novaAlt = createAlternativeYMap(`Alternativa ${letra}`, false);
      alternativas.push([novaAlt]);
    });
  };

  const handleRemoveAlternativeGroup = (altGroup) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !altGroup) return;

    ydoc.transact(() => {
      const sortedRefs = [...altGroup.altRefs].sort(
        (a, b) => b.index - a.index
      );
      for (const ref of sortedRefs) {
        const arr = ref.parentAlternativasYArray;
        if (arr && ref.index >= 0 && ref.index < arr.length) {
          arr.delete(ref.index, 1);
        }
      }
    });
  };

  const handleToggleAlternativeCorrect = (altGroup) => {
    const ydoc = ydocRef.current;
    if (!ydoc || !altGroup) return;

    const currentVal = Boolean(altGroup.canonicalAlt.get('isCorrect'));
    const nextVal = !currentVal;

    ydoc.transact(() => {
      for (const ref of altGroup.altRefs) {
        ref.altMap.set('isCorrect', nextVal);
      }
    });
  };

  const appState = appStateRef.current;
  const quizzesYArray = appState ? appState.get('quizzes') : null;
  const quizzesList = buildMergedQuizzesView(quizzesYArray);
  const activeQuizIndex =
    quizzesList.length > 0
      ? Math.min(selectedQuizIndex, quizzesList.length - 1)
      : 0;
  const activeQuizGroup = quizzesList[activeQuizIndex] || null;
  const questionsList = activeQuizGroup ? activeQuizGroup.questions : [];

  const isAlice = INSTANCE_NAME.toLowerCase() === 'alice';
  const isBob = INSTANCE_NAME.toLowerCase() === 'bob';
  const avatarLetter = INSTANCE_NAME.slice(0, 1).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`h-9 w-9 rounded-full flex items-center justify-center font-bold text-sm border ${
                isAlice
                  ? 'bg-sky-100 border-sky-300 text-sky-700'
                  : isBob
                  ? 'bg-amber-100 border-amber-300 text-amber-700'
                  : 'bg-emerald-100 border-emerald-300 text-emerald-700'
              }`}
            >
              {avatarLetter}
            </div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-lg font-bold tracking-tight text-slate-900">
                CRDT Sandbox
              </h1>
              <span
                className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
                  isAlice
                    ? 'bg-sky-50 border-sky-200 text-sky-700'
                    : isBob
                    ? 'bg-amber-50 border-amber-200 text-amber-700'
                    : 'bg-slate-100 border-slate-200 text-slate-700'
                }`}
              >
                {INSTANCE_NAME}
              </span>
            </div>
          </div>

          {/* Indicador de Conexão + Botão Desconectar/Conectar */}
          <div className="flex items-center gap-3">
            <div
              id="connection-status-indicator"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                isConnected
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-rose-50 border-rose-200 text-rose-700'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span>
                {isConnected
                  ? wsStatus === 'connected'
                    ? 'Conectado'
                    : 'Reconectando...'
                  : 'Desconectado'}
              </span>
            </div>

            <button
              id="toggle-connection-btn"
              type="button"
              onClick={handleToggleConnection}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors shadow-sm cursor-pointer ${
                isConnected
                  ? 'bg-rose-600 hover:bg-rose-700 text-white'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              }`}
            >
              {isConnected ? 'Desconectar' : 'Conectar'}
            </button>
          </div>
        </div>
      </header>

      {/* Aviso discreto quando offline */}
      {!isConnected && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-xs font-medium text-amber-800">
          Modo offline — suas edições locais serão sincronizadas ao reconectar.
        </div>
      )}

      {/* Conteúdo Principal */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Lista de Quizzes */}
        <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Quizzes
            </h2>
            <button
              id="add-quiz-btn"
              type="button"
              onClick={handleAddQuiz}
              className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 text-xs font-medium transition-colors cursor-pointer"
            >
              + Novo Quiz
            </button>
          </div>

          {quizzesList.length === 0 ? (
            <div className="text-center py-6 border border-dashed border-slate-200 rounded-lg">
              <p className="text-sm text-slate-500 mb-3">
                Nenhum quiz criado ainda.
              </p>
              <button
                type="button"
                onClick={handleAddQuiz}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Criar Primeiro Quiz
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {quizzesList.map((quizGroup, idx) => {
                const titleAttr = quizGroup.canonicalQuiz.get('title');
                const titleText =
                  titleAttr instanceof Y.Text
                    ? titleAttr.toString()
                    : String(titleAttr || `Quiz #${idx + 1}`);
                const isSelected = idx === activeQuizIndex;

                return (
                  <div
                    key={quizGroup.key}
                    className={`flex items-center rounded-lg border text-xs font-medium transition-all ${
                      isSelected
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedQuizIndex(idx)}
                      className="px-3.5 py-2 text-left cursor-pointer"
                    >
                      {titleText.trim() || `Quiz #${idx + 1}`}
                    </button>
                    {quizzesList.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          handleRemoveQuizGroup(quizGroup, quizzesList.length)
                        }
                        title="Remover Quiz"
                        className="pr-2.5 pl-1 py-2 text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
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

        {/* Quiz Ativo */}
        {activeQuizGroup && (
          <section className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm">
              <label
                htmlFor="quiz-title-input"
                className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2"
              >
                Título do Quiz
              </label>
              {activeQuizGroup.canonicalQuiz.get('title') instanceof Y.Text ? (
                <CollaborativeTextField
                  id="quiz-title-input"
                  ydoc={ydocRef.current}
                  ytext={activeQuizGroup.canonicalQuiz.get('title')}
                  extraYTexts={activeQuizGroup.titleYTexts}
                  placeholder="Digite o título do quiz..."
                  className="w-full rounded-lg bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-none px-3.5 py-2.5 text-base font-semibold text-slate-900 placeholder-slate-400 transition-colors"
                />
              ) : (
                <input
                  id="quiz-title-input"
                  type="text"
                  value={String(activeQuizGroup.canonicalQuiz.get('title') || '')}
                  onChange={(e) =>
                    ydocRef.current?.transact(() => {
                      for (const item of activeQuizGroup.quizMaps) {
                        item.quizMap.set('title', e.target.value);
                      }
                    })
                  }
                  className="w-full rounded-lg bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-none px-3.5 py-2.5 text-base font-semibold text-slate-900"
                />
              )}
            </div>

            {/* Questões */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">
                  Questões ({questionsList.length})
                </h3>
                <button
                  id="add-question-btn"
                  type="button"
                  onClick={() => handleAddQuestion(activeQuizGroup)}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors shadow-sm cursor-pointer"
                >
                  + Adicionar Questão
                </button>
              </div>

              {questionsList.length === 0 ? (
                <div className="bg-white border border-dashed border-slate-300 rounded-xl p-8 text-center">
                  <p className="text-sm text-slate-500 mb-3">
                    Nenhuma questão adicionada.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleAddQuestion(activeQuizGroup)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Criar Primeira Questão
                  </button>
                </div>
              ) : (
                questionsList.map((questionGroup, qIdx) => {
                  const enunciadoYText =
                    questionGroup.canonicalQuestion.get('enunciado');
                  const alternativasList = questionGroup.alternativas;

                  return (
                    <article
                      key={questionGroup.key}
                      className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 space-y-2">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold">
                            Questão #{qIdx + 1}
                          </span>
                          <CollaborativeTextField
                            id={`question-enunciado-${qIdx}`}
                            ydoc={ydocRef.current}
                            ytext={enunciadoYText}
                            extraYTexts={questionGroup.enunciadoYTexts}
                            multiline
                            placeholder="Digite o enunciado da questão..."
                            className="w-full rounded-lg bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-none px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition-colors resize-y"
                          />
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveQuestionGroup(questionGroup)}
                          className="text-xs text-slate-400 hover:text-rose-600 px-2.5 py-1.5 rounded-lg hover:bg-rose-50 transition-colors cursor-pointer"
                          title="Excluir questão"
                        >
                          Remover
                        </button>
                      </div>

                      {/* Alternativas */}
                      <div className="space-y-2.5 pt-3 border-t border-slate-100">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                            Alternativas
                          </span>
                          <button
                            type="button"
                            onClick={() => handleAddAlternative(questionGroup)}
                            className="text-xs font-medium text-emerald-600 hover:text-emerald-700 transition-colors cursor-pointer"
                          >
                            + Adicionar Alternativa
                          </button>
                        </div>

                        <div className="space-y-2">
                          {alternativasList.map((altGroup, altIdx) => {
                            const textoYText =
                              altGroup.canonicalAlt.get('texto');
                            const isCorrect = Boolean(
                              altGroup.canonicalAlt.get('isCorrect')
                            );

                            return (
                              <div
                                key={altGroup.key}
                                className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
                                  isCorrect
                                    ? 'bg-emerald-50/70 border-emerald-300'
                                    : 'bg-slate-50 border-slate-200'
                                }`}
                              >
                                <label
                                  htmlFor={`alt-check-${qIdx}-${altIdx}`}
                                  className="relative flex items-center cursor-pointer select-none"
                                  title={
                                    isCorrect
                                      ? 'Alternativa correta'
                                      : 'Marcar como correta'
                                  }
                                >
                                  <input
                                    id={`alt-check-${qIdx}-${altIdx}`}
                                    type="checkbox"
                                    checked={isCorrect}
                                    onChange={() =>
                                      handleToggleAlternativeCorrect(altGroup)
                                    }
                                    className="sr-only peer"
                                  />
                                  <div
                                    className={`h-5 w-5 rounded-md border flex items-center justify-center transition-all ${
                                      isCorrect
                                        ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                                        : 'bg-white border-slate-300 hover:border-slate-400 text-transparent'
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

                                <div className="flex-1">
                                  <CollaborativeTextField
                                    id={`alt-text-${qIdx}-${altIdx}`}
                                    ydoc={ydocRef.current}
                                    ytext={textoYText}
                                    extraYTexts={altGroup.textoYTexts}
                                    placeholder={`Alternativa ${altIdx + 1}...`}
                                    className="w-full bg-transparent text-sm text-slate-900 placeholder-slate-400 focus:outline-none"
                                  />
                                </div>

                                <span
                                  className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                                    isCorrect
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-slate-200/70 text-slate-600'
                                  }`}
                                >
                                  {isCorrect ? 'Correta' : 'Incorreta'}
                                </span>

                                {alternativasList.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleRemoveAlternativeGroup(altGroup)
                                    }
                                    className="text-slate-400 hover:text-rose-600 px-1.5 py-1 rounded transition-colors cursor-pointer"
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
