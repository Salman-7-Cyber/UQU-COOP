import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, doc, setDoc, addDoc, getDocs, getDoc, query, orderBy, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ---------- constants ---------- */
const PHASE_LABELS = { grc: "GRC", blue: "Blue Team", red: "Red Team", general: "عام / General" };
const PHASE_LABELS_AR = { grc: "الحوكمة والمخاطر والامتثال", blue: "الفريق الأزرق", red: "الفريق الأحمر", general: "عام" };
const DAY_NAMES_AR = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];

let currentUser = null;
let tasksCache = [];
let todosCache = [];
let settingsCache = null;
let reportLangPrimary = "ar"; // 'ar' | 'en'

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmtDate = (d) => d.toISOString().slice(0,10);
const parseDate = (s) => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function weekKey(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getFullYear()}-W${String(getISOWeek(d)).padStart(2,"0")}`;
}
function monthKey(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/* ---------- multi-day task helpers ---------- */
function taskDates(t) {
  const start = parseDate(t.date);
  const end = t.endDate ? parseDate(t.endDate) : start;
  const out = [];
  let cur = new Date(start);
  while (cur <= end) { out.push(fmtDate(cur)); cur.setDate(cur.getDate()+1); }
  return out.length ? out : [t.date];
}
function taskWeekKeys(t) { return [...new Set(taskDates(t).map(weekKey))]; }
function taskMonthKeys(t) { return [...new Set(taskDates(t).map(monthKey))]; }
function taskSpanLabel(t) {
  if (!t.endDate || t.endDate === t.date) return t.date;
  const days = taskDates(t).length;
  return `${t.date} → ${t.endDate} (${days} أيام)`;
}

/* ---------- phase calculation ---------- */
function computePhase(dateStr) {
  if (!settingsCache || !settingsCache.startDate) return "general";
  const start = parseDate(settingsCache.startDate);
  const target = parseDate(dateStr);
  const grcMonths = Number(settingsCache.grcMonths || 2);
  const phaseMonths = Number(settingsCache.phaseMonths || 2);
  const grcEnd = addMonths(start, grcMonths);
  const blueEnd = addMonths(grcEnd, phaseMonths);
  if (target < start) return "general";
  if (target < grcEnd) return "grc";
  if (target < blueEnd) return "blue";
  return "red";
}

/* ---------- AUTH ---------- */
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authEmail").value.trim();
  const pass = $("#authPassword").value;
  $("#authError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    $("#authError").textContent = translateAuthError(err.code);
  }
});

$("#authRegisterBtn").addEventListener("click", async () => {
  const email = $("#authEmail").value.trim();
  const pass = $("#authPassword").value;
  $("#authError").textContent = "";
  if (!email || pass.length < 6) {
    $("#authError").textContent = "أدخل بريد وكلمة مرور (٦ أحرف على الأقل) أولاً";
    return;
  }
  try {
    await createUserWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    $("#authError").textContent = translateAuthError(err.code);
  }
});

$("#logoutBtn").addEventListener("click", () => signOut(auth));

function translateAuthError(code) {
  const map = {
    "auth/invalid-email": "البريد الإلكتروني غير صالح",
    "auth/user-not-found": "لا يوجد حساب بهذا البريد — جرّب إنشاء حساب",
    "auth/wrong-password": "كلمة المرور غير صحيحة",
    "auth/email-already-in-use": "هذا البريد مسجّل بالفعل — استخدم دخول",
    "auth/weak-password": "كلمة المرور ضعيفة (٦ أحرف على الأقل)",
    "auth/invalid-credential": "بيانات الدخول غير صحيحة",
  };
  return map[code] || "حدث خطأ، حاول مرة أخرى";
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    $("#authGate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await loadSettings();
    await loadTasks();
    await loadTodos();
    initDateDefaults();
    renderAll();
  } else {
    currentUser = null;
    $("#app").classList.add("hidden");
    $("#authGate").classList.remove("hidden");
  }
});

/* ---------- FIRESTORE: settings ---------- */
async function loadSettings() {
  const ref = doc(db, "users", currentUser.uid, "meta", "settings");
  const snap = await getDoc(ref);
  settingsCache = snap.exists() ? snap.data() : {
    uni: "", name: "", studentId: "", phone: "", email: "",
    college: "", dept: "", specialization: "", org: "", supervisor: "",
    startDate: fmtDate(new Date()), grcMonths: 2, phaseMonths: 2
  };
  $("#setUni").value = settingsCache.uni || "";
  $("#setName").value = settingsCache.name || "";
  $("#setId").value = settingsCache.studentId || "";
  $("#setPhone").value = settingsCache.phone || "";
  $("#setEmail").value = settingsCache.email || "";
  $("#setCollege").value = settingsCache.college || "";
  $("#setDept").value = settingsCache.dept || "";
  $("#setSpecialization").value = settingsCache.specialization || "";
  $("#setOrg").value = settingsCache.org || "";
  $("#setSupervisor").value = settingsCache.supervisor || "";
  $("#setStart").value = settingsCache.startDate || fmtDate(new Date());
  $("#setGrcMonths").value = settingsCache.grcMonths || 2;
  $("#setPhaseMonths").value = settingsCache.phaseMonths || 2;
}

$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  settingsCache = {
    uni: $("#setUni").value.trim(),
    name: $("#setName").value.trim(),
    studentId: $("#setId").value.trim(),
    phone: $("#setPhone").value.trim(),
    email: $("#setEmail").value.trim(),
    college: $("#setCollege").value.trim(),
    dept: $("#setDept").value.trim(),
    specialization: $("#setSpecialization").value.trim(),
    org: $("#setOrg").value.trim(),
    supervisor: $("#setSupervisor").value.trim(),
    startDate: $("#setStart").value,
    grcMonths: Number($("#setGrcMonths").value || 2),
    phaseMonths: Number($("#setPhaseMonths").value || 2),
  };
  const ref = doc(db, "users", currentUser.uid, "meta", "settings");
  await setDoc(ref, settingsCache);
  $("#setSaveStatus").textContent = "تم الحفظ ✓";
  setTimeout(() => $("#setSaveStatus").textContent = "", 2000);
  renderAll();
});

/* ---------- FIRESTORE: tasks ---------- */
async function loadTasks() {
  const q = query(collection(db, "users", currentUser.uid, "tasks"), orderBy("date", "desc"));
  const snap = await getDocs(q);
  tasksCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

$("#taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const endDateVal = $("#taskEndDate").value;
  const entry = {
    date: $("#taskDate").value,
    endDate: endDateVal && endDateVal >= $("#taskDate").value ? endDateVal : "",
    phase: $("#taskPhase").value,
    titleAr: $("#taskTitleAr").value.trim(),
    titleEn: $("#taskTitleEn").value.trim(),
    descAr: $("#taskDescAr").value.trim(),
    descEn: $("#taskDescEn").value.trim(),
    tools: $("#taskTools").value.trim(),
    hours: Number($("#taskHours").value || 0),
    outcome: $("#taskOutcome").value.trim(),
    notes: $("#taskNotes").value.trim(),
    createdAt: Date.now(),
  };
  if (!entry.date || !entry.titleAr) return;
  await addDoc(collection(db, "users", currentUser.uid, "tasks"), entry);
  $("#taskForm").reset();
  initDateDefaults();
  $("#saveStatus").textContent = "تم الحفظ ✓";
  setTimeout(() => $("#saveStatus").textContent = "", 2000);
  await loadTasks();
  renderAll();
});

function initDateDefaults() {
  $("#taskDate").value = fmtDate(new Date());
  $("#taskPhase").value = computePhase(fmtDate(new Date()));
}
$("#taskDate").addEventListener("change", () => {
  $("#taskPhase").value = computePhase($("#taskDate").value);
});

/* ---------- FIRESTORE: todos ---------- */
async function loadTodos() {
  const q = query(collection(db, "users", currentUser.uid, "todos"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  todosCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

$("#todoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const entry = {
    titleAr: $("#todoTitle").value.trim(),
    phase: $("#todoPhase").value,
    priority: $("#todoPriority").value,
    deadline: $("#todoDeadline").value || "",
    notes: $("#todoNotes").value.trim(),
    status: "todo",
    createdAt: Date.now(),
  };
  if (!entry.titleAr) return;
  await addDoc(collection(db, "users", currentUser.uid, "todos"), entry);
  $("#todoForm").reset();
  $("#todoPriority").value = "med";
  $("#todoSaveStatus").textContent = "تم الحفظ ✓";
  setTimeout(() => $("#todoSaveStatus").textContent = "", 2000);
  await loadTodos();
  renderTodos();
});

async function moveTodo(id, newStatus) {
  const t = todosCache.find(x => x.id === id);
  if (!t) return;
  const wasDone = t.status === "done";
  await updateDoc(doc(db, "users", currentUser.uid, "todos", id), { status: newStatus });
  if (newStatus === "done" && !wasDone) {
    await addDoc(collection(db, "users", currentUser.uid, "tasks"), {
      date: fmtDate(new Date()),
      endDate: "",
      phase: t.phase,
      titleAr: t.titleAr,
      titleEn: "",
      descAr: t.notes || "",
      descEn: "",
      tools: "",
      hours: 0,
      outcome: "تم إنجازها من قائمة المهام",
      notes: "",
      createdAt: Date.now(),
    });
    await loadTasks();
    renderAll();
  }
  await loadTodos();
  renderTodos();
}

async function deleteTodo(id) {
  await deleteDoc(doc(db, "users", currentUser.uid, "todos", id));
  await loadTodos();
  renderTodos();
}
window.moveTodo = moveTodo;
window.deleteTodo = deleteTodo;

const PRIORITY_LABELS = { high: "عالية", med: "متوسطة", low: "منخفضة" };
const PRIORITY_RANK = { high: 0, med: 1, low: 2 };

function todoCardHTML(t) {
  const today = fmtDate(new Date());
  const overdue = t.deadline && t.deadline < today && t.status !== "done";
  const prevStatus = { in_progress: "todo", done: "in_progress" }[t.status];
  const nextStatus = { todo: "in_progress", in_progress: "done" }[t.status];
  return `
  <div class="todo-card ${t.phase} ${t.status === "done" ? "done" : ""}">
    <div class="todo-card-title">${escapeHTML(t.titleAr)}</div>
    ${t.notes ? `<div class="todo-card-notes">${escapeHTML(t.notes)}</div>` : ""}
    <div class="todo-card-meta">
      <span class="priority-badge priority-${t.priority}">${PRIORITY_LABELS[t.priority]}</span>
      <span class="tag">${PHASE_LABELS[t.phase]}</span>
      ${t.deadline ? `<span class="deadline-tag ${overdue ? "overdue" : ""}">${overdue ? "متأخرة — " : ""}${t.deadline}</span>` : ""}
    </div>
    <div class="todo-card-actions">
      ${prevStatus ? `<button class="todo-mini-btn" onclick="moveTodo('${t.id}','${prevStatus}')">⬅ رجوع</button>` : ""}
      ${nextStatus ? `<button class="todo-mini-btn" onclick="moveTodo('${t.id}','${nextStatus}')">التالي ➡</button>` : ""}
      <button class="todo-mini-btn danger" onclick="deleteTodo('${t.id}')">حذف</button>
    </div>
  </div>`;
}

/* ---------- TODOS NAV / SUBTABS ---------- */
$$(".subtab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".subtab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".subview").forEach(v => v.classList.remove("active"));
    $(`#subview-${btn.dataset.subview}`).classList.add("active");
  });
});

