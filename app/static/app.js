"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  me: null,
  groups: [],
  words: [],
  settings: loadSettings(),
  session: null,
  greekVoice: null,
};

// ---------- api ----------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && path !== "login") {
    showLogin();
    throw new Error("Нужно войти");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    let msg = data && data.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join("; ");
    throw new Error(msg || res.statusText);
  }
  return data;
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 2500);
}

// ---------- settings ----------

function loadSettings() {
  const defaults = { groups: [], skill: "translate", direction: "gr-ru", answer: "flip", mode: "unlearned", limit: "20" };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem("greek-settings") || "{}") }; }
  catch { return defaults; }
}
function saveSettings() {
  try { localStorage.setItem("greek-settings", JSON.stringify(state.settings)); } catch { /* ignore */ }
}

// ---------- auth ----------

function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("#login-error").textContent = "";
  try {
    state.me = await api("login", { method: "POST", body: { username: f.username.value, password: f.password.value } });
    f.password.value = "";
    await enterApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

async function enterApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#me-name").textContent = state.me.username;
  await loadGroups();
  route();
}

// ---------- routing ----------

function route() {
  const tab = (location.hash || "#study").slice(1);
  const valid = ["study", "words", "progress", "settings"].includes(tab) ? tab : "study";
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "view-" + valid));
  $$(".topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === valid));
  if (valid === "study" && !state.session) renderSetup();
  if (valid === "words") loadWords();
  if (valid === "progress") loadProgress();
  if (valid === "settings") renderVoiceInfo();
}
window.addEventListener("hashchange", route);

// ---------- groups ----------

async function loadGroups() {
  state.groups = await api("groups");
  const ids = new Set(state.groups.map((g) => g.id));
  state.settings.groups = state.settings.groups.filter((id) => ids.has(id));
}

// ---------- study: setup ----------

const PERSONS = ["εγώ", "εσύ", "αυτός", "εμείς", "εσείς", "αυτοί"];
// Per skill: which groups count of learned items to show on the group chips.
const LEARNED_KEY = { translate: "learned", aorist: "aorist_learned", aorist_conj: "conj_learned" };
const isVerbSkill = (skill) => skill === "aorist" || skill === "aorist_conj";

// The verb drills only make sense for groups that have verbs with a past form.
function visibleGroups() {
  return isVerbSkill(state.settings.skill) ? state.groups.filter((g) => g.verbs) : state.groups;
}

function selectedGroups() {
  const visible = new Set(visibleGroups().map((g) => g.id));
  return state.settings.groups.filter((id) => visible.has(id));
}

function renderSetup() {
  $("#study-setup").classList.remove("hidden");
  $("#study-card").classList.add("hidden");
  $("#study-summary").classList.add("hidden");

  const verbs = isVerbSkill(state.settings.skill);
  const learnedKey = LEARNED_KEY[state.settings.skill] || "learned";
  $("#field-direction").classList.toggle("hidden", verbs);
  const chips = $("#group-chips");
  chips.innerHTML = visibleGroups().map((g) => `
    <button class="chip ${state.settings.groups.includes(g.id) ? "on" : ""}" data-id="${g.id}">
      ${esc(g.name)}<small>${g[learnedKey]}/${verbs ? g.verbs : g.total}</small>
    </button>`).join("");
  chips.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    const id = Number(c.dataset.id);
    const sel = state.settings.groups;
    state.settings.groups = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    saveSettings();
    c.classList.toggle("on");
    updateToggleAll();
  }));
  updateToggleAll();

  $$(".seg").forEach((seg) => {
    const name = seg.dataset.name;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === String(state.settings[name])));
  });
}

function updateToggleAll() {
  const visible = visibleGroups();
  const all = visible.length && selectedGroups().length === visible.length;
  $("#toggle-all-groups").textContent = all ? "снять все" : "выбрать все";
}

$("#toggle-all-groups").addEventListener("click", () => {
  const visible = visibleGroups().map((g) => g.id);
  const all = selectedGroups().length === visible.length;
  const rest = state.settings.groups.filter((id) => !visible.includes(id));
  state.settings.groups = all ? rest : [...rest, ...visible];
  saveSettings();
  renderSetup();
});

$$(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.settings[seg.dataset.name] = b.dataset.value;
  saveSettings();
  seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  if (seg.dataset.name === "skill") renderSetup();
}));

