(function () {
  "use strict";

  const STORAGE_KEY = "ema_assistant_history_v1";
  const QUIZ_SIZE = 10;
  const POINTS_PER_QUESTION = 10;
  const PASS_SCORE = 70;
  const OPTION_KEYS = ["A", "B", "C", "D"];

  const ALL_QUESTIONS = Array.isArray(window.EMA_QUESTIONS) ? window.EMA_QUESTIONS : [];

  // ==================== State ====================
  const state = {
    view: "home", // home | quiz | result | history | history-detail
    quizQuestions: [],
    userAnswers: {}, // { index (0..9): 'A' | 'B' | 'C' | 'D' }
    quizStartedAt: null,
    timerInterval: null,
    elapsedSeconds: 0,
    currentResult: null,
    resultFilter: "all", // all | wrong | correct
    viewingHistoryId: null,
    toastTimeout: null,
  };

  // ==================== DOM Helpers ====================
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDuration(totalSec) {
    const sec = Math.max(0, Math.floor(totalSec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function formatDateTime(isoStr) {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return isoStr;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
  }

  function formatQuestionWithSource(questionText, sourceId) {
    return `${escapeHtml(questionText)}<span class="question-source-tag">(出自EMA題庫第${escapeHtml(sourceId)}題)</span>`;
  }

  function getScoreTier(score) {
    if (score >= 90) {
      return {
        tierClass: "tier-excellent",
        tag: score === 100 ? "滿分通關" : "優秀達標",
        title: score === 100 ? "太棒了！滿分 100 分完美過關！" : "表現非常優秀！穩健掌握核心觀念",
        desc:
          score === 100
            ? "本次 10 題全數答對，實力已經非常扎實，可以繼續挑戰下一輪！"
            : "距離滿分只差一點點，複習下方的錯題解答就能更上一層樓。",
      };
    }
    if (score >= PASS_SCORE) {
      return {
        tierClass: "tier-pass",
        tag: "及格達標",
        title: "恭喜達標！已超過 EMA 70 分及格標準",
        desc: "整體表現不錯！建議針對下方寫錯的題目與解答加強記憶。",
      };
    }
    return {
      tierClass: "tier-retry",
      tag: "繼續加油",
      title: "再加把勁！複習錯題後馬上就會進步",
      desc: "別氣餒，下面已為你整理好每一題寫錯的題目與正確解答，熟悉後再挑戰一次！",
    };
  }

  // ==================== LocalStorage ====================
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.error("Failed to save history:", err);
      showToast("本機儲存空間不足，無法寫入歷史紀錄。");
    }
  }

  function addHistoryRecord(record) {
    const history = loadHistory();
    history.unshift(record);
    saveHistory(history);
    updateNavBadge();
    renderHomeHistorySummary();
  }

  function deleteHistoryRecord(recordId) {
    const history = loadHistory().filter((item) => item.id !== recordId);
    saveHistory(history);
    updateNavBadge();
    renderHomeHistorySummary();
    renderHistoryView();
    showToast("已刪除該筆測驗紀錄。");
  }

  function clearAllHistory() {
    saveHistory([]);
    updateNavBadge();
    renderHomeHistorySummary();
    renderHistoryView();
    showToast("已清除所有歷史紀錄。");
  }

  // ==================== Toast & Modal ====================
  function showToast(message, durationMs = 3600) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    if (state.toastTimeout) clearTimeout(state.toastTimeout);
    state.toastTimeout = setTimeout(() => {
      el.hidden = true;
    }, durationMs);
  }

  function openModal({ title, body, buttons }) {
    $("modal-title").textContent = title;
    $("modal-body").textContent = body;
    const actionsEl = $("modal-actions");
    actionsEl.innerHTML = "";
    buttons.forEach((btnCfg) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${btnCfg.className || "btn-outline"}`;
      btn.textContent = btnCfg.label;
      btn.addEventListener("click", () => {
        closeModal();
        if (typeof btnCfg.onClick === "function") btnCfg.onClick();
      });
      actionsEl.appendChild(btn);
    });
    $("modal-backdrop").hidden = false;
  }

  function closeModal() {
    $("modal-backdrop").hidden = true;
  }

  // ==================== View Switching ====================
  function setView(viewName) {
    state.view = viewName;
    document.querySelectorAll(".view").forEach((sec) => {
      sec.classList.toggle("active", sec.id === `view-${viewName}`);
    });

    const activeNav =
      viewName === "result"
        ? "quiz"
        : viewName === "history-detail"
          ? "history"
          : viewName;

    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.nav === activeNav);
    });

    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function hasActiveQuizProgress() {
    return state.view === "quiz" && Object.keys(state.userAnswers).length > 0;
  }

  function confirmLeaveQuiz(onConfirm) {
    if (!hasActiveQuizProgress()) {
      stopTimer();
      onConfirm();
      return;
    }
    openModal({
      title: "確定要離開目前測驗嗎？",
      body: "目前牛刀小試尚未送出，離開後本次作答進度將不會儲存至歷史紀錄。",
      buttons: [
        { label: "繼續作答", className: "btn-outline" },
        {
          label: "確定離開",
          className: "btn-danger",
          onClick: () => {
            stopTimer();
            onConfirm();
          },
        },
      ],
    });
  }

  // ==================== Timer ====================
  function startTimer() {
    stopTimer();
    state.elapsedSeconds = 0;
    $("quiz-timer").textContent = "00:00";
    state.timerInterval = setInterval(() => {
      state.elapsedSeconds += 1;
      $("quiz-timer").textContent = formatDuration(state.elapsedSeconds);
    }, 1000);
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  // ==================== Quiz Logic ====================
  function pickRandomQuestions(count) {
    const pool = ALL_QUESTIONS.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(count, pool.length));
  }

  function startNewQuiz() {
    if (ALL_QUESTIONS.length < QUIZ_SIZE) {
      showToast("題庫載入異常，請重新整理頁面。");
      return;
    }
    state.quizQuestions = pickRandomQuestions(QUIZ_SIZE);
    state.userAnswers = {};
    state.quizStartedAt = new Date().toISOString();
    renderQuizView();
    setView("quiz");
    startTimer();
  }

  function renderQuizView() {
    const formEl = $("quiz-form");
    const pillsEl = $("quiz-question-pills");
    formEl.innerHTML = "";
    pillsEl.innerHTML = "";

    state.quizQuestions.forEach((q, idx) => {
      // Quick jump pill
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "q-pill";
      pill.id = `q-pill-${idx}`;
      pill.textContent = String(idx + 1);
      pill.title = `跳至第 ${idx + 1} 題`;
      pill.addEventListener("click", () => {
        const card = $(`q-card-${idx}`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      pillsEl.appendChild(pill);

      // Question card
      const card = document.createElement("article");
      card.className = "question-card";
      card.id = `q-card-${idx}`;

      const optionsHtml = OPTION_KEYS.map((key) => {
        const optText = q.options[key] || "";
        return `
          <label class="option-label" data-qidx="${idx}" data-opt="${key}">
            <input type="radio" name="q_${idx}" value="${key}" />
            <span class="option-key">${key}</span>
            <span class="option-text">${escapeHtml(optText)}</span>
          </label>
        `;
      }).join("");

      card.innerHTML = `
        <div class="question-card-header">
          <span class="q-num-badge">第 ${idx + 1} 題 / 共 ${QUIZ_SIZE} 題</span>
          <span class="q-points">${POINTS_PER_QUESTION} 分</span>
        </div>
        <h2 class="question-stem">${idx + 1}. ${formatQuestionWithSource(q.question, q.id)}</h2>
        <div class="options-grid">
          ${optionsHtml}
        </div>
      `;

      // Bind selection handlers
      card.querySelectorAll(".option-label").forEach((label) => {
        label.addEventListener("click", () => {
          const selectedOpt = label.dataset.opt;
          selectOption(idx, selectedOpt);
        });
      });

      formEl.appendChild(card);
    });

    updateQuizProgress();
  }

  function selectOption(qIdx, optKey) {
    state.userAnswers[qIdx] = optKey;
    const card = $(`q-card-${qIdx}`);
    if (card) {
      card.classList.add("answered");
      card.classList.remove("unanswered-highlight");
      card.querySelectorAll(".option-label").forEach((lbl) => {
        const isSelected = lbl.dataset.opt === optKey;
        lbl.classList.toggle("selected", isSelected);
        const radio = lbl.querySelector('input[type="radio"]');
        if (radio) radio.checked = isSelected;
      });
    }
    const pill = $(`q-pill-${qIdx}`);
    if (pill) pill.classList.add("answered");
    updateQuizProgress();
  }

  function updateQuizProgress() {
    const answeredCount = Object.keys(state.userAnswers).length;
    const pct = Math.round((answeredCount / QUIZ_SIZE) * 100);
    $("quiz-progress-text").textContent = `已作答 ${answeredCount} / ${QUIZ_SIZE} 題`;
    $("quiz-progress-fill").style.width = `${pct}%`;

    const hintEl = $("quiz-submit-hint");
    if (answeredCount === QUIZ_SIZE) {
      hintEl.textContent = "全部 10 題皆已作答完成，可以送出測驗查看成績！";
      hintEl.classList.add("ready");
    } else {
      hintEl.textContent = `還有 ${QUIZ_SIZE - answeredCount} 題尚未作答`;
      hintEl.classList.remove("ready");
    }
  }

  function handleSubmitQuizClick() {
    const unansweredIndices = [];
    for (let i = 0; i < state.quizQuestions.length; i++) {
      if (!state.userAnswers[i]) unansweredIndices.push(i);
    }

    if (unansweredIndices.length > 0) {
      unansweredIndices.forEach((idx) => {
        const card = $(`q-card-${idx}`);
        if (card) card.classList.add("unanswered-highlight");
      });
      const displayNums = unansweredIndices.map((i) => `第 ${i + 1} 題`).join("、");
      openModal({
        title: `還有 ${unansweredIndices.length} 題尚未作答`,
        body: `未作答題目：${displayNums}。未作答的題目將以 0 分計算，確定要直接送出，或先回到未答題目繼續作答？`,
        buttons: [
          {
            label: "前往未答題目",
            className: "btn-primary",
            onClick: () => {
              const firstCard = $(`q-card-${unansweredIndices[0]}`);
              if (firstCard) firstCard.scrollIntoView({ behavior: "smooth", block: "start" });
            },
          },
          {
            label: "直接送出評分",
            className: "btn-outline",
            onClick: () => finalizeQuizSubmission(),
          },
        ],
      });
      return;
    }

    finalizeQuizSubmission();
  }

  function finalizeQuizSubmission() {
    stopTimer();

    const items = state.quizQuestions.map((q, idx) => {
      const userAnswer = state.userAnswers[idx] || null;
      const isCorrect = userAnswer === q.answer;
      return {
        order: idx + 1,
        sourceId: q.id,
        question: q.question,
        options: { ...q.options },
        correctAnswer: q.answer,
        userAnswer,
        isCorrect,
      };
    });

    const correctCount = items.filter((it) => it.isCorrect).length;
    const wrongCount = items.length - correctCount;
    const score = correctCount * POINTS_PER_QUESTION;

    const existingHistory = loadHistory();
    const attemptNumber = existingHistory.length > 0
      ? Math.max(...existingHistory.map((h) => h.attemptNumber || 0)) + 1
      : 1;

    const record = {
      id: `ema_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      attemptNumber,
      timestamp: new Date().toISOString(),
      durationSeconds: state.elapsedSeconds,
      score,
      totalScore: QUIZ_SIZE * POINTS_PER_QUESTION,
      correctCount,
      wrongCount,
      items,
    };

    addHistoryRecord(record);
    state.currentResult = record;
    state.resultFilter = "all";
    renderResultView(record);
    setView("result");
    showToast(
      `測驗完成！本次得分 ${score} 分（答對 ${correctCount} 題、答錯 ${wrongCount} 題），已自動存入歷史紀錄。`,
      5000
    );
  }

  // ==================== Review Rendering (Shared by Result & History Detail) ====================
  function renderScoreBanner(containerEl, record, isHistoryDetail) {
    const tier = getScoreTier(record.score);
    const headingTag = isHistoryDetail ? "h2" : "h1";
    const headingId = isHistoryDetail ? "history-detail-title" : "result-title";
    const subtitlePrefix = isHistoryDetail
      ? `第 ${record.attemptNumber} 次測驗（${formatDateTime(record.timestamp)}）`
      : "本次牛刀小試測驗完成！結果已自動儲存至歷史紀錄";

    containerEl.className = `score-banner ${tier.tierClass}`;
    containerEl.innerHTML = `
      <div class="score-main">
        <span class="score-pill-tag">${escapeHtml(tier.tag)}・${escapeHtml(subtitlePrefix)}</span>
        <${headingTag} id="${headingId}">${escapeHtml(tier.title)}</${headingTag}>
        <p class="score-desc">${escapeHtml(tier.desc)}</p>
        <div class="score-metrics">
          <span class="score-metric-chip">答對：${record.correctCount} 題（+${record.score} 分）</span>
          <span class="score-metric-chip">答錯：${record.wrongCount} 題</span>
          <span class="score-metric-chip">用時：${formatDuration(record.durationSeconds)}</span>
        </div>
      </div>
      <div class="score-dial" aria-label="本次得分 ${record.score} 分，滿分 ${record.totalScore} 分">
        <span class="score-dial-num">${record.score}</span>
        <span class="score-dial-unit">/ ${record.totalScore} 分</span>
      </div>
    `;
  }

  function buildReviewCardHtml(item, compactWrongMode = false) {
    const statusBadge = item.isCorrect
      ? `<span class="status-badge correct">✓ 答對（+${POINTS_PER_QUESTION} 分）</span>`
      : `<span class="status-badge wrong">✕ 答錯（0 分）</span>`;

    const userAnsText = item.userAnswer
      ? `(${item.userAnswer}) ${escapeHtml(item.options[item.userAnswer] || "")}`
      : "未作答";
    const correctAnsText = `(${item.correctAnswer}) ${escapeHtml(item.options[item.correctAnswer] || "")}`;

    if (compactWrongMode) {
      return `
        <article class="review-card is-wrong">
          <div class="review-card-top">
            <span class="q-num-badge">第 ${item.order} 題</span>
            ${statusBadge}
          </div>
          <h3 class="question-stem">${item.order}. ${formatQuestionWithSource(item.question, item.sourceId)}</h3>
          <div class="answer-summary-box">
            <div>你的答案：<span class="ans-user-wrong">${userAnsText}</span></div>
            <div>正確解答：<span class="ans-correct">${correctAnsText}</span></div>
          </div>
        </article>
      `;
    }

    const optsHtml = OPTION_KEYS.map((key) => {
      const isCorrectOpt = key === item.correctAnswer;
      const isUserOpt = key === item.userAnswer;
      let cls = "review-opt";
      let tagHtml = "";

      if (isCorrectOpt) {
        cls += " opt-correct";
        tagHtml = isUserOpt
          ? `<span class="opt-tag tag-correct">你的答案・正確</span>`
          : `<span class="opt-tag tag-correct">正確解答</span>`;
      } else if (isUserOpt && !item.isCorrect) {
        cls += " opt-user-wrong";
        tagHtml = `<span class="opt-tag tag-wrong">你的選擇</span>`;
      }

      return `
        <div class="${cls}">
          <div class="review-opt-left">
            <strong>(${key})</strong>
            <span>${escapeHtml(item.options[key] || "")}</span>
          </div>
          ${tagHtml}
        </div>
      `;
    }).join("");

    return `
      <article class="review-card ${item.isCorrect ? "is-correct" : "is-wrong"}">
        <div class="review-card-top">
          <span class="q-num-badge">第 ${item.order} 題</span>
          ${statusBadge}
        </div>
        <h3 class="question-stem">${item.order}. ${formatQuestionWithSource(item.question, item.sourceId)}</h3>
        <div class="review-options">
          ${optsHtml}
        </div>
        ${
          !item.isCorrect
            ? `<div class="answer-summary-box">
                 <div>你的答案：<span class="ans-user-wrong">${userAnsText}</span></div>
                 <div>正確解答：<span class="ans-correct">${correctAnsText}</span></div>
               </div>`
            : ""
        }
      </article>
    `;
  }

  function renderWrongSection(listEl, badgeEl, record) {
    const wrongItems = record.items.filter((it) => !it.isCorrect);
    badgeEl.textContent = `${wrongItems.length} 題`;
    badgeEl.classList.toggle("perfect", wrongItems.length === 0);

    if (wrongItems.length === 0) {
      listEl.innerHTML = `
        <div class="perfect-card">
          <strong>太厲害了！本次測驗全數答對，沒有任何錯題！</strong>
          <span>你已經順利掌握這 10 道 EMA 題庫重點。</span>
        </div>
      `;
      return;
    }

    listEl.innerHTML = wrongItems.map((it) => buildReviewCardHtml(it, true)).join("");
  }

  function renderResultView(record) {
    renderScoreBanner($("result-score-banner"), record, false);
    renderWrongSection($("result-wrong-list"), $("result-wrong-badge"), record);
    renderResultAllList(record, state.resultFilter);
    updateFilterTabButtons();
  }

  function renderResultAllList(record, filter) {
    const listEl = $("result-all-list");
    let filtered = record.items;
    if (filter === "wrong") filtered = record.items.filter((it) => !it.isCorrect);
    if (filter === "correct") filtered = record.items.filter((it) => it.isCorrect);

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding: 28px 20px;">
          <p style="margin: 0;">此篩選分類下沒有題目。</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map((it) => buildReviewCardHtml(it, false)).join("");
  }

  function updateFilterTabButtons() {
    document.querySelectorAll(".filter-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === state.resultFilter);
    });
  }

  // ==================== Home & History Views ====================
  function updateNavBadge() {
    const count = loadHistory().length;
    $("nav-history-count").textContent = String(count);
  }

  function renderHomeHistorySummary() {
    const history = loadHistory();
    const container = $("home-history-summary");
    if (history.length === 0) {
      container.innerHTML = `
        <p class="empty-mini-note">目前尚未有測驗紀錄。<br />完成第一次「牛刀小試」後將自動顯示學習統計！</p>
      `;
      return;
    }
    const avg = Math.round(history.reduce((sum, h) => sum + h.score, 0) / history.length);
    const best = Math.max(...history.map((h) => h.score));
    container.innerHTML = `
      <div class="mini-stats-row">
        <div class="mini-stat">
          <strong>${history.length}</strong>
          <span>測驗次數</span>
        </div>
        <div class="mini-stat">
          <strong>${avg} 分</strong>
          <span>平均分數</span>
        </div>
        <div class="mini-stat">
          <strong>${best} 分</strong>
          <span>最高分數</span>
        </div>
      </div>
    `;
  }

  function renderHistoryView() {
    const history = loadHistory();
    const statsGrid = $("history-stats-grid");
    const listEl = $("history-list");
    const clearBtn = $("btn-clear-history");

    if (history.length === 0) {
      statsGrid.hidden = true;
      clearBtn.hidden = true;
      listEl.innerHTML = `
        <div class="empty-state">
          <h3>目前還沒有歷史測驗紀錄</h3>
          <p>開始你的第一次「牛刀小試」，送出後系統就會自動幫你記下分數與錯題！</p>
          <button type="button" class="btn btn-primary btn-lg" id="btn-empty-start-quiz">立即開始牛刀小試</button>
        </div>
      `;
      const emptyBtn = $("btn-empty-start-quiz");
      if (emptyBtn) emptyBtn.addEventListener("click", startNewQuiz);
      return;
    }

    const totalAttempts = history.length;
    const avgScore = Math.round(history.reduce((sum, h) => sum + h.score, 0) / totalAttempts);
    const bestScore = Math.max(...history.map((h) => h.score));
    const totalAnswered = totalAttempts * QUIZ_SIZE;

    statsGrid.hidden = false;
    clearBtn.hidden = false;
    statsGrid.innerHTML = `
      <div class="stat-card">
        <span class="stat-label">累計測驗次數</span>
        <span class="stat-value accent">${totalAttempts} 次</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">平均分數</span>
        <span class="stat-value">${avgScore} 分</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">最高分數</span>
        <span class="stat-value">${bestScore} 分</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">累計練習題數</span>
        <span class="stat-value">${totalAnswered} 題</span>
      </div>
    `;

    listEl.innerHTML = history
      .map((rec) => {
        const tier = getScoreTier(rec.score);
        return `
          <article class="history-item">
            <div class="history-item-left">
              <div class="history-score-circle ${tier.tierClass}">
                <strong>${rec.score}</strong>
                <span>分</span>
              </div>
              <div class="history-info">
                <h3>第 ${rec.attemptNumber} 次牛刀小試</h3>
                <div class="history-meta">
                  <span>測驗時間：${escapeHtml(formatDateTime(rec.timestamp))}</span>
                  <span>答對 ${rec.correctCount} 題・答錯 ${rec.wrongCount} 題</span>
                  <span>用時 ${formatDuration(rec.durationSeconds)}</span>
                </div>
              </div>
            </div>
            <div class="history-actions">
              <button type="button" class="btn btn-primary btn-sm" data-view-id="${escapeHtml(rec.id)}">查看題目與錯題</button>
              <button type="button" class="btn btn-ghost btn-sm" data-delete-id="${escapeHtml(rec.id)}" aria-label="刪除此筆紀錄">刪除</button>
            </div>
          </article>
        `;
      })
      .join("");

    listEl.querySelectorAll("[data-view-id]").forEach((btn) => {
      btn.addEventListener("click", () => openHistoryDetail(btn.dataset.viewId));
    });

    listEl.querySelectorAll("[data-delete-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const recId = btn.dataset.deleteId;
        openModal({
          title: "確定要刪除這筆紀錄嗎？",
          body: "刪除後將無法復原此筆測驗明細。",
          buttons: [
            { label: "取消", className: "btn-outline" },
            {
              label: "確定刪除",
              className: "btn-danger",
              onClick: () => deleteHistoryRecord(recId),
            },
          ],
        });
      });
    });
  }

  function openHistoryDetail(recordId) {
    const record = loadHistory().find((item) => item.id === recordId);
    if (!record) {
      showToast("找不到該筆測驗紀錄。");
      return;
    }
    state.viewingHistoryId = recordId;
    $("history-detail-meta").textContent = `第 ${record.attemptNumber} 次測驗・${formatDateTime(record.timestamp)}`;
    renderScoreBanner($("history-detail-banner"), record, true);
    renderWrongSection($("history-detail-wrong-list"), $("history-detail-wrong-badge"), record);
    $("history-detail-all-list").innerHTML = record.items.map((it) => buildReviewCardHtml(it, false)).join("");
    setView("history-detail");
  }

  // ==================== Event Binding ====================
  function bindEvents() {
    // Brand & Top navigation
    $("btn-brand-home").addEventListener("click", () => {
      confirmLeaveQuiz(() => {
        renderHomeHistorySummary();
        setView("home");
      });
    });

    $("nav-home").addEventListener("click", () => {
      confirmLeaveQuiz(() => {
        renderHomeHistorySummary();
        setView("home");
      });
    });

    $("nav-quiz").addEventListener("click", () => {
      if (state.view === "quiz") return;
      startNewQuiz();
    });

    $("nav-history").addEventListener("click", () => {
      confirmLeaveQuiz(() => {
        renderHistoryView();
        setView("history");
      });
    });

    // Home actions
    $("btn-start-quiz-home").addEventListener("click", startNewQuiz);
    $("btn-open-history-home").addEventListener("click", () => {
      renderHistoryView();
      setView("history");
    });

    // Quiz actions
    $("btn-quit-quiz").addEventListener("click", () => {
      confirmLeaveQuiz(() => {
        renderHomeHistorySummary();
        setView("home");
      });
    });

    $("btn-submit-quiz").addEventListener("click", handleSubmitQuizClick);

    // Result actions
    document.querySelectorAll(".filter-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!state.currentResult) return;
        state.resultFilter = btn.dataset.filter;
        updateFilterTabButtons();
        renderResultAllList(state.currentResult, state.resultFilter);
      });
    });

    $("btn-retry-quiz").addEventListener("click", startNewQuiz);
    $("btn-leave-result").addEventListener("click", () => {
      renderHomeHistorySummary();
      setView("home");
    });

    // History actions
    $("btn-history-new-quiz").addEventListener("click", startNewQuiz);
    $("btn-clear-history").addEventListener("click", () => {
      openModal({
        title: "確定要清除全部歷史紀錄嗎？",
        body: "此操作將會移除本機保存的所有歷次測驗成績與錯題紀錄，且無法復原。",
        buttons: [
          { label: "取消", className: "btn-outline" },
          {
            label: "全部清除",
            className: "btn-danger",
            onClick: clearAllHistory,
          },
        ],
      });
    });

    // History detail actions
    $("btn-back-to-history").addEventListener("click", () => {
      renderHistoryView();
      setView("history");
    });
    $("btn-detail-back").addEventListener("click", () => {
      renderHistoryView();
      setView("history");
    });
    $("btn-detail-retry").addEventListener("click", startNewQuiz);

    // Close modal on backdrop click or ESC
    $("modal-backdrop").addEventListener("click", (e) => {
      if (e.target === $("modal-backdrop")) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("modal-backdrop").hidden) closeModal();
    });
  }

  // ==================== Init ====================
  function init() {
    $("home-total-questions").textContent = `${ALL_QUESTIONS.length} 題`;
    updateNavBadge();
    renderHomeHistorySummary();
    bindEvents();
  }

  init();
})();