function renderTodos() {
  if (!$("#view-todos")) return;
  const active = todosCache.filter(t => t.status !== "done");
  const done = todosCache.filter(t => t.status === "done");

  $("#kanbanTodo").innerHTML = todosCache.filter(t => t.status === "todo").map(todoCardHTML).join("") || emptyState();
  $("#kanbanProgress").innerHTML = todosCache.filter(t => t.status === "in_progress").map(todoCardHTML).join("") || emptyState();
  $("#kanbanDone").innerHTML = done.map(todoCardHTML).join("") || emptyState();

  const sorted = [...active].sort((a,b) => {
    const da = a.deadline || "9999-99-99", db_ = b.deadline || "9999-99-99";
    if (da !== db_) return da.localeCompare(db_);
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  });
  const listHTML = (t) => {
    const today = fmtDate(new Date());
    const overdue = t.deadline && t.deadline < today;
    return `<div class="todo-list-item ${t.status === "done" ? "done" : ""}">
      <span class="status-dot ${t.status}"></span>
      <span class="todo-list-title">${escapeHTML(t.titleAr)}</span>
      <span class="tag">${PHASE_LABELS[t.phase]}</span>
      <span class="priority-badge priority-${t.priority}">${PRIORITY_LABELS[t.priority]}</span>
      ${t.deadline ? `<span class="deadline-tag ${overdue ? "overdue" : ""}">${t.deadline}</span>` : ""}
    </div>`;
  };
  $("#todoListView").innerHTML = [...sorted, ...done].map(listHTML).join("") || emptyState();

  /* calendar */
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const deadlineMap = {};
  todosCache.forEach(t => { if (t.deadline) (deadlineMap[t.deadline] ||= []).push(t); });
  let cells = "";
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = fmtDate(new Date(y, m, day));
    const has = !!deadlineMap[ds];
    const overdue = has && ds < fmtDate(today) && deadlineMap[ds].some(t => t.status !== "done");
    cells += `<div class="heat-cell ${has ? "active" : ""} ${overdue ? "tag-span" : ""}" title="${ds}${has ? " — " + deadlineMap[ds].map(t=>t.titleAr).join(", ") : ""}"></div>`;
  }
  $("#todoHeatmap").innerHTML = cells;

  const upcoming = active.filter(t => t.deadline && t.deadline >= fmtDate(today)).sort((a,b) => a.deadline.localeCompare(b.deadline)).slice(0,8);
  $("#upcomingList").innerHTML = upcoming.map(listHTML).join("") || `<p style="color:var(--text-faint); font-size:13px;">لا توجد مواعيد قادمة.</p>`;
}