$("#start-btn").addEventListener("click", startSession);
$("#summary-again-btn").addEventListener("click", startSession);
$("#summary-setup-btn").addEventListener("click", () => { state.session = null; renderSetup(); });
$("#stop-btn").addEventListener("click", () => finishSession());

async function startSession() {
  const s = state.settings;
  $("#study-error").textContent = "";
  const groups = selectedGroups();
  const verbs = isVerbSkill(s.skill);
  if (!groups.length) {
    $("#study-error").textContent = "Выбери хотя бы одну группу";
    renderSetup();
    return;
  }
  let cards;
  try {
    cards = await api(`study?groups=${groups.join(",")}&mode=${s.mode}&limit=${s.limit}&skill=${s.skill}`);
  } catch (err) {
    $("#study-error").textContent = err.message;
    return;
  }
  // Forms are generated by rules; a hand-entered past form may not fit them.
  if (s.skill === "aorist_conj") cards = cards.filter((c) => c.forms.length);
  if (!cards.length) {
    renderSetup();
    const what = verbs ? "глаголов" : "слов";
    $("#study-error").textContent = s.mode === "learned"
      ? `В выбранных группах пока нет выученных ${what}`
      : "В выбранных группах всё выучено! Выбери другие группы или «Все».";
    return;
  }
  const queue = cards.map((card) => ({
    card,
    dir: verbs ? s.skill : s.direction === "mixed" ? (Math.random() < 0.5 ? "gr-ru" : "ru-gr") : s.direction,
    person: Math.floor(Math.random() * PERSONS.length),
    retry: 0,
  }));
  state.session = { queue, pos: 0, unique: cards.length, correct: 0, wrongIds: new Set(), answered: new Set(), answer: s.answer, skill: s.skill, phase: "ask" };
  $("#study-setup").classList.add("hidden");
  $("#study-summary").classList.add("hidden");
  $("#study-card").classList.remove("hidden");
  showCard();
}

// ---------- study: card ----------

function currentItem() {
  const s = state.session;
  return s && s.queue[s.pos];
}

// Verb drills show the present form and ask for the past one:
// "aorist" in the 1st person, "aorist_conj" in a random person.
const promptOf = ({ card, dir }) => (dir === "ru-gr" ? card.russian : card.greek);
function answerOf({ card, dir, person }) {
  if (dir === "aorist") return card.aorist;
  if (dir === "aorist_conj") return card.forms[person];
  return dir === "gr-ru" ? card.russian : card.greek;
}
const greekAnswer = (item) => item.dir !== "gr-ru";
// "ήμασταν / ήμαστε" -> "ήμασταν": what to pronounce.
const firstVariant = (s) => s.split(" / ")[0];

function verbSub(item) {
  const { card, dir, person } = item;
  if (dir === "aorist") return `${esc(card.russian)} · аорист, εγώ`;
  return `<b>${PERSONS[person]}</b> · ${esc(card.russian)} · аорист`;
}

function verbNote(item) {
  const { card, dir, person } = item;
  let html = card.hint ? `<div class="verb-hint">${esc(card.hint)}</div>` : "";
  if (card.forms?.length) {
    html += `<div class="conj-table">${card.forms.map((f, i) =>
      `<span>${PERSONS[i]}</span><span class="${dir === "aorist_conj" && i === person ? "on" : ""}">${esc(f)}</span>`).join("")}</div>`;
  }
  return html;
}

