import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, doc, setDoc, addDoc, getDocs, getDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ---------- constants ---------- */
const PHASE_LABELS = { grc: "GRC", blue: "Blue Team", red: "Red Team", general: "عام / General" };
const PHASE_LABELS_AR = { grc: "الحوكمة والمخاطر والامتثال", blue: "الفريق الأزرق", red: "الفريق الأحمر", general: "عام" };
const DAY_NAMES_AR = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];

let currentUser = null;
let tasksCache = [];
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
    name: "", studentId: "", org: "", supervisor: "",
    startDate: fmtDate(new Date()), grcMonths: 2, phaseMonths: 2
  };
  $("#setName").value = settingsCache.name || "";
  $("#setId").value = settingsCache.studentId || "";
  $("#setOrg").value = settingsCache.org || "";
  $("#setSupervisor").value = settingsCache.supervisor || "";
  $("#setStart").value = settingsCache.startDate || fmtDate(new Date());
  $("#setGrcMonths").value = settingsCache.grcMonths || 2;
  $("#setPhaseMonths").value = settingsCache.phaseMonths || 2;
}

$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  settingsCache = {
    name: $("#setName").value.trim(),
    studentId: $("#setId").value.trim(),
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
  const entry = {
    date: $("#taskDate").value,
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

/* ---------- NAV ---------- */
$$(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    $$(".view").forEach(v => v.classList.remove("active"));
    $(`#view-${view}`).classList.add("active");
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
      <span class="task-item-meta">${t.date}</span>
    </div>
    ${t.descAr ? `<div class="task-item-desc">${escapeHTML(t.descAr)}</div>` : ""}
    <div class="task-item-tags">
      <span class="tag">${PHASE_LABELS[t.phase]}</span>
      ${t.hours ? `<span class="tag">${t.hours} ساعة</span>` : ""}
      ${t.tools ? `<span class="tag">${escapeHTML(t.tools)}</span>` : ""}
    </div>
  </div>`;
}
function escapeHTML(s) {
  return (s||"").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
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
  const weeks = [...new Set(tasksCache.map(t => weekKey(t.date)))].sort().reverse();
  $("#weekSelect").innerHTML = weeks.map(w => `<option value="${w}">${w}</option>`).join("") ||
    `<option value="">لا توجد بيانات</option>`;
  $("#weekSelect").onchange = () => renderWeeklyReport($("#weekSelect").value);
  if (weeks.length) renderWeeklyReport(weeks[0]);
  else $("#weeklyReport").innerHTML = emptyState();
}
function renderWeeklyReport(wk) {
  const items = tasksCache.filter(t => weekKey(t.date) === wk).sort((a,b)=>a.date.localeCompare(b.date));
  $("#weeklyReport").innerHTML = buildReportDoc({
    titleAr: `التقرير الأسبوعي — ${wk}`, titleEn: `Weekly Report — ${wk}`,
    items, periodLabel: wk
  });
}

/* ---------- MONTHLY REPORT ---------- */
function renderMonthlySelect() {
  const months = [...new Set(tasksCache.map(t => monthKey(t.date)))].sort().reverse();
  $("#monthSelect").innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("") ||
    `<option value="">لا توجد بيانات</option>`;
  $("#monthSelect").onchange = () => renderMonthlyReport($("#monthSelect").value);
  if (months.length) renderMonthlyReport(months[0]);
  else $("#monthlyReport").innerHTML = emptyState();
}
function renderMonthlyReport(mk) {
  const items = tasksCache.filter(t => monthKey(t.date) === mk).sort((a,b)=>a.date.localeCompare(b.date));
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
      ${settingsCache?.name ? `المتدرب: ${escapeHTML(settingsCache.name)} · ` : ""}
      ${settingsCache?.studentId ? `الرقم الجامعي: ${escapeHTML(settingsCache.studentId)} · ` : ""}
      ${settingsCache?.org ? `الجهة: ${escapeHTML(settingsCache.org)} · ` : ""}
      ${settingsCache?.supervisor ? `المشرف: ${escapeHTML(settingsCache.supervisor)} · ` : ""}
      الفترة: ${dateRange}
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
  return `<h1>${titleAr}</h1><p style="color:var(--text-dim); font-size:13px; margin-bottom:14px;">${titleEn}</p>`;
}

function tasksTable(items) {
  return `
  <table>
    <thead><tr><th>التاريخ</th><th>المرحلة</th><th>المهمة</th><th>الوصف</th><th>الأدوات</th><th>الساعات</th></tr></thead>
    <tbody>
      ${items.map(t => `
        <tr>
          <td>${t.date}</td>
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
      ${settingsCache?.name ? `المتدرب: ${escapeHTML(settingsCache.name)} · ` : ""}
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