/* ---------- NAV ---------- */
$$(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    $$(".view").forEach(v => v.classList.remove("active"));
    $(`#view-${view}`).classList.add("active");
    if (view === "dashboard") renderDashboard();
    if (view === "todos") renderTodos();
    if (view === "timeline") renderTimeline();
    if (view === "weekly") renderWeeklySelect();
    if (view === "monthly") renderMonthlySelect();
    if (view === "final") renderFinalReport();
  });
});

/* ---------- THEME + LANG TOGGLES ---------- */
$("#themeToggle").addEventListener("click", () => {
  const body = document.body;
  const next = body.dataset.theme === "terminal" ? "university" : "terminal";
  body.dataset.theme = next;
  localStorage.setItem("coop-theme", next);
});
(function initTheme() {
  const saved = localStorage.getItem("coop-theme");
  if (saved) document.body.dataset.theme = saved;
})();

$("#langToggle").addEventListener("click", () => {
  reportLangPrimary = reportLangPrimary === "ar" ? "en" : "ar";
  renderTimeline();
  renderWeeklySelect();
  renderMonthlySelect();
});

/* ---------- RENDER: shared ---------- */
function renderAll() {
  renderTodayHeader();
  renderPhaseStrip();
  renderRecentTasks();
  renderDashboard();
}