function showCard() {
  const s = state.session;
  const item = currentItem();
  if (!item) return finishSession();
  const { card, dir } = item;
  s.phase = "ask";

  $("#session-count").textContent = `${Math.min(s.answered.size + 1, s.unique)} / ${s.unique}`;
  $("#session-progress").style.width = `${(100 * s.answered.size) / s.unique}%`;
  $("#card").classList.remove("flash-good", "flash-bad");
  $("#card-group").textContent = card.group_name;
  $("#card-box").innerHTML = item.retry ? "повтор" : boxDots(card.box);
  $("#card-prompt").textContent = promptOf(item);
  const verb = isVerbSkill(dir);
  $("#card-sub").innerHTML = verb ? verbSub(item) : "";
  $("#card-sub").classList.toggle("hidden", !verb);
  $("#answer-text").textContent = answerOf(item);
  // In verb drills the note ("прош.: …") would only repeat the answer: show the rule and all persons.
  if (verb) $("#card-note").innerHTML = verbNote(item);
  else $("#card-note").textContent = card.note || "";
  $("#card-answer").classList.add("hidden");
  $("#speak-prompt").classList.toggle("hidden", !state.greekVoice || dir === "ru-gr");
  $("#speak-answer").classList.toggle("hidden", !state.greekVoice || !greekAnswer(item));
  updateLearnedBtn();

  const typing = s.answer === "type";
  $("#type-area").classList.toggle("hidden", !typing);
  $("#actions-reveal").classList.toggle("hidden", typing);
  $("#actions-check").classList.toggle("hidden", !typing);
  $("#actions-grade").classList.add("hidden");
  $("#actions-typed").classList.add("hidden");
  if (typing) {
    const input = $("#type-input");
    input.value = "";
    input.disabled = false;
    input.lang = greekAnswer(item) ? "el" : "ru";
    input.placeholder = verb ? "Форма с ударением, например έγραψα" : greekAnswer(item) ? "Ответ по-гречески" : "Ответ по-русски";
    $("#type-result").textContent = "";
    $("#type-result").className = "";
    input.focus({ preventScroll: true });
  }
}

