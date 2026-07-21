/* Тренажёр тестов — логика приложения */
(function () {
  "use strict";

  var BANK = window.QUESTION_BANK;
  var PASS = BANK.passRate || 85;
  var LS_HISTORY = "trainer_history_v1";
  var LS_MISSED = "trainer_missed_v1";

  var el = function (id) { return document.getElementById(id); };
  var main = el("app");

  /* ---------- storage ---------- */
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function getHistory() { return loadJSON(LS_HISTORY, []); }
  function saveAttempt(attempt) {
    var h = getHistory();
    h.unshift(attempt);
    localStorage.setItem(LS_HISTORY, JSON.stringify(h.slice(0, 300)));
  }
  function getMissed() { return loadJSON(LS_MISSED, {}); }
  function bumpMissed(topicId, qid) {
    var m = getMissed();
    var key = topicId + "::" + qid;
    m[key] = (m[key] || 0) + 1;
    localStorage.setItem(LS_MISSED, JSON.stringify(m));
  }

  /* ---------- helpers ---------- */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function letter(i) { return String.fromCharCode(65 + i); }

  /* Выборка n вопросов; если проставлены уровни A/B/C — держим пропорцию 30/40/30 */
  function sampleQuestions(pool, n) {
    if (pool.length <= n) return shuffle(pool);
    var byLevel = { A: [], B: [], C: [] };
    var untagged = [];
    pool.forEach(function (q) {
      if (q.level && byLevel[q.level]) byLevel[q.level].push(q); else untagged.push(q);
    });
    var allTagged = untagged.length === 0 && byLevel.A.length && byLevel.B.length && byLevel.C.length;
    if (!allTagged) return shuffle(pool).slice(0, n);

    var want = { A: Math.round(n * 0.3), B: Math.round(n * 0.4), C: 0 };
    want.C = n - want.A - want.B;
    var picked = [];
    ["A", "B", "C"].forEach(function (lv) {
      picked = picked.concat(shuffle(byLevel[lv]).slice(0, want[lv]));
    });
    if (picked.length < n) {
      var used = {};
      picked.forEach(function (q) { used[q.id] = 1; });
      var rest = shuffle(pool.filter(function (q) { return !used[q.id]; }));
      picked = picked.concat(rest.slice(0, n - picked.length));
    }
    return shuffle(picked);
  }

  /* Сборка блока: англ — 18 лексика-грамматика + 16 чтение (чтение группируем по текстам) */
  function composeBlock(topicId) {
    var topic = BANK.topics[topicId];
    if (topicId === "english") {
      var lexis = topic.questions.filter(function (q) { return q.section === "lexis"; });
      var reading = topic.questions.filter(function (q) { return q.section === "reading"; });
      var wantLexis = topic.sections.lexis.count;
      var wantReading = topic.sections.reading.count;

      var pickedLexis = sampleQuestions(lexis, wantLexis);

      /* чтение: берём случайные тексты целиком, пока не наберём нужное число вопросов */
      var byPassage = {};
      reading.forEach(function (q) {
        var pid = q.passageId || "_none";
        (byPassage[pid] = byPassage[pid] || []).push(q);
      });
      var pids = shuffle(Object.keys(byPassage));
      var pickedReading = [];
      for (var i = 0; i < pids.length && pickedReading.length < wantReading; i++) {
        pickedReading = pickedReading.concat(shuffle(byPassage[pids[i]]));
      }
      pickedReading = pickedReading.slice(0, wantReading);

      return pickedLexis.concat(pickedReading);
    }
    return sampleQuestions(topic.questions, topic.blockSize);
  }

  /* Подсчёт баллов одного вопроса. Возвращает {earned, max, errors} */
  function scoreQuestion(q, selected) {
    var sel = selected || [];
    var correct = q.correct || [];
    if (q.multi) {
      var errors = 0;
      q.options.forEach(function (_, i) {
        var shouldPick = correct.indexOf(i) !== -1;
        var didPick = sel.indexOf(i) !== -1;
        if (shouldPick !== didPick) errors++;
      });
      var earned = errors === 0 ? 2 : (errors === 1 ? 1 : 0);
      return { earned: earned, max: 2, errors: errors };
    }
    var ok = sel.length === 1 && correct.indexOf(sel[0]) !== -1;
    return { earned: ok ? 1 : 0, max: 1, errors: ok ? 0 : 1 };
  }

  /* ---------- grouped topics helpers ---------- */
  function allQuestions(t) {
    if (!t.grouped) return t.questions;
    var acc = [];
    t.themes.forEach(function (th) { acc = acc.concat(th.questions); });
    return acc;
  }
  function findTheme(t, themeId) {
    return (t.themes || []).filter(function (th) { return th.id === themeId; })[0];
  }

  /* ---------- state ---------- */
  var quiz = null; // { topicId, themeId, questions, answers, index, retry }

  function setNav(active) {
    el("nav-home").classList.toggle("active", active === "home");
    el("nav-stats").classList.toggle("active", active === "stats");
  }

  /* ---------- home ---------- */
  /* Варианты пробников: каждый вариант — набор тем-предметов */
  var PROBNIKI_VARIANTS = [
    { id: "v1", name: "Вариант 1", topics: ["english", "tgo", "management", "business"] },
    { id: "v4", name: "Вариант 4", topics: ["english_v4", "tgo_v4", "management_v4", "business_v4"] }
  ];
  var PROBNIKI = [];
  PROBNIKI_VARIANTS.forEach(function (v) { PROBNIKI = PROBNIKI.concat(v.topics); });

  function topicCardHTML(tid, history) {
    var t = BANK.topics[tid];
    var total = allQuestions(t).length;
    var attempts = history.filter(function (a) { return a.topicId === tid && !a.retry; });
    var best = attempts.length ? Math.max.apply(null, attempts.map(function (a) { return a.pct; })) : null;
    var last = attempts.length ? attempts[0].pct : null;
    var passed = best !== null && best >= PASS;

    var meta = "В базе: <b>" + total + "</b> вопросов · Блок: <b>" + t.blockSize + "</b>";
    if (tid === "english") meta += "<br>(" + t.sections.lexis.count + " лексика-грамматика + " + t.sections.reading.count + " чтение)";
    if (tid === "business") meta += "<br>Один или несколько правильных ответов (2/1/0 баллов)";

    var stats = "";
    if (attempts.length) {
      stats = "<div class='topic-stats'>" +
        "<span class='badge " + (passed ? "pass" : "fail") + "'>" + (passed ? "Сдано" : "Не сдано") + "</span>" +
        "<span>Последний: <b>" + last + "%</b></span>" +
        "<span>Лучший: <b>" + best + "%</b></span></div>";
    } else {
      stats = "<div class='topic-stats'><span class='badge neutral'>Ещё не проходил</span></div>";
    }

    var disabled = total === 0 ? " disabled" : "";
    return "<div class='topic-card'><h3>" + esc(t.name) + "</h3>" +
      "<div class='topic-meta'>" + meta + "</div>" + stats +
      "<button class='btn' data-start='" + tid + "'" + disabled + ">Начать блок</button></div>";
  }

  function goHome() {
    quiz = null;
    setNav("home");
    var history = getHistory();
    var html = "<h1>Выбери раздел</h1><p class='subtitle'>Проходной порог — " + PASS + "%.</p><div class='topic-grid'>";

    /* карточка «Пробники» */
    var pTotal = PROBNIKI.reduce(function (s, tid) { return s + allQuestions(BANK.topics[tid]).length; }, 0);
    var pPassed = PROBNIKI.filter(function (tid) {
      var atts = history.filter(function (a) { return a.topicId === tid && !a.retry; });
      return atts.length && Math.max.apply(null, atts.map(function (a) { return a.pct; })) >= PASS;
    }).length;
    html += "<div class='topic-card'><h3>Пробники</h3>" +
      "<div class='topic-meta'>Вариантов: <b>" + PROBNIKI_VARIANTS.length + "</b> · Вопросов: <b>" + pTotal + "</b><br>Полные варианты: английский, ТГО, менеджмент, организация бизнеса</div>" +
      "<div class='topic-stats'><span class='badge " + (pPassed === PROBNIKI.length ? "pass" : "neutral") + "'>Сдано тестов: " + pPassed + "/" + PROBNIKI.length + "</span></div>" +
      "<button class='btn' data-probniki='1'>Выбрать вариант</button></div>";

    Object.keys(BANK.topics).forEach(function (tid) {
      if (PROBNIKI.indexOf(tid) !== -1) return;
      var t = BANK.topics[tid];
      var total = allQuestions(t).length;

      if (t.grouped) {
        var passedThemes = t.themes.filter(function (th) {
          var atts = history.filter(function (a) { return a.topicId === tid && a.themeId === th.id && !a.retry; });
          return atts.length && Math.max.apply(null, atts.map(function (a) { return a.pct; })) >= PASS;
        }).length;
        html += "<div class='topic-card'><h3>" + esc(t.name) + "</h3>" +
          "<div class='topic-meta'>Тем: <b>" + t.themes.length + "</b> · Вопросов: <b>" + total + "</b><br>" + (t.metaNote || "") + "</div>" +
          "<div class='topic-stats'><span class='badge " + (passedThemes === t.themes.length && total ? "pass" : "neutral") + "'>Сдано тем: " + passedThemes + "/" + t.themes.length + "</span></div>" +
          "<button class='btn' data-themes='" + tid + "'" + (total === 0 ? " disabled" : "") + ">Выбрать тему</button></div>";
        return;
      }

      html += topicCardHTML(tid, history);
    });

    html += "</div>";
    main.innerHTML = html;
    main.querySelectorAll("[data-start]").forEach(function (b) {
      b.addEventListener("click", function () { startBlock(b.getAttribute("data-start")); });
    });
    main.querySelectorAll("[data-themes]").forEach(function (b) {
      b.addEventListener("click", function () { showThemes(b.getAttribute("data-themes")); });
    });
    var pb = main.querySelector("[data-probniki]");
    if (pb) pb.addEventListener("click", showProbniki);
    updateBankInfo();
  }

  /* ---------- список вариантов пробников ---------- */
  function showProbniki() {
    quiz = null;
    setNav("home");
    var history = getHistory();
    var html = "<h1>Пробники</h1><p class='subtitle'>Выбери вариант — внутри полные тесты по всем предметам. Порог — " + PASS + "%.</p>" +
      "<div style='margin-bottom:16px'><button class='btn ghost' id='btn-back-home'>← Ко всем разделам</button></div><div class='topic-grid'>";
    PROBNIKI_VARIANTS.forEach(function (v) {
      var total = v.topics.reduce(function (s, tid) { return s + allQuestions(BANK.topics[tid]).length; }, 0);
      var passed = v.topics.filter(function (tid) {
        var atts = history.filter(function (a) { return a.topicId === tid && !a.retry; });
        return atts.length && Math.max.apply(null, atts.map(function (a) { return a.pct; })) >= PASS;
      }).length;
      html += "<div class='topic-card'><h3>" + esc(v.name) + "</h3>" +
        "<div class='topic-meta'>Предметов: <b>" + v.topics.length + "</b> · Вопросов: <b>" + total + "</b><br>" +
        v.topics.map(function (tid) { return esc(BANK.topics[tid].name); }).join(", ") + "</div>" +
        "<div class='topic-stats'><span class='badge " + (passed === v.topics.length ? "pass" : "neutral") + "'>Сдано: " + passed + "/" + v.topics.length + "</span></div>" +
        "<button class='btn' data-variant='" + v.id + "'>Открыть вариант</button></div>";
    });
    html += "</div>";
    main.innerHTML = html;
    el("btn-back-home").addEventListener("click", goHome);
    main.querySelectorAll("[data-variant]").forEach(function (b) {
      b.addEventListener("click", function () { showProbnikiVariant(b.getAttribute("data-variant")); });
    });
    window.scrollTo(0, 0);
  }

  /* ---------- предметы одного варианта ---------- */
  function showProbnikiVariant(vid) {
    quiz = null;
    setNav("home");
    var v = PROBNIKI_VARIANTS.filter(function (x) { return x.id === vid; })[0];
    if (!v) return showProbniki();
    var history = getHistory();
    var html = "<h1>Пробники · " + esc(v.name) + "</h1><p class='subtitle'>Полные тесты по предметам варианта. Порог — " + PASS + "%.</p>" +
      "<div style='margin-bottom:16px'><button class='btn ghost' id='btn-back-variants'>← К вариантам</button></div><div class='topic-grid'>";
    v.topics.forEach(function (tid) { html += topicCardHTML(tid, history); });
    html += "</div>";
    main.innerHTML = html;
    el("btn-back-variants").addEventListener("click", showProbniki);
    main.querySelectorAll("[data-start]").forEach(function (b) {
      b.addEventListener("click", function () { startBlock(b.getAttribute("data-start")); });
    });
    window.scrollTo(0, 0);
  }

  /* ---------- theme list for grouped topics ---------- */
  function showThemes(topicId) {
    quiz = null;
    setNav("home");
    var t = BANK.topics[topicId];
    var history = getHistory();
    var html = "<h1>" + esc(t.name) + "</h1><p class='subtitle'>Выбери тему — тест содержит все вопросы темы. Порог — " + PASS + "%.</p>";
    html += "<div style='margin-bottom:16px'><button class='btn ghost' id='btn-back-home'>← Ко всем разделам</button></div>";
    html += "<div class='topic-grid'>";
    t.themes.forEach(function (th, i) {
      var atts = history.filter(function (a) { return a.topicId === topicId && a.themeId === th.id && !a.retry; });
      var best = atts.length ? Math.max.apply(null, atts.map(function (a) { return a.pct; })) : null;
      var passed = best !== null && best >= PASS;
      var stats = atts.length
        ? "<div class='topic-stats'><span class='badge " + (passed ? "pass" : "fail") + "'>" + (passed ? "Сдано" : "Не сдано") + "</span><span>Лучший: <b>" + best + "%</b></span></div>"
        : "<div class='topic-stats'><span class='badge neutral'>Ещё не проходил</span></div>";
      html += "<div class='topic-card'><h3>" + esc(th.name) + "</h3>" +
        "<div class='topic-meta'>Вопросов: <b>" + th.questions.length + "</b></div>" + stats +
        "<button class='btn' data-theme='" + th.id + "'" + (th.questions.length ? "" : " disabled") + ">Начать тест</button></div>";
    });
    html += "</div>";
    main.innerHTML = html;
    el("btn-back-home").addEventListener("click", goHome);
    main.querySelectorAll("[data-theme]").forEach(function (b) {
      b.addEventListener("click", function () { startBlock(topicId, b.getAttribute("data-theme")); });
    });
    window.scrollTo(0, 0);
  }

  function updateBankInfo() {
    var total = 0;
    Object.keys(BANK.topics).forEach(function (tid) { total += allQuestions(BANK.topics[tid]).length; });
    el("bank-info").textContent = total + " вопросов";
  }

  /* ---------- quiz ---------- */
  function startBlock(topicId, themeId) {
    var t = BANK.topics[topicId];
    var questions;
    if (themeId) {
      var th = findTheme(t, themeId);
      questions = shuffle(th.questions);
    } else {
      questions = composeBlock(topicId);
    }
    if (!questions.length) return;
    quiz = { topicId: topicId, themeId: themeId || null, questions: questions, answers: questions.map(function () { return []; }), index: 0, retry: false };
    renderQuiz();
  }

  function startRetry(topicId, themeId, wrongQuestions) {
    quiz = { topicId: topicId, themeId: themeId || null, questions: shuffle(wrongQuestions), answers: wrongQuestions.map(function () { return []; }), index: 0, retry: true };
    renderQuiz();
  }

  function renderQuiz() {
    setNav("");
    var t = BANK.topics[quiz.topicId];
    var q = quiz.questions[quiz.index];
    var sel = quiz.answers[quiz.index];
    var answeredCount = quiz.answers.filter(function (a) { return a.length; }).length;

    var themeName = quiz.themeId ? (findTheme(t, quiz.themeId) || {}).name : null;
    var html = "<div class='quiz-header'><div class='quiz-title'>" + esc(t.name) + (themeName ? " · " + esc(themeName) : "") + (quiz.retry ? " — работа над ошибками" : "") + "</div>" +
      "<div class='quiz-progress'>Вопрос " + (quiz.index + 1) + " из " + quiz.questions.length + " · Отвечено: " + answeredCount + "</div></div>";

    html += "<div class='qnav'>";
    quiz.questions.forEach(function (_, i) {
      var cls = (quiz.answers[i].length ? "answered " : "") + (i === quiz.index ? "current" : "");
      html += "<button class='" + cls + "' data-goto='" + i + "'>" + (i + 1) + "</button>";
    });
    html += "</div>";

    if (q.passageId && t.passages && t.passages[q.passageId]) {
      var p = t.passages[q.passageId];
      html += "<div class='passage-box'>" + (p.title ? "<div class='passage-title'>" + esc(p.title) + "</div>" : "") + esc(p.text) + "</div>";
    }

    html += "<div class='question-card'>";
    if (q.section && t.sections && t.sections[q.section]) {
      html += "<div class='q-section'>" + esc(t.sections[q.section].name) + "</div>";
    }
    html += "<div class='q-text'>" + esc(q.text) + "</div>";
    if (q.image) html += "<img class='q-image' src='" + esc(q.image) + "' alt='Иллюстрация к заданию'>";
    if (q.multi) html += "<div class='q-hint'>Можно выбрать несколько вариантов. Все верно — 2 балла, одна ошибка — 1 балл, две и более — 0.</div>";

    html += "<div class='options'>";
    q.options.forEach(function (opt, i) {
      var type = q.multi ? "checkbox" : "radio";
      var checked = sel.indexOf(i) !== -1 ? " checked" : "";
      var selCls = sel.indexOf(i) !== -1 ? " selected" : "";
      html += "<label class='option" + selCls + "'><input type='" + type + "' name='opt'" + checked + " data-opt='" + i + "'><span><b>" + letter(i) + ".</b> " + esc(opt) + "</span></label>";
    });
    html += "</div></div>";

    html += "<div class='quiz-actions'>" +
      "<div style='display:flex;gap:10px;flex-wrap:wrap'>" +
      "<button class='btn ghost' id='btn-prev'" + (quiz.index === 0 ? " disabled" : "") + ">← Назад</button>" +
      "<button class='btn secondary' id='btn-next'" + (quiz.index === quiz.questions.length - 1 ? " disabled" : "") + ">Далее →</button></div>" +
      "<div style='display:flex;gap:10px;flex-wrap:wrap'>" +
      "<button class='btn ghost' id='btn-quit'>Выйти без сохранения</button>" +
      "<button class='btn' id='btn-finish'>Завершить блок</button></div></div>";

    main.innerHTML = html;

    main.querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () { quiz.index = +b.getAttribute("data-goto"); renderQuiz(); });
    });
    main.querySelectorAll("[data-opt]").forEach(function (inp) {
      inp.addEventListener("change", function () {
        var i = +inp.getAttribute("data-opt");
        var cur = quiz.answers[quiz.index];
        if (q.multi) {
          var pos = cur.indexOf(i);
          if (pos === -1) cur.push(i); else cur.splice(pos, 1);
        } else {
          quiz.answers[quiz.index] = [i];
        }
        /* обновляем вид на месте, без полной перерисовки (не сбрасываем прокрутку) */
        var sel2 = quiz.answers[quiz.index];
        main.querySelectorAll(".option").forEach(function (lab) {
          var oi = +lab.querySelector("[data-opt]").getAttribute("data-opt");
          lab.classList.toggle("selected", sel2.indexOf(oi) !== -1);
        });
        var navBtn = main.querySelector("[data-goto='" + quiz.index + "']");
        if (navBtn) navBtn.classList.toggle("answered", sel2.length > 0);
        var answered = quiz.answers.filter(function (a) { return a.length; }).length;
        var prog = main.querySelector(".quiz-progress");
        if (prog) prog.textContent = "Вопрос " + (quiz.index + 1) + " из " + quiz.questions.length + " · Отвечено: " + answered;
      });
    });
    el("btn-prev").addEventListener("click", function () { quiz.index--; renderQuiz(); });
    el("btn-next").addEventListener("click", function () { quiz.index++; renderQuiz(); });
    el("btn-quit").addEventListener("click", function () {
      if (confirm("Выйти? Ответы этого блока не сохранятся.")) goHome();
    });
    el("btn-finish").addEventListener("click", finishQuiz);
    window.scrollTo(0, 0);
  }

  function finishQuiz() {
    var unanswered = quiz.answers.filter(function (a) { return !a.length; }).length;
    if (unanswered > 0 && !confirm("Не отвечено: " + unanswered + ". Всё равно завершить? Неотвеченные будут засчитаны как ошибки.")) return;

    var earned = 0, max = 0;
    var perSection = {};
    var review = [];
    var wrongCount = 0;

    quiz.questions.forEach(function (q, i) {
      var r = scoreQuestion(q, quiz.answers[i]);
      earned += r.earned; max += r.max;
      if (q.section) {
        var s = (perSection[q.section] = perSection[q.section] || { earned: 0, max: 0 });
        s.earned += r.earned; s.max += r.max;
      }
      var isCorrect = r.earned === r.max;
      review.push({ q: q, selected: quiz.answers[i].slice(), result: r, isCorrect: isCorrect, num: i + 1 });
      if (!isCorrect) { wrongCount++; bumpMissed(quiz.topicId, q.id); }
    });

    var pct = max ? Math.round(earned / max * 100) : 0;
    var attempt = {
      date: new Date().toISOString(),
      topicId: quiz.topicId,
      themeId: quiz.themeId,
      retry: quiz.retry,
      earned: earned, max: max, pct: pct,
      total: quiz.questions.length,
      wrongCount: wrongCount
    };
    saveAttempt(attempt);
    renderResults(attempt, review, perSection);
  }

  /* ---------- results ---------- */
  function renderResults(attempt, review, perSection) {
    var t = BANK.topics[attempt.topicId];
    var passed = attempt.pct >= PASS;
    var topicId = attempt.topicId;
    var themeId = attempt.themeId || null;
    var themeName = themeId ? (findTheme(t, themeId) || {}).name : null;
    var wrong = review.filter(function (x) { return !x.isCorrect; });
    var right = review.filter(function (x) { return x.isCorrect; });

    var html = "<div class='result-hero'>" +
      "<div class='result-score " + (passed ? "pass" : "fail") + "'>" + attempt.pct + "%</div>" +
      "<div class='result-sub'>" + esc(t.name) + (themeName ? " · " + esc(themeName) : "") + (attempt.retry ? " · работа над ошибками" : "") +
      " · " + attempt.earned + " из " + attempt.max + " баллов · верно " + right.length + " из " + attempt.total + " вопросов</div>" +
      "<div style='margin-top:12px'><span class='badge " + (passed ? "pass" : "fail") + "'>" +
      (passed ? "Сдано (порог " + PASS + "%)" : "Не сдано (нужно " + PASS + "%)") + "</span></div>";

    var sectionKeys = Object.keys(perSection);
    if (sectionKeys.length) {
      html += "<div class='result-sections'>";
      sectionKeys.forEach(function (sk) {
        var s = perSection[sk];
        var name = t.sections && t.sections[sk] ? t.sections[sk].name : sk;
        html += "<span>" + esc(name) + ": <b>" + s.earned + "/" + s.max + "</b> (" + (s.max ? Math.round(s.earned / s.max * 100) : 0) + "%)</span>";
      });
      html += "</div>";
    }

    html += "<div style='margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap'>";
    if (wrong.length) html += "<button class='btn' id='btn-retry'>Перерешать ошибки (" + wrong.length + ")</button>";
    html += "<button class='btn secondary' id='btn-again'>Новый блок</button>" +
      "<button class='btn ghost' id='btn-home'>На главную</button></div></div>";

    html += "<div class='section-h'>Разбор вопросов</div>" +
      "<div id='review-bar' style='display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px'></div>" +
      "<div id='review-list'></div>";

    main.innerHTML = html;

    function reviewItemHTML(w) {
      var q = w.q;
      var yourText = w.selected.length
        ? w.selected.map(function (i) { return letter(i) + ". " + q.options[i]; }).join("; ")
        : "— нет ответа —";
      var correctText = q.correct.map(function (i) { return letter(i) + ". " + q.options[i]; }).join("; ");
      var partial = q.multi && !w.isCorrect && w.result.earned > 0;
      var badge = w.isCorrect
        ? "<span class='badge pass'>Верно</span>"
        : (partial ? "<span class='badge warn'>Частично</span>" : "<span class='badge fail'>Ошибка</span>");

      var h = "<div class='review-item'>" +
        "<div class='q-text'><b>" + w.num + ".</b> " + badge + " " + esc(q.text) + "</div>";
      if (q.image) h += "<img class='q-image' src='" + esc(q.image) + "' alt='Иллюстрация к заданию'>";
      if (q.passageId && t.passages && t.passages[q.passageId]) {
        h += "<details style='margin-top:6px'><summary style='cursor:pointer;color:var(--muted);font-size:0.85rem'>Показать текст</summary><div class='passage-box' style='margin-top:8px'>" + esc(t.passages[q.passageId].text) + "</div></details>";
      }
      if (w.isCorrect) {
        h += "<div class='answer-line correct'><b>Твой ответ (верно):</b> " + esc(yourText) +
          (q.multi ? " · " + w.result.earned + "/2 балла" : "") + "</div>";
      } else {
        h += "<div class='answer-line yours" + (partial ? " partial" : "") + "'><b>Твой ответ:</b> " + esc(yourText) +
          (q.multi ? " · " + w.result.earned + "/2 балла" : "") + "</div>" +
          "<div class='answer-line correct'><b>Правильный ответ:</b> " + esc(correctText) + "</div>";
      }
      if (q.explanation) h += "<div class='explanation'><b>Объяснение:</b> " + esc(q.explanation) + "</div>";
      h += "</div>";
      return h;
    }

    var filter = "all";
    function filterBtn(f, label) {
      return "<button class='btn " + (filter === f ? "secondary" : "ghost") + "' data-filt='" + f + "'>" + label + "</button>";
    }
    function drawBar() {
      var bar = el("review-bar");
      bar.innerHTML = filterBtn("all", "Все (" + review.length + ")") +
        filterBtn("wrong", "Ошибки (" + wrong.length + ")") +
        filterBtn("right", "Верные (" + right.length + ")");
      bar.querySelectorAll("[data-filt]").forEach(function (b) {
        b.addEventListener("click", function () { filter = b.getAttribute("data-filt"); drawBar(); drawList(); });
      });
    }
    function drawList() {
      var items = filter === "wrong" ? wrong : filter === "right" ? right : review;
      var list = el("review-list");
      list.innerHTML = items.length
        ? items.map(reviewItemHTML).join("")
        : "<div class='empty-note'>Нет вопросов в этой категории.</div>";
    }
    drawBar();
    drawList();

    if (wrong.length) {
      el("btn-retry").addEventListener("click", function () {
        startRetry(topicId, themeId, wrong.map(function (w) { return w.q; }));
      });
    }
    el("btn-again").addEventListener("click", function () { startBlock(topicId, themeId); });
    el("btn-home").addEventListener("click", goHome);
    window.scrollTo(0, 0);
  }

  /* ---------- stats ---------- */
  function showStats() {
    quiz = null;
    setNav("stats");
    var history = getHistory();
    var missed = getMissed();

    var html = "<h1>Статистика</h1><p class='subtitle'>Полные блоки и работа над ошибками. Порог — " + PASS + "%.</p>";

    html += "<div class='stat-cards'>";
    Object.keys(BANK.topics).forEach(function (tid) {
      var t = BANK.topics[tid];
      var attempts = history.filter(function (a) { return a.topicId === tid && !a.retry; });
      if (t.grouped) {
        var passedThemes = t.themes.filter(function (th) {
          var atts = attempts.filter(function (a) { return a.themeId === th.id; });
          return atts.length && Math.max.apply(null, atts.map(function (a) { return a.pct; })) >= PASS;
        }).length;
        html += "<div class='stat-card'><div class='name'>" + esc(t.name) + "</div>" +
          "<div class='big'>" + passedThemes + "/" + t.themes.length + "</div>" +
          "<div class='small'>тем сдано · Попыток: " + attempts.length + "</div></div>";
        return;
      }
      var best = attempts.length ? Math.max.apply(null, attempts.map(function (a) { return a.pct; })) : null;
      var avg = attempts.length ? Math.round(attempts.reduce(function (s, a) { return s + a.pct; }, 0) / attempts.length) : null;
      var passed = best !== null && best >= PASS;
      html += "<div class='stat-card'><div class='name'>" + esc(t.name) + "</div>" +
        "<div class='big'>" + (best === null ? "—" : best + "%") + "</div>" +
        "<div class='small'>Попыток: " + attempts.length + (avg !== null ? " · Средний: " + avg + "%" : "") + "<br>" +
        (attempts.length ? (passed ? "✅ Сдано" : "❌ Пока не сдано") : "Ещё не проходил") + "</div></div>";
    });
    html += "</div>";

    /* сложные вопросы */
    var missedArr = Object.keys(missed).map(function (key) {
      var parts = key.split("::");
      var tid = parts[0], qid = parts[1];
      var t = BANK.topics[tid];
      var q = t && allQuestions(t).filter(function (x) { return x.id === qid; })[0];
      return q ? { topic: t.name, q: q, count: missed[key] } : null;
    }).filter(Boolean).sort(function (a, b) { return b.count - a.count; }).slice(0, 10);

    if (missedArr.length) {
      html += "<div class='section-h'>Самые сложные вопросы (чаще всего ошибаешься)</div><div class='difficult-list'>";
      missedArr.forEach(function (m) {
        html += "<div class='difficult-item'><span><b>" + esc(m.topic) + ":</b> " + esc(m.q.text.length > 120 ? m.q.text.slice(0, 120) + "…" : m.q.text) + "</span>" +
          "<span class='badge warn'>" + m.count + "×</span></div>";
      });
      html += "</div>";
    }

    if (history.length) {
      html += "<div class='section-h'>История</div><table class='history'><tr><th>Дата</th><th>Тема</th><th>Тип</th><th>Результат</th><th>Баллы</th><th>Итог</th></tr>";
      history.slice(0, 50).forEach(function (a) {
        var t = BANK.topics[a.topicId];
        var d = new Date(a.date);
        var ds = d.toLocaleDateString("ru-RU") + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
        var label = t ? t.name : a.topicId;
        if (t && a.themeId) { var th = findTheme(t, a.themeId); if (th) label += " · " + th.name; }
        html += "<tr><td>" + ds + "</td><td>" + esc(label) + "</td>" +
          "<td>" + (a.retry ? "Ошибки" : "Блок") + "</td><td><b>" + a.pct + "%</b></td>" +
          "<td>" + a.earned + "/" + a.max + "</td>" +
          "<td>" + (a.retry ? "—" : "<span class='badge " + (a.pct >= PASS ? "pass'>Сдано" : "fail'>Не сдано") + "</span>") + "</td></tr>";
      });
      html += "</table>";
      html += "<div style='margin-top:16px'><button class='btn danger' id='btn-clear'>Очистить статистику</button></div>";
    } else {
      html += "<div class='empty-note'>Пока нет ни одной попытки. Пройди первый блок!</div>";
    }

    main.innerHTML = html;
    var clearBtn = el("btn-clear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      if (confirm("Удалить всю историю и статистику ошибок?")) {
        localStorage.removeItem(LS_HISTORY);
        localStorage.removeItem(LS_MISSED);
        showStats();
      }
    });
  }

  /* ---------- init ---------- */
  window.App = { goHome: goHome, showStats: showStats };
  goHome();
})();