function renderTodayHeader() {
  const today = new Date();
  $("#todayLabel").textContent = `${DAY_NAMES_AR[today.getDay()]}، ${fmtDate(today)}`;
  const phase = computePhase(fmtDate(today));
  $("#currentPhasePill").textContent = PHASE_LABELS[phase];
}

function renderPhaseStrip() {
  if (!settingsCache?.startDate) { $("#phaseStrip").innerHTML = ""; return; }
  const start = parseDate(settingsCache.startDate);
  const grcMonths = Number(settingsCache.grcMonths || 2);
  const phaseMonths = Number(settingsCache.phaseMonths || 2);
  const grcEnd = addMonths(start, grcMonths);
  const blueEnd = addMonths(grcEnd, phaseMonths);
  const redEnd = addMonths(blueEnd, phaseMonths);
  const total = redEnd - start;
  const segs = [
    { key: "grc", label: "GRC", from: start, to: grcEnd },
    { key: "blue", label: "Blue Team", from: grcEnd, to: blueEnd },
    { key: "red", label: "Red Team", from: blueEnd, to: redEnd },
  ];
  const today = new Date();
  $("#phaseStrip").innerHTML = segs.map(s => {
    const width = ((s.to - s.from) / total * 100).toFixed(2);
    const isToday = today >= s.from && today < s.to;
    let marker = "";
    if (isToday) {
      const pos = ((today - s.from) / (s.to - s.from) * 100).toFixed(2);
      marker = `style="--marker-pos:${100-pos}%"`;
    }
    return `<div class="phase-seg ${s.key} ${isToday ? "today" : ""}" style="flex:${width}" ${marker}>${s.label}</div>`;
  }).join("");
}