function boxDots(box) {
  return `уровень <span class="box-dots">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= box ? "f" : ""}"></i>`).join("")}</span>`;
}

function reveal() {
  const s = state.session;
  if (!s || s.phase !== "ask") return;
  s.phase = "graded-wait";
  $("#card-answer").classList.remove("hidden");
  $("#actions-reveal").classList.add("hidden");
  $("#actions-grade").classList.remove("hidden");
  if (greekAnswer(currentItem())) speak(firstVariant(answerOf(currentItem())));
}

function checkTyped(giveUp = false) {
  const s = state.session;
  if (!s || s.phase !== "ask") return;
  const item = currentItem();
  const input = $("#type-input");
  const verdict = giveUp ? "wrong" : judge(input.value, answerOf(item), greekAnswer(item));
  input.disabled = true;
  s.phase = "typed";
  s.typedCorrect = verdict !== "wrong";
  const res = $("#type-result");
  res.className = s.typedCorrect ? "good" : "bad";
  res.textContent = {
    exact: "✓ Верно!",
    close: "✓ Почти верно — проверь написание",
    accent: "✕ Ударение не там",
    noaccent: "✕ Поставь ударение",
    wrong: giveUp ? "" : "✕ Неверно",
  }[verdict];
  $("#card-answer").classList.remove("hidden");
  $("#actions-check").classList.add("hidden");
  $("#actions-typed").classList.remove("hidden");
  $("#override-btn").classList.toggle("hidden", s.typedCorrect || giveUp);
  $("#card").classList.add(s.typedCorrect ? "flash-good" : "flash-bad");
  if (greekAnswer(item)) speak(firstVariant(answerOf(item)));
  $("#next-btn").focus({ preventScroll: true });
}

async function grade(correct) {
  const s = state.session;
  if (!s) return;
  const item = currentItem();
  s.phase = "busy";
  const first = !s.answered.has(item.card.id);
  s.answered.add(item.card.id);
  if (first && correct) s.correct += 1;
  if (!correct) {
    s.wrongIds.add(item.card.id);
    // Show the card again a few cards later, at most twice per session.
    if (item.retry < 2) {
      const at = Math.min(s.pos + 4, s.queue.length);
      s.queue.splice(at, 0, { ...item, retry: item.retry + 1 });
    }
  }
  api("review", { method: "POST", body: { word_id: item.card.id, correct, direction: item.dir } })
    .then((r) => { item.card.box = r.box; })
    .catch((err) => toast("Не сохранилось: " + err.message));
  s.pos += 1;
  showCard();
}

async function toggleLearnedCurrent() {
  const item = currentItem();
  if (!item) return;
  const learned = !item.card.learned;
  try {
    await api(`words/${item.card.id}/learned`, { method: "POST", body: { learned, skill: state.session.skill } });
    item.card.learned = learned ? 1 : 0;
    state.session.queue.forEach((q) => { if (q.card.id === item.card.id) q.card.learned = item.card.learned; });
    updateLearnedBtn();
    toast(learned ? "Отмечено как выученное ⭐" : "Снята отметка «выучено»");
  } catch (err) { toast(err.message); }
}

function updateLearnedBtn() {
  const item = currentItem();
  const on = item && item.card.learned;
  const b = $("#learned-btn");
  b.classList.toggle("on", !!on);
  b.textContent = on ? "★ Выучено (снять отметку)" : "☆ Отметить выученным";
}

function finishSession() {
  const s = state.session;
  if (!s) return renderSetup();
  $("#study-card").classList.add("hidden");
  const noun = isVerbSkill(s.skill) ? ["глагол", "глагола", "глаголов"] : ["слово", "слова", "слов"];
  $("#study-summary").classList.remove("hidden");
  const total = s.answered.size;
  const pct = total ? Math.round((100 * s.correct) / total) : 0;
  $("#summary-stats").innerHTML = `
    <div class="stat"><b>${total}</b><span>${plural(total, ...noun)}</span></div>
    <div class="stat"><b>${s.correct}</b><span>с первого раза</span></div>
    <div class="stat"><b>${pct}%</b><span>точность</span></div>`;
  const byId = new Map(s.queue.map((q) => [q.card.id, q.card]));
  const wrong = [...s.wrongIds].map((id) => byId.get(id));
  const line = (c) => isVerbSkill(s.skill)
    ? `<b>${esc(c.greek)} → ${esc(c.aorist)}</b><span class="muted">${esc(c.russian)}</span>`
    : `<b>${esc(c.greek)}</b><span class="muted">${esc(c.russian)}</span>`;
  $("#summary-wrong").innerHTML = wrong.length
    ? `<h3>Стоит повторить</h3><div class="wrong-list">${wrong.map((c) => `<div>${line(c)}</div>`).join("")}</div>`
    : "";
  state.session = null;
  loadGroups().catch(() => {});
}

$("#reveal-btn").addEventListener("click", reveal);
$("#card").addEventListener("click", (e) => {
  if (e.target.closest("button, input")) return;
  if (state.session && state.session.answer === "flip") reveal();
});
$("#right-btn").addEventListener("click", () => grade(true));
$("#wrong-btn").addEventListener("click", () => grade(false));
$("#check-btn").addEventListener("click", () => checkTyped());
$("#dontknow-btn").addEventListener("click", () => checkTyped(true));
$("#next-btn").addEventListener("click", () => grade(state.session.typedCorrect));
$("#override-btn").addEventListener("click", () => grade(true));
$("#learned-btn").addEventListener("click", toggleLearnedCurrent);
$("#type-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); checkTyped(); }
});
$("#speak-prompt").addEventListener("click", () => speak(currentItem().card.greek));
$("#speak-answer").addEventListener("click", () => speak(firstVariant(answerOf(currentItem()))));

document.addEventListener("keydown", (e) => {
  const s = state.session;
  if (!s || $("#study-card").classList.contains("hidden") || $("#modal").open) return;
  if (e.target.tagName === "INPUT" && s.phase === "ask") return;
  if (s.phase === "ask" && s.answer === "flip" && (e.key === " " || e.key === "Enter")) { e.preventDefault(); reveal(); }
  else if (s.phase === "graded-wait" && (e.key === "ArrowRight" || e.key === "2")) grade(true);
  else if (s.phase === "graded-wait" && (e.key === "ArrowLeft" || e.key === "1")) grade(false);
  else if (s.phase === "typed" && e.key === "Enter") { e.preventDefault(); grade(s.typedCorrect); }
  else if ((e.key === "l" || e.key === "д") && e.target.tagName !== "INPUT") toggleLearnedCurrent();
});

// ---------- answer checking ----------

const ARTICLES = /^(ο|η|το|οι|τα|τον|την|τη|του|της|των)\s+/;

const STRESS = "\u0301";
const DIAERESIS = "\u0308";

// keepStress: keep the Greek stress mark and diaeresis (ά, ϊ), drop everything else.
function norm(s, keepStress = false) {
  return s.toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, (m) => (keepStress && (m === STRESS || m === DIAERESIS) ? m : ""))
    .replace(/ς/g, "σ").replace(/ё/g, "е")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[;;?!.,…«»"'’:]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function variants(target, greek, keepStress = false) {
  const parts = [target, ...target.split(/[;,/]|\s=\s/)];
  const out = new Set();
  for (const p of parts) {
    const n = norm(p, keepStress);
    if (!n) continue;
    out.add(n);
    if (greek) out.add(n.replace(ARTICLES, ""));
  }
  return out;
}

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// exact | close (one typo) | accent (letters right, stress wrong) | noaccent (no stress at all) | wrong.
// For Greek the stress matters: a misplaced or missing one is a wrong answer.
function judge(input, target, greek) {
  let a = norm(input);
  if (!a) return "wrong";
  if (greek) a = a.replace(ARTICLES, "");
  const vs = variants(target, greek);
  if (vs.has(a)) {
    if (!greek) return "exact";
    const strict = norm(input, true).replace(ARTICLES, "");
    if (variants(target, true, true).has(strict)) return "exact";
    return strict.includes(STRESS) ? "accent" : "noaccent";
  }
  for (const v of vs) if (v.length >= 5 && lev(a, v) <= 1) return "close";
  return "wrong";
}

// ---------- speech ----------

function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const voices = speechSynthesis.getVoices();
  state.greekVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("el")) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

function speak(text) {
  if (!state.greekVoice) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\.\.\./g, ""));
  u.voice = state.greekVoice;
  u.lang = state.greekVoice.lang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

function renderVoiceInfo() {
  $("#voice-info").textContent = state.greekVoice
    ? `Греческий голос: ${state.greekVoice.name}. Кнопка 🔊 появляется на карточках.`
    : "В этом браузере нет греческого голоса — озвучка недоступна. На iPhone/Mac её можно добавить в настройках системы (Универсальный доступ → Устный контент → Голоса → Ελληνικά).";
}

// ---------- words ----------

async function loadWords() {
  try {
    [state.words] = await Promise.all([api("words"), loadGroups()]);
  } catch (err) { toast(err.message); return; }
  const sel = $("#words-group");
  const current = sel.value;
  sel.innerHTML = `<option value="">Все группы</option>` +
    state.groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.total})</option>`).join("");
  if (state.groups.some((g) => String(g.id) === current)) sel.value = current;
  renderWords();
}