function renderRecentTasks() {
  const recent = tasksCache.slice(0, 8);
  $("#recentList").innerHTML = recent.length ? recent.map(taskItemHTML).join("") :
    `<p style="color:var(--text-faint); font-size:13px;">لا توجد مهام مسجّلة بعد.</p>`;
}

function taskItemHTML(t) {
  return `
  <div class="task-item ${t.phase}">
    <div class="task-item-top">
      <span class="task-item-title">${escapeHTML(t.titleAr)}</span>
      <span class="task-item-meta">${taskSpanLabel(t)}</span>
    </div>
    ${t.descAr ? `<div class="task-item-desc">${escapeHTML(t.descAr)}</div>` : ""}
    <div class="task-item-tags">
      <span class="tag">${PHASE_LABELS[t.phase]}</span>
      ${t.hours ? `<span class="tag">${t.hours} ساعة</span>` : ""}
      ${t.tools ? `<span class="tag">${escapeHTML(t.tools)}</span>` : ""}
      ${t.endDate && t.endDate !== t.date ? `<span class="tag tag-span">مهمة ممتدة</span>` : ""}
    </div>
  </div>`;
}
function escapeHTML(s) {
  return (s||"").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}

/* ---------- DASHBOARD ---------- */
function renderDashboard() {
  if (!$("#view-dashboard")) return;
  const phase = computePhase(fmtDate(new Date()));
  $("#dashPhasePill").textContent = PHASE_LABELS[phase];

  const totalHours = tasksCache.reduce((s,t) => s + (t.hours||0), 0);
  let daysLeft = "—";
  if (settingsCache?.startDate) {
    const start = parseDate(settingsCache.startDate);
    const grcMonths = Number(settingsCache.grcMonths || 2);
    const phaseMonths = Number(settingsCache.phaseMonths || 2);
    const end = addMonths(addMonths(start, grcMonths), phaseMonths*2);
    const diff = Math.ceil((end - new Date()) / 86400000);
    daysLeft = diff > 0 ? diff : 0;
  }
  const allDates = new Set(tasksCache.flatMap(taskDates));

  $("#dashStats").innerHTML = `
    <div class="stat-box"><div class="num">${tasksCache.length}</div><div class="lbl">إجمالي المهام</div></div>
    <div class="stat-box"><div class="num">${totalHours}</div><div class="lbl">إجمالي الساعات</div></div>
    <div class="stat-box"><div class="num">${allDates.size}</div><div class="lbl">أيام تم فيها تسجيل</div></div>
    <div class="stat-box"><div class="num">${daysLeft}</div><div class="lbl">يوم متبقٍ في البرنامج</div></div>
  `;

  /* week chart — last 8 ISO weeks */
  const today = new Date();
  const weekBuckets = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i*7);
    weekBuckets.push(weekKey(fmtDate(d)));
  }
  const uniqueWeeks = [...new Set(weekBuckets)];
  const counts = uniqueWeeks.map(wk => tasksCache.filter(t => taskWeekKeys(t).includes(wk)).length);
  const max = Math.max(1, ...counts);
  $("#weekChart").innerHTML = `<div class="bar-chart">${uniqueWeeks.map((wk,i) => `
    <div class="bar-col">
      <div class="bar" style="height:${(counts[i]/max*100).toFixed(0)}%" title="${counts[i]} مهمة"></div>
      <span class="bar-label">${wk.split("-W")[1]}</span>
    </div>`).join("")}</div>`;

  /* phase distribution */
  const byPhase = { grc: 0, blue: 0, red: 0, general: 0 };
  tasksCache.forEach(t => byPhase[t.phase] = (byPhase[t.phase]||0)+1);
  const totalP = Math.max(1, tasksCache.length);
  const phaseOrder = [["grc","GRC"],["blue","Blue Team"],["red","Red Team"],["general","عام"]];
  $("#phaseBar").innerHTML = `<div class="stacked-bar">${phaseOrder.map(([k,l]) =>
    byPhase[k] ? `<div class="stacked-seg ${k}" style="width:${(byPhase[k]/totalP*100).toFixed(1)}%"></div>` : ""
  ).join("")}</div>`;
  $("#phaseLegend").innerHTML = phaseOrder.map(([k,l]) =>
    `<span class="legend-item"><span class="legend-dot ${k}"></span>${l} — ${byPhase[k]||0}</span>`
  ).join("");

  /* heatmap — current month */
  const y = today.getFullYear(), m = today.getMonth();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  let cells = "";
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = fmtDate(new Date(y, m, day));
    const active = allDates.has(ds);
    const isFuture = new Date(y,m,day) > today;
    cells += `<div class="heat-cell ${active ? "active" : ""} ${isFuture ? "future" : ""}" title="${ds}"></div>`;
  }
  $("#heatmap").innerHTML = cells;

  let streak = 0;
  let cur = new Date(today);
  if (!allDates.has(fmtDate(cur))) cur.setDate(cur.getDate()-1);
  while (allDates.has(fmtDate(cur))) { streak++; cur.setDate(cur.getDate()-1); }
  $("#streakBadge").textContent = streak > 0 ? `🔥 ${streak} يوم متتالي` : "ابدأ اليوم!";

  $("#dashRecentList").innerHTML = tasksCache.slice(0,5).map(taskItemHTML).join("") ||
    `<p style="color:var(--text-faint); font-size:13px;">لا توجد مهام مسجّلة بعد.</p>`;
}