function renderWords() {
  const gid = $("#words-group").value;
  const status = $("#words-status").value;
  const q = norm($("#words-search").value);
  $("#group-tools").classList.toggle("hidden", !gid);
  const list = state.words.filter((w) =>
    (!gid || String(w.group_id) === gid) &&
    (status === "all" || (status === "learned" ? w.learned : !w.learned)) &&
    (!q || norm(w.greek).includes(q) || norm(w.russian).includes(q)));
  const learned = list.filter((w) => w.learned).length;
  $("#words-count").textContent = `${list.length} слов · выучено ${learned}`;
  const groupName = new Map(state.groups.map((g) => [g.id, g.name]));
  $("#words-list").innerHTML = list.slice(0, 1000).map((w) => `
    <li data-id="${w.id}">
      <button class="star ${w.learned ? "on" : ""}" data-act="star" title="Выучено">★</button>
      <div class="w-main" data-act="edit">
        <div class="w-gr">${esc(w.greek)}${w.box ? `<span class="box-dots">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= w.box ? "f" : ""}"></i>`).join("")}</span>` : ""}</div>
        <div class="w-ru">${esc(w.russian)}${gid ? "" : ` · <span class="w-note">${esc(groupName.get(w.group_id))}</span>`}</div>
        ${w.note ? `<div class="w-note">${esc(w.note)}</div>` : ""}
      </div>
    </li>`).join("") || `<li class="muted">Ничего не найдено</li>`;
}

["#words-group", "#words-status"].forEach((s) => $(s).addEventListener("change", renderWords));
$("#words-search").addEventListener("input", renderWords);

$("#words-list").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  const act = e.target.closest("[data-act]");
  if (!li || !act) return;
  const w = state.words.find((x) => x.id === Number(li.dataset.id));
  if (act.dataset.act === "star") {
    try {
      await api(`words/${w.id}/learned`, { method: "POST", body: { learned: !w.learned } });
      w.learned = w.learned ? 0 : 1;
      renderWords();
    } catch (err) { toast(err.message); }
  } else {
    editWord(w);
  }
});

function groupOptions(selected) {
  return state.groups.map((g) => `<option value="${g.id}" ${g.id === selected ? "selected" : ""}>${esc(g.name)}</option>`).join("");
}

function wordForm(w = {}) {
  const def = w.group_id || Number($("#words-group").value) || state.groups[0]?.id;
  return `
    <label>Группа</label><select name="group_id">${groupOptions(def)}</select>
    <label>По-гречески</label><input name="greek" lang="el" value="${esc(w.greek)}" required autocapitalize="none">
    <label>По-русски</label><input name="russian" value="${esc(w.russian)}" required>
    <label>Заметка (необязательно)</label><input name="note" value="${esc(w.note)}" placeholder="прош. время, формы, пример…">
    <label>Аорист (для глаголов)</label><input name="aorist" lang="el" value="${esc(w.aorist)}" placeholder="έγραψα" autocapitalize="none">`;
}

function readWordForm(form) {
  return {
    group_id: Number(form.group_id.value),
    greek: form.greek.value.trim(),
    russian: form.russian.value.trim(),
    note: form.note.value.trim(),
    aorist: form.aorist.value.trim(),
  };
}

$("#add-word-btn").addEventListener("click", () => {
  if (!state.groups.length) return toast("Сначала создай группу");
  openModal("Новое слово", wordForm(), "Добавить", async (form) => {
    await api("words", { method: "POST", body: readWordForm(form) });
    toast("Слово добавлено");
    loadWords();
  }, { keepOpen: true });
});

function editWord(w) {
  openModal("Редактировать слово", wordForm(w) +
    `<button type="button" class="link danger" id="delete-word">Удалить слово</button>`, "Сохранить", async (form) => {
    await api(`words/${w.id}`, { method: "PATCH", body: readWordForm(form) });
    loadWords();
  });
  $("#delete-word").addEventListener("click", async () => {
    if (!confirm(`Удалить «${w.greek}»?`)) return;
    await api(`words/${w.id}`, { method: "DELETE" });
    $("#modal").close();
    loadWords();
  });
}

$("#bulk-btn").addEventListener("click", () => {
  if (!state.groups.length) return toast("Сначала создай группу");
  const def = Number($("#words-group").value) || state.groups[0].id;
  openModal("Импорт списком", `
    <label>Группа</label><select name="group_id">${groupOptions(def)}</select>
    <label>Одно слово в строке: «греческое — русское — заметка»</label>
    <textarea name="text" lang="el" placeholder="η θάλασσα — море&#10;τρέχω — бегать — прош.: έτρεξα&#10;γρήγορος — быстрый"></textarea>
    <p class="muted" style="margin:0;font-size:13px">Разделитель: тире с пробелами, | или табуляция (можно вставить из таблицы). Повторы в группе пропускаются.</p>`,
  "Импортировать", async (form) => {
    const r = await api("words/bulk", { method: "POST", body: { group_id: Number(form.group_id.value), text: form.text.value } });
    let msg = `Добавлено ${r.added}`;
    if (r.skipped) msg += `, пропущено повторов ${r.skipped}`;
    if (r.bad.length) msg += `, не разобрано строк ${r.bad.length}`;
    toast(msg);
    loadWords();
  });
});

$("#add-group-btn").addEventListener("click", () => {
  openModal("Новая группа", `<label>Название</label><input name="name" required placeholder="например, «Еда» или «Урок 5»">`, "Создать", async (form) => {
    const g = await api("groups", { method: "POST", body: { name: form.name.value } });
    await loadWords();
    $("#words-group").value = String(g.id);
    renderWords();
  });
});

$("#rename-group-btn").addEventListener("click", () => {
  const g = state.groups.find((x) => String(x.id) === $("#words-group").value);
  if (!g) return;
  openModal("Переименовать группу", `<label>Название</label><input name="name" required value="${esc(g.name)}">`, "Сохранить", async (form) => {
    await api(`groups/${g.id}`, { method: "PATCH", body: { name: form.name.value } });
    loadWords();
  });
});

$("#delete-group-btn").addEventListener("click", async () => {
  const g = state.groups.find((x) => String(x.id) === $("#words-group").value);
  if (!g) return;
  if (!confirm(`Удалить группу «${g.name}» вместе со всеми словами (${g.total})? Это нельзя отменить.`)) return;
  try {
    await api(`groups/${g.id}`, { method: "DELETE" });
    $("#words-group").value = "";
    loadWords();
  } catch (err) { toast(err.message); }
});

// ---------- modal ----------

let modalHandler = null;

function openModal(title, bodyHtml, okText, onOk, { keepOpen = false } = {}) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  $("#modal-ok").textContent = okText;
  $("#modal-error").textContent = "";
  modalHandler = { onOk, keepOpen };
  $("#modal").showModal();
  const first = $("#modal-body").querySelector("input, textarea");
  if (first && !("ontouchstart" in window)) first.focus();
}

$("#modal-form").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value === "cancel") return;
  e.preventDefault();
  const form = e.target;
  const ok = $("#modal-ok");
  ok.disabled = true;
  $("#modal-error").textContent = "";
  try {
    await modalHandler.onOk(form);
    if (modalHandler.keepOpen) {
      // Adding words one after another: clear the text fields, keep the group.
      form.querySelectorAll("input").forEach((i) => { i.value = ""; });
      form.querySelector("input")?.focus();
    } else {
      $("#modal").close();
    }
  } catch (err) {
    $("#modal-error").textContent = err.message;
  } finally {
    ok.disabled = false;
  }
});

// ---------- progress ----------

async function loadProgress() {
  const el = $("#progress-content");
  let data;
  try { data = await api("stats"); } catch (err) { el.textContent = err.message; return; }
  const users = [...data.users].sort((a, b) => (b.id === data.me) - (a.id === data.me));
  el.innerHTML = `<div class="users">${users.map((u) => userCard(u, data)).join("")}</div>`;
}

function userCard(u, data) {
  const pct = data.total ? Math.round((100 * u.learned) / data.total) : 0;
  const max = Math.max(1, ...u.daily.map((d) => d.answers));
  const fmt = (iso) => { const [, m, d] = iso.split("-"); return `${d}.${m}`; };
  const week = u.daily.slice(-7);
  const weekAnswers = week.reduce((s, d) => s + d.answers, 0);
  const weekLearned = week.reduce((s, d) => s + d.learned, 0);
  return `
    <div class="ucard ${u.id === data.me ? "me" : ""}">
      <h3><span>${esc(u.username)}${u.id === data.me ? " (я)" : ""}</span><span class="muted" style="font-size:14px">🔥 ${u.streak} ${plural(u.streak, "день", "дня", "дней")} подряд</span></h3>
      <div class="big-pct">${pct}%</div>
      <div class="muted" style="margin-bottom:6px">выучено ${u.learned} из ${data.total} слов</div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="mini-stats">
        <div><b>${u.today}</b><span>ответов сегодня</span></div>
        <div><b>${u.accuracy ?? "—"}${u.accuracy != null ? "%" : ""}</b><span>точность</span></div>
        <div><b>${u.seen}</b><span>слов встречено</span></div>
      </div>
      <div class="section-label">Активность за 30 дней · за неделю ${weekAnswers} ответов, +${weekLearned} выучено</div>
      <div class="chart">${u.daily.map((d) => `<div class="${d.answers ? "" : "zero"}" style="height:${d.answers ? Math.max(4, (100 * d.answers) / max) : 3}%" title="${fmt(d.date)}: ${d.answers} ответов, ${d.correct} верно, выучено ${d.learned}"></div>`).join("")}</div>
      <div class="chart-axis"><span>${fmt(u.daily[0].date)}</span><span>сегодня</span></div>
      ${data.verbs ? `
      <div class="section-label">Аорист · выучено ${u.aorist_learned} из ${data.verbs} глаголов</div>
      <div class="bar"><div style="width:${(100 * u.aorist_learned) / data.verbs}%"></div></div>
      <div class="section-label">Аорист по лицам · выучено ${u.conj_learned} из ${data.verbs} глаголов</div>
      <div class="bar"><div style="width:${(100 * u.conj_learned) / data.verbs}%"></div></div>` : ""}
      <div class="section-label">По группам</div>
      <div class="glist">${u.groups.filter((g) => g.total).map((g) => `
        <div>
          <div class="gl-head"><span>${esc(g.name)}</span><span class="muted">${g.learned}/${g.total}</span></div>
          <div class="bar"><div style="width:${(100 * g.learned) / g.total}%"></div></div>
        </div>`).join("")}</div>
    </div>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- settings ----------

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $("#password-msg");
  try {
    await api("password", { method: "POST", body: { old: f.old.value, new: f.new.value } });
    f.reset();
    msg.textContent = "Пароль изменён ✓";
  } catch (err) { msg.textContent = err.message; }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("logout", { method: "POST" }).catch(() => {});
  state.me = null;
  state.session = null;
  showLogin();
});

$("#reset-btn").addEventListener("click", async () => {
  if (!confirm("Сбросить весь твой прогресс: отметки «выучено», уровни и историю ответов? Слова останутся.")) return;
  await api("progress/reset", { method: "POST" });
  await loadGroups();
  toast("Прогресс сброшен");
});

// ---------- boot ----------

(async () => {
  try {
    state.me = await api("me");
    await enterApp();
  } catch {
    showLogin();
  }
})();