/* ---------- TIMELINE + STATS ---------- */
function renderTimeline() {
  if (!settingsCache?.startDate) { $("#timelineViz").innerHTML = "أدخل تاريخ بداية التدريب في الإعدادات أولاً."; return; }
  renderPhaseStrip();
  $("#timelineViz").innerHTML = `<div style="margin-top:4px;">تقدّم البرنامج على مدى ٦ أشهر — الشريط أعلى الصفحة يعكس موقعك الحالي.</div>`;

  const byPhase = { grc: 0, blue: 0, red: 0, general: 0 };
  const hoursByPhase = { grc: 0, blue: 0, red: 0, general: 0 };
  tasksCache.forEach(t => { byPhase[t.phase] = (byPhase[t.phase]||0)+1; hoursByPhase[t.phase] = (hoursByPhase[t.phase]||0) + (t.hours||0); });
  const totalHours = tasksCache.reduce((s,t) => s + (t.hours||0), 0);

  $("#statsGrid").innerHTML = `
    <div class="stat-box"><div class="num">${tasksCache.length}</div><div class="lbl">إجمالي المهام</div></div>
    <div class="stat-box"><div class="num">${totalHours}</div><div class="lbl">إجمالي الساعات</div></div>
    <div class="stat-box"><div class="num">${byPhase.grc||0}</div><div class="lbl">مهام GRC</div></div>
    <div class="stat-box"><div class="num">${byPhase.blue||0}</div><div class="lbl">مهام Blue Team</div></div>
    <div class="stat-box"><div class="num">${byPhase.red||0}</div><div class="lbl">مهام Red Team</div></div>
  `;
}

/* ---------- WEEKLY REPORT ---------- */
function renderWeeklySelect() {
  const weeks = [...new Set(tasksCache.flatMap(taskWeekKeys))].sort().reverse();
  $("#weekSelect").innerHTML = weeks.map(w => `<option value="${w}">${w}</option>`).join("") ||
    `<option value="">لا توجد بيانات</option>`;
  $("#weekSelect").onchange = () => renderWeeklyReport($("#weekSelect").value);
  if (weeks.length) renderWeeklyReport(weeks[0]);
  else $("#weeklyReport").innerHTML = emptyState();
}
function renderWeeklyReport(wk) {
  const items = tasksCache.filter(t => taskWeekKeys(t).includes(wk)).sort((a,b)=>a.date.localeCompare(b.date));
  $("#weeklyReport").innerHTML = buildReportDoc({
    titleAr: `التقرير الأسبوعي — ${wk}`, titleEn: `Weekly Report — ${wk}`,
    items, periodLabel: wk
  });
}

/* ---------- MONTHLY REPORT ---------- */
function renderMonthlySelect() {
  const months = [...new Set(tasksCache.flatMap(taskMonthKeys))].sort().reverse();
  $("#monthSelect").innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("") ||
    `<option value="">لا توجد بيانات</option>`;
  $("#monthSelect").onchange = () => renderMonthlyReport($("#monthSelect").value);
  if (months.length) renderMonthlyReport(months[0]);
  else $("#monthlyReport").innerHTML = emptyState();
}
function renderMonthlyReport(mk) {
  const items = tasksCache.filter(t => taskMonthKeys(t).includes(mk)).sort((a,b)=>a.date.localeCompare(b.date));
  $("#monthlyReport").innerHTML = buildReportDoc({
    titleAr: `التقرير الشهري — ${mk}`, titleEn: `Monthly Report — ${mk}`,
    items, periodLabel: mk
  });
}

/* ---------- FINAL REPORT ---------- */
function renderFinalReport() {
  if (!tasksCache.length) { $("#finalReport").innerHTML = emptyState(); return; }
  const items = [...tasksCache].sort((a,b)=>a.date.localeCompare(b.date));
  const phases = ["grc","blue","red","general"];
  let phaseSections = phases.map(p => {
    const pItems = items.filter(t => t.phase === p);
    if (!pItems.length) return "";
    const hours = pItems.reduce((s,t)=>s+(t.hours||0),0);
    return `
      <h2>${PHASE_LABELS[p]} — ${PHASE_LABELS_AR[p]}</h2>
      <p style="color:var(--text-dim); font-size:12.5px; margin-bottom:8px;">${pItems.length} مهمة · ${hours} ساعة</p>
      ${tasksTable(pItems)}
    `;
  }).join("");

  const totalHours = items.reduce((s,t)=>s+(t.hours||0),0);
  const dateRange = `${items[0].date} → ${items[items.length-1].date}`;

  $("#finalReport").innerHTML = `
    ${docHeader("التقرير الختامي للتدريب التعاوني", "Final Cooperative Training Report")}
    <div class="doc-meta">
      فترة التدريب: ${dateRange} · إجمالي المهام: ${items.length} · إجمالي الساعات: ${totalHours}
    </div>
    <h2>الملخص التنفيذي / Executive Summary</h2>
    <p>على مدار فترة التدريب التعاوني، تم إنجاز <strong>${items.length}</strong> مهمة بإجمالي <strong>${totalHours}</strong> ساعة عمل موزعة على ثلاث مراحل رئيسية: الحوكمة والمخاطر والامتثال (GRC)، والفريق الأزرق (Blue Team)، والفريق الأحمر (Red Team).</p>
    <p class="lang-block"><span class="en">Over the course of the cooperative training program, ${items.length} tasks were completed totaling ${totalHours} hours of work across three main phases: Governance, Risk & Compliance (GRC), Blue Team, and Red Team.</span></p>
    ${phaseSections}
    <h2>جميع المهام بالترتيب الزمني / All Tasks Chronologically</h2>
    ${tasksTable(items)}
  `;
}

function emptyState() {
  return `<p style="color:var(--text-faint); font-size:13px;">لا توجد بيانات بعد لهذه الفترة — سجّل مهامك من صفحة "تسجيل مهمة".</p>`;
}

function docHeader(titleAr, titleEn) {
  const today = fmtDate(new Date());
  return `
  <img src="assets/uqu-letterhead.png" alt="جامعة أم القرى" class="letterhead-banner">
  <div class="letterhead-title">
    <h1>${titleAr}</h1>
    <p class="title-en">${titleEn}</p>
  </div>
  <table class="letterhead-info">
    <tr>
      <td><strong>الاسم / Name</strong><br>${escapeHTML(settingsCache?.name || "—")}</td>
      <td><strong>الرقم الجامعي / University No.</strong><br>${escapeHTML(settingsCache?.studentId || "—")}</td>
    </tr>
    <tr>
      <td><strong>رقم الهاتف / Phone</strong><br>${escapeHTML(settingsCache?.phone || "—")}</td>
      <td><strong>البريد الإلكتروني / Email</strong><br>${escapeHTML(settingsCache?.email || "—")}</td>
    </tr>
    <tr>
      <td><strong>القسم / Department</strong><br>${escapeHTML(settingsCache?.dept || "—")}</td>
      <td><strong>الكلية / College</strong><br>${escapeHTML(settingsCache?.college || "—")}</td>
    </tr>
    <tr>
      <td><strong>التخصص / Specialization</strong><br>${escapeHTML(settingsCache?.specialization || "—")}</td>
      <td><strong>تاريخ الإصدار / Issue Date</strong><br>${today}</td>
    </tr>
  </table>`;
}

function tasksTable(items) {
  return `
  <table>
    <thead><tr><th>التاريخ</th><th>المرحلة</th><th>المهمة</th><th>الوصف</th><th>الأدوات</th><th>الساعات</th></tr></thead>
    <tbody>
      ${items.map(t => `
        <tr>
          <td>${taskSpanLabel(t)}</td>
          <td>${PHASE_LABELS[t.phase]}</td>
          <td>
            <div class="lang-block">
              ${escapeHTML(t.titleAr)}
              ${t.titleEn ? `<span class="en">${escapeHTML(t.titleEn)}</span>` : ""}
            </div>
          </td>
          <td>
            <div class="lang-block">
              ${escapeHTML(t.descAr||"—")}
              ${t.descEn ? `<span class="en">${escapeHTML(t.descEn)}</span>` : ""}
            </div>
          </td>
          <td>${escapeHTML(t.tools||"—")}</td>
          <td>${t.hours||0}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

function buildReportDoc({ titleAr, titleEn, items, periodLabel }) {
  if (!items.length) return emptyState();
  const totalHours = items.reduce((s,t)=>s+(t.hours||0),0);
  const byPhase = {};
  items.forEach(t => byPhase[t.phase] = (byPhase[t.phase]||0)+1);
  const phaseSummary = Object.entries(byPhase).map(([p,c]) => `${PHASE_LABELS[p]}: ${c}`).join(" · ");

  return `
    ${docHeader(titleAr, titleEn)}
    <div class="doc-meta">
      ${items.length} مهمة · ${totalHours} ساعة · ${phaseSummary}
    </div>
    <h2>ملخص الفترة / Period Summary</h2>
    <p>خلال هذه الفترة تم إنجاز ${items.length} مهمة موزعة على: ${phaseSummary}.</p>
    <p class="lang-block"><span class="en">During this period, ${items.length} tasks were completed across: ${phaseSummary}.</span></p>
    <h2>تفاصيل المهام / Task Details</h2>
    ${tasksTable(items)}
  `;
}

/* ---------- BACKUP EXPORT ---------- */
$("#exportBtn").addEventListener("click", () => {
  const payload = { settings: settingsCache, tasks: tasksCache, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `coop-training-backup-${fmtDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
