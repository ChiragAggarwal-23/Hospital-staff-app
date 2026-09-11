// ============================================================================
// Hospital Staff Manager — app.js
// Plain JavaScript, no build step. Talks directly to Supabase (Postgres +
// Auth + Row Level Security) using the client library loaded via CDN in
// index.html. All the real business rules (who can do what, the leave
// balance math, locking, etc.) live in the database itself — this file is
// just the screen on top of it.
// ============================================================================

const SUPABASE_URL = "https://kzpeulkialjltuhsuqxr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6cGV1bGtpYWxqbHR1aHN1cXhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMTM1NjUsImV4cCI6MjEwNDU4OTU2NX0.ZP466sff5WuX5nWwIDEY9n-NRgR10PnQ87lxFYm-1cY";

const app = document.getElementById("app");

if (typeof supabase === "undefined") {
  app.innerHTML = `<div class="login-wrap"><div class="login-box">
    <h1>Couldn't load a required file</h1>
    <p class="sub">This page needs an internet connection to load its database library.
    Check your connection and reload the page. If this keeps happening, tell whoever set this up.</p>
  </div></div>`;
  throw new Error("Supabase client library failed to load from CDN.");
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let profile = null; // the logged-in user's row from `profiles`
let activeTab = null;

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function todayStr() { return fmtDate(new Date()); }

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateNice(dstr) {
  const [y, m, d] = dstr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return [start, end, lastDay];
}

function money(n) {
  if (n === null || n === undefined) return "—";
  return "₹" + Number(n).toLocaleString("en-IN");
}

const ATTENDANCE_LABELS = {
  present: { label: "Present", cls: "badge-present" },
  half_day_no_notice: { label: "Half-day (No notice)", cls: "badge-half" },
  absent_no_notice: { label: "Absent (No notice)", cls: "badge-absent" },
  approved_paid_leave: { label: "Paid Leave", cls: "badge-paid" },
  approved_unpaid_leave: { label: "Unpaid Leave", cls: "badge-unpaid" },
  half_day_approved_paid: { label: "Half-day Paid Leave", cls: "badge-paid" },
  half_day_approved_unpaid: { label: "Half-day Unpaid Leave", cls: "badge-unpaid" },
};

function leaveDayBadge(portion, type) {
  if (portion === "half" && type === "paid") return ATTENDANCE_LABELS.half_day_approved_paid;
  if (portion === "half" && type === "unpaid") return ATTENDANCE_LABELS.half_day_approved_unpaid;
  if (type === "paid") return ATTENDANCE_LABELS.approved_paid_leave;
  return ATTENDANCE_LABELS.approved_unpaid_leave;
}

// ----------------------------------------------------------------------------
// Generic modal (used for: marker/owner logging a leave, owner's balance
// adjustment, staff's leave request form)
// ----------------------------------------------------------------------------
function openModal(title, bodyHtml) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal-box">
        <h3>${escapeHtml(title)}</h3>
        <form id="modal-form">${bodyHtml}</form>
        <div class="error-text" id="modal-error" style="display:none"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" id="modal-cancel">Cancel</button>
          <button type="submit" form="modal-form" class="btn btn-primary" id="modal-submit">Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    function close(result) {
      wrap.remove();
      resolve(result);
    }

    $("#modal-cancel", wrap).onclick = () => close(null);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(null); });
    $("#modal-form", wrap).addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      close(data);
    });
  });
}

function modalError(msg) {
  const el = $("#modal-error");
  if (el) { el.textContent = msg; el.style.display = "block"; }
}

// inject minimal modal CSS once
(function injectModalCss() {
  const css = `
  .modal-backdrop { position:fixed; inset:0; background:rgba(20,25,23,0.45); display:flex;
    align-items:center; justify-content:center; z-index:100; padding:16px; }
  .modal-box { background:#fff; border-radius:12px; padding:20px; width:100%; max-width:380px;
    max-height:90vh; overflow:auto; }
  .modal-box h3 { margin:0 0 12px; font-size:16px; }
  .modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

// ----------------------------------------------------------------------------
// Boot / auth
// ----------------------------------------------------------------------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await loadProfileAndRender();
  } else {
    renderLogin();
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") renderLogin();
  });
}

function renderLogin() {
  profile = null;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h1>Hospital Staff Manager</h1>
        <p class="sub">Sign in with the login you were given.</p>
        <form id="login-form">
          <label>Email or login ID</label>
          <input type="text" name="email" required autocomplete="username" />
          <label>Password</label>
          <input type="password" name="password" required autocomplete="current-password" />
          <button class="btn btn-primary" style="width:100%; margin-top:16px;" type="submit">Sign in</button>
        </form>
        <div class="error-text" id="login-error" style="display:none"></div>
      </div>
    </div>`;

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = fd.get("email").trim();
    const password = fd.get("password");
    const btn = $("#login-form button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    btn.textContent = "Sign in";
    if (error) {
      $("#login-error").style.display = "block";
      $("#login-error").textContent = error.message;
      return;
    }
    await loadProfileAndRender();
  });
}

async function loadProfileAndRender() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { renderLogin(); return; }
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error || !data) {
    app.innerHTML = `<div class="login-wrap"><div class="login-box">
      <h1>Couldn't load your profile</h1>
      <p class="sub">${escapeHtml(error?.message || "No profile found for this login.")}</p>
      <button class="btn btn-outline" id="signout-btn">Sign out and try again</button>
    </div></div>`;
    $("#signout-btn").onclick = async () => { await sb.auth.signOut(); };
    return;
  }
  profile = data;
  activeTab = defaultTabForRole(profile.role);
  renderShell();
}

function defaultTabForRole(role) {
  if (role === "marker") return "mark";
  if (role === "staff") return "my-attendance";
  return "approvals"; // owner
}

async function logout() {
  await sb.auth.signOut();
}

// ----------------------------------------------------------------------------
// Shell: topbar + tabs + tab content
// ----------------------------------------------------------------------------
function tabsForRole(role) {
  if (role === "marker") return [["mark", "Mark Attendance"]];
  if (role === "staff") return [["my-attendance", "My Attendance"], ["leave", "Leave Requests"]];
  return [
    ["approvals", "Approvals"],
    ["attendance", "Attendance"],
    ["staff", "Staff Directory"],
    ["adjustments", "Paid Leave Adjustments"],
  ];
}

function renderShell() {
  const tabs = tabsForRole(profile.role);
  app.innerHTML = `
    <div class="topbar">
      <div>
        <h1>Hospital Staff Manager</h1>
        <div class="who">${escapeHtml(profile.full_name)} · ${escapeHtml(roleLabel(profile.role))}</div>
      </div>
      <button id="logout-btn">Sign out</button>
    </div>
    <div class="tabs">
      ${tabs.map(([key, label]) =>
        `<button data-tab="${key}" class="${key === activeTab ? "active" : ""}">${escapeHtml(label)}</button>`
      ).join("")}
    </div>
    <main id="tab-content"></main>
  `;
  $("#logout-btn").onclick = logout;
  $all(".tabs button").forEach((btn) => {
    btn.onclick = () => { activeTab = btn.dataset.tab; renderShell(); };
  });
  renderTabContent();
}

function roleLabel(r) {
  return r === "owner" ? "Owner" : r === "marker" ? "Attendance Marker" : "Staff";
}

function renderTabContent() {
  const el = $("#tab-content");
  el.innerHTML = `<div class="card">Loading…</div>`;
  if (activeTab === "mark") return renderMarkerTab(el);
  if (activeTab === "my-attendance") return renderMyAttendanceTab(el);
  if (activeTab === "leave") return renderMyLeaveTab(el);
  if (activeTab === "approvals") return renderApprovalsTab(el);
  if (activeTab === "attendance") return renderOwnerAttendanceTab(el);
  if (activeTab === "staff") return renderStaffSalaryTab(el);
  if (activeTab === "adjustments") return renderAdjustmentsTab(el);
}

// ============================================================================
// MARKER + OWNER shared: daily attendance marking view
// ============================================================================
async function renderDailyAttendance(el, { isOwner }) {
  let dateStr = el.dataset.date || todayStr();

  el.innerHTML = `
    <div class="card">
      <h2>${isOwner ? "Attendance (owner override)" : "Mark Attendance"}</h2>
      <label>Date</label>
      <input type="date" id="mark-date" value="${dateStr}" max="${isOwner ? "" : todayStr()}" />
      <div id="staff-list" style="margin-top:14px;">Loading…</div>
    </div>
  `;

  $("#mark-date").addEventListener("change", (e) => {
    el.dataset.date = e.target.value;
    renderDailyAttendance(el, { isOwner });
  });

  const [{ data: staffList, error: staffErr }, { data: attendance }, { data: leaveDays }] = await Promise.all([
    sb.from("profiles").select("id, full_name, employee_code").eq("role", "staff").eq("is_active", true).order("full_name"),
    sb.from("attendance").select("staff_id, status").eq("date", dateStr),
    sb.from("leave_request_days").select("staff_id, day_portion, type").eq("date", dateStr).eq("day_status", "active"),
  ]);

  const listEl = $("#staff-list", el);
  if (staffErr) { listEl.innerHTML = `<div class="error-text">${escapeHtml(staffErr.message)}</div>`; return; }

  const attByStaff = Object.fromEntries((attendance || []).map((a) => [a.staff_id, a.status]));
  const leaveByStaff = Object.fromEntries((leaveDays || []).map((l) => [l.staff_id, l]));

  listEl.innerHTML = (staffList || []).map((s) => {
    const locked = leaveByStaff[s.id];
    const currentStatus = attByStaff[s.id];
    let badgeHtml = `<span class="badge badge-none">Not marked</span>`;
    if (locked) {
      const b = leaveDayBadge(locked.day_portion, locked.type);
      badgeHtml = `<span class="badge ${b.cls}">${b.label}</span>`;
    } else if (currentStatus) {
      const b = ATTENDANCE_LABELS[currentStatus];
      badgeHtml = `<span class="badge ${b.cls}">${b.label}</span>`;
    }

    const canEdit = !locked || isOwner;
    let actions = "";
    if (canEdit) {
      actions = `
        <div class="action-group" data-staff="${s.id}" data-name="${escapeHtml(s.full_name)}">
          <button class="btn btn-outline btn-small act-present">Present</button>
          <button class="btn btn-outline btn-small act-half-notice">Half-day (No notice)</button>
          <button class="btn btn-outline btn-small act-absent">Absent (No notice)</button>
          <button class="btn btn-outline btn-small act-paid">Log Paid Leave</button>
          <button class="btn btn-outline btn-small act-unpaid">Log Unpaid Leave</button>
          <button class="btn btn-outline btn-small act-overtime">Log Overtime</button>
        </div>`;
    }

    return `
      <div class="staff-row">
        <div>
          <div class="staff-name">${escapeHtml(s.full_name)}</div>
          <div class="staff-meta">${escapeHtml(s.employee_code || "")}</div>
        </div>
        <div style="text-align:right;">
          ${badgeHtml}
          ${actions}
        </div>
      </div>`;
  }).join("") || `<div class="hint-text">No active staff found yet.</div>`;

  $all(".action-group", listEl).forEach((grp) => {
    const staffId = grp.dataset.staff;
    const staffName = grp.dataset.name;
    $(".act-present", grp).onclick = () => markSimpleAttendance(staffId, "present", dateStr, el, isOwner);
    $(".act-half-notice", grp).onclick = () => markSimpleAttendance(staffId, "half_day_no_notice", dateStr, el, isOwner);
    $(".act-absent", grp).onclick = () => markSimpleAttendance(staffId, "absent_no_notice", dateStr, el, isOwner);
    $(".act-paid", grp).onclick = () => logLeaveQuick(staffId, staffName, dateStr, "paid", isOwner, el);
    $(".act-unpaid", grp).onclick = () => logLeaveQuick(staffId, staffName, dateStr, "unpaid", isOwner, el);
    $(".act-overtime", grp).onclick = () => logOvertimeQuick(staffId, staffName, dateStr, el, isOwner);
  });
}

async function markSimpleAttendance(staffId, status, dateStr, el, isOwner) {
  const { error } = await sb.from("attendance").upsert(
    { staff_id: staffId, date: dateStr, status, marked_by: profile.id },
    { onConflict: "staff_id,date" }
  );
  if (error) { alert("Couldn't save: " + error.message); return; }
  renderDailyAttendance(el, { isOwner });
}

async function logLeaveQuick(staffId, staffName, dateStr, type, isOwner, el) {
  const result = await openModal(`Log ${type === "paid" ? "Paid" : "Unpaid"} Leave — ${staffName}`, `
    <label>Portion</label>
    <select name="portion">
      <option value="full">Full day</option>
      <option value="half">Half day</option>
    </select>
    <label>Reason</label>
    <textarea name="reason" required placeholder="e.g. informed verbally, on-the-spot approval"></textarea>
  `);
  if (!result) return;

  const { error } = await sb.from("leave_requests").insert({
    staff_id: staffId,
    from_date: dateStr,
    to_date: dateStr,
    day_portion: result.portion,
    requested_type: type,
    reason: result.reason,
    status: "approved",
    source: isOwner ? "owner_logged" : "marker_logged",
    reviewed_by: profile.id,
    reviewed_at: new Date().toISOString(),
  });
  if (error) { alert("Couldn't save: " + error.message); return; }
  renderDailyAttendance(el, { isOwner });
}

async function logOvertimeQuick(staffId, staffName, dateStr, el, isOwner) {
  const result = await openModal(`Log Overtime — ${staffName}`, `
    <p class="hint-text">Logs a half-day overtime credit for ${escapeHtml(dateStr)}.</p>
    <label>Note (optional)</label>
    <textarea name="reason" placeholder="optional note"></textarea>
  `);
  if (!result) return;
  const { error } = await sb.from("overtime_credits").upsert(
    { staff_id: staffId, date: dateStr, reason: result.reason || null, recorded_by: profile.id },
    { onConflict: "staff_id,date" }
  );
  if (error) { alert("Couldn't save: " + error.message); return; }
  alert("Overtime logged.");
}

function renderMarkerTab(el) { el.dataset.date = el.dataset.date || todayStr(); renderDailyAttendance(el, { isOwner: false }); }

function renderOwnerAttendanceTab(el) {
  const view = el.dataset.view || "daily";
  el.innerHTML = `
    <div class="subtabs">
      <button data-view="daily" class="${view === "daily" ? "active" : ""}">Daily</button>
      <button data-view="monthly" class="${view === "monthly" ? "active" : ""}">Monthly overview</button>
    </div>
    <div id="attendance-view-body"></div>
  `;
  $all(".subtabs button", el).forEach((btn) => {
    btn.onclick = () => { el.dataset.view = btn.dataset.view; renderOwnerAttendanceTab(el); };
  });
  const body = $("#attendance-view-body", el);
  body.dataset.date = el.dataset.date || todayStr();
  if (view === "daily") {
    renderDailyAttendance(body, { isOwner: true });
  } else {
    body.dataset.year = el.dataset.year || String(new Date().getFullYear());
    body.dataset.month = el.dataset.month || String(new Date().getMonth() + 1);
    renderMonthlyOverview(body, el);
  }
}

async function renderMonthlyOverview(body, parentEl) {
  const year = parseInt(body.dataset.year, 10);
  const month = parseInt(body.dataset.month, 10);
  const [start, end, lastDay] = monthRange(year, month);

  body.innerHTML = `
    <div class="card">
      <h2>Monthly overview</h2>
      <div class="row">
        <div><label>Year</label><input type="number" id="mo-year" value="${year}" /></div>
        <div><label>Month (1-12)</label><input type="number" id="mo-month" min="1" max="12" value="${month}" /></div>
      </div>
      <div id="mo-grid" style="overflow-x:auto; margin-top:14px;">Loading…</div>
    </div>
  `;

  $("#mo-year").addEventListener("change", (e) => { parentEl.dataset.year = e.target.value; renderOwnerAttendanceTab(parentEl); });
  $("#mo-month").addEventListener("change", (e) => { parentEl.dataset.month = e.target.value; renderOwnerAttendanceTab(parentEl); });

  const [{ data: staffList, error: staffErr }, { data: att }] = await Promise.all([
    sb.from("profiles").select("id, full_name").eq("role", "staff").eq("is_active", true).order("full_name"),
    sb.from("attendance").select("staff_id, date, status").gte("date", start).lte("date", end),
  ]);

  const gridEl = $("#mo-grid", body);
  if (staffErr) { gridEl.innerHTML = `<div class="error-text">${escapeHtml(staffErr.message)}</div>`; return; }
  if (!staffList || staffList.length === 0) { gridEl.innerHTML = `<div class="hint-text">No active staff yet.</div>`; return; }

  const byStaffDate = {};
  (att || []).forEach((a) => { byStaffDate[a.staff_id + "|" + a.date] = a.status; });

  const shortLabel = { present: "P", half_day_no_notice: "H", absent_no_notice: "A",
    approved_paid_leave: "PL", approved_unpaid_leave: "UL",
    half_day_approved_paid: "HPL", half_day_approved_unpaid: "HUL" };

  let html = `<table style="border-collapse:collapse; font-size:11px; min-width:700px;"><thead><tr>
    <th style="text-align:left; padding:4px 8px; position:sticky; left:0; background:#fff;">Staff</th>
    ${Array.from({ length: lastDay }, (_, i) => `<th style="padding:4px 3px;">${i + 1}</th>`).join("")}
    </tr></thead><tbody>`;

  staffList.forEach((s) => {
    html += `<tr><td style="padding:4px 8px; white-space:nowrap; position:sticky; left:0; background:#fff; border-right:1px solid var(--border);">${escapeHtml(s.full_name)}</td>`;
    for (let d = 1; d <= lastDay; d++) {
      const dStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const status = byStaffDate[s.id + "|" + dStr];
      const info = status ? ATTENDANCE_LABELS[status] : null;
      const bg = info ? cssVarFromClass(info.cls) : "#f4f6f5";
      const title = info ? info.label : "Not marked";
      html += `<td title="${escapeHtml(title)}" style="background:${bg}; text-align:center; padding:5px 2px; border-radius:4px;">${status ? shortLabel[status] : ""}</td>`;
    }
    html += `</tr>`;
  });
  html += `</tbody></table>
    <div class="hint-text" style="margin-top:8px;">P=Present · H=Half-day (no notice) · A=Absent (no notice) · PL=Paid Leave · UL=Unpaid Leave · HPL/HUL=Half-day leave</div>`;
  gridEl.innerHTML = html;
}

// ============================================================================
// STAFF: My Attendance tab (calendar + balance + salary)
// ============================================================================
async function renderMyAttendanceTab(el) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const [start, end] = monthRange(year, month);

  const [{ data: att }, { data: salary }, { data: balance, error: balErr }] = await Promise.all([
    sb.from("attendance").select("date, status").eq("staff_id", profile.id).gte("date", start).lte("date", end),
    sb.from("staff_salary").select("monthly_salary").eq("staff_id", profile.id).maybeSingle(),
    sb.rpc("staff_paid_leave_balance", { p_staff_id: profile.id, p_year: year, p_month: month }),
  ]);

  const attByDate = Object.fromEntries((att || []).map((a) => [a.date, a.status]));
  const [, , lastDay] = monthRange(year, month);
  const firstWeekday = new Date(year, month - 1, 1).getDay();

  let cells = "";
  for (let i = 0; i < firstWeekday; i++) cells += `<div></div>`;
  for (let d = 1; d <= lastDay; d++) {
    const dStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const status = attByDate[dStr];
    const info = status ? ATTENDANCE_LABELS[status] : null;
    const bg = info ? cssVarFromClass(info.cls) : "#f4f6f5";
    cells += `<div class="cal-cell" style="background:${bg}">
      <div class="cal-daynum">${d}</div>
      <div class="cal-label">${info ? info.label : ""}</div>
    </div>`;
  }

  el.innerHTML = `
    <div class="card">
      <h2>My monthly salary</h2>
      <div class="summary-tiles">
        <div class="tile"><div class="num">${salary?.monthly_salary != null ? money(salary.monthly_salary) : "—"}</div><div class="lbl">Monthly salary</div></div>
        <div class="tile"><div class="num">${balErr ? "—" : Number(balance).toFixed(1)}</div><div class="lbl">Paid leave balance (this month)</div></div>
      </div>
      ${balErr ? `<div class="error-text">${escapeHtml(balErr.message)}</div>` : ""}
    </div>
    <div class="card">
      <h2>${now.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
      <div class="calendar-grid">${cells}</div>
    </div>
  `;
}

function cssVarFromClass(cls) {
  const map = {
    "badge-present": "#e3f4ec", "badge-absent": "#fdeceb", "badge-half": "#fdf1e0",
    "badge-paid": "#e6eefb", "badge-unpaid": "#f0ecf8", "badge-none": "#f4f6f5",
  };
  return map[cls] || "#f4f6f5";
}

// ============================================================================
// STAFF: Leave Requests tab (apply + manage own)
// ============================================================================
async function renderMyLeaveTab(el) {
  el.innerHTML = `
    <div class="card">
      <h2>Apply for leave</h2>
      <button class="btn btn-primary" id="new-leave-btn">New leave request</button>
    </div>
    <div class="card">
      <h2>My leave requests</h2>
      <div id="my-requests">Loading…</div>
    </div>
  `;
  $("#new-leave-btn").onclick = openLeaveRequestForm;
  await loadMyRequests();
}

async function openLeaveRequestForm() {
  const result = await openModal("New Leave Request", `
    <label>Type</label>
    <select name="portion_choice">
      <option value="full">Full day(s)</option>
      <option value="half">Half day (single date)</option>
    </select>
    <div class="row">
      <div>
        <label>From date</label>
        <input type="date" name="from_date" required min="${todayStr()}" />
      </div>
      <div id="to-date-wrap">
        <label>To date</label>
        <input type="date" name="to_date" min="${todayStr()}" />
      </div>
    </div>
    <label>Paid or unpaid</label>
    <select name="requested_type">
      <option value="paid">Paid</option>
      <option value="unpaid">Unpaid</option>
    </select>
    <label>Reason</label>
    <textarea name="reason" required></textarea>
  `);
  if (!result) return;

  const isHalf = result.portion_choice === "half";
  const fromDate = result.from_date;
  const toDate = isHalf ? fromDate : (result.to_date || fromDate);

  const { error } = await sb.from("leave_requests").insert({
    staff_id: profile.id,
    from_date: fromDate,
    to_date: toDate,
    day_portion: isHalf ? "half" : "full",
    requested_type: result.requested_type,
    reason: result.reason,
    status: "pending",
    source: "staff_request",
  });
  if (error) { alert("Couldn't submit: " + error.message); return; }
  await loadMyRequests();
}

async function loadMyRequests() {
  const container = $("#my-requests");
  const { data, error } = await sb
    .from("leave_requests")
    .select("*, leave_request_days(*)")
    .eq("staff_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = `<div class="hint-text">No leave requests yet.</div>`; return; }

  container.innerHTML = data.map((r) => {
    const statusCls = { pending: "badge-pending", approved: "badge-approved", rejected: "badge-rejected", cancelled: "badge-cancelled" }[r.status];
    const days = (r.leave_request_days || []).sort((a, b) => a.date.localeCompare(b.date));
    return `
      <div class="request-item">
        <div class="request-head">
          <div><strong>${fmtDateNice(r.from_date)}${r.to_date !== r.from_date ? " – " + fmtDateNice(r.to_date) : ""}</strong></div>
          <span class="badge ${statusCls}">${r.status}</span>
        </div>
        <div class="hint-text">${escapeHtml(r.reason)}</div>
        ${days.map((d) => {
          const badge = d.day_status === "cancelled"
            ? `<span class="badge badge-cancelled">Cancelled</span>`
            : (() => { const b = leaveDayBadge(d.day_portion, d.type); return `<span class="badge ${b.cls}">${b.label}</span>`; })();
          const future = d.date > todayStr();
          const canAct = r.status === "approved" && d.day_status === "active" && future;
          return `
            <div class="day-line" data-day-id="${d.id}" data-portion="${d.day_portion}">
              <span>${fmtDateNice(d.date)}</span>
              <span style="display:flex; gap:6px; align-items:center;">
                ${badge}
                ${canAct ? `<button class="btn btn-outline btn-small act-cancel-day">Cancel</button>` : ""}
                ${canAct && d.day_portion === "full" ? `<button class="btn btn-outline btn-small act-shorten-day">Shorten to half-day</button>` : ""}
              </span>
            </div>`;
        }).join("")}
        ${r.status === "pending" ? `<div style="margin-top:8px;"><button class="btn btn-outline btn-small act-withdraw" data-req-id="${r.id}">Withdraw request</button></div>` : ""}
      </div>`;
  }).join("");

  $all(".act-cancel-day", container).forEach((btn) => {
    btn.onclick = async () => {
      const line = btn.closest(".day-line");
      const { error } = await sb.from("leave_request_days").update({ day_status: "cancelled" }).eq("id", line.dataset.dayId);
      if (error) { alert("Couldn't cancel: " + error.message); return; }
      await loadMyRequests();
    };
  });
  $all(".act-shorten-day", container).forEach((btn) => {
    btn.onclick = async () => {
      const line = btn.closest(".day-line");
      const { error } = await sb.from("leave_request_days").update({ day_portion: "half" }).eq("id", line.dataset.dayId);
      if (error) { alert("Couldn't update: " + error.message); return; }
      await loadMyRequests();
    };
  });
  $all(".act-withdraw", container).forEach((btn) => {
    btn.onclick = async () => {
      const { error } = await sb.from("leave_requests").update({ status: "cancelled" }).eq("id", btn.dataset.reqId);
      if (error) { alert("Couldn't withdraw: " + error.message); return; }
      await loadMyRequests();
    };
  });
}

// ============================================================================
// OWNER: Approvals tab
// ============================================================================
async function renderApprovalsTab(el) {
  el.innerHTML = `<div class="card"><h2>Pending leave requests</h2><div id="approvals-list">Loading…</div></div>`;
  const container = $("#approvals-list");

  const { data, error } = await sb
    .from("leave_requests")
    .select("*, profiles!staff_id(full_name), leave_request_days(*)")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = `<div class="hint-text">Nothing waiting on you right now.</div>`; return; }

  container.innerHTML = data.map((r) => {
    const days = (r.leave_request_days || []).sort((a, b) => a.date.localeCompare(b.date));
    return `
      <div class="request-item">
        <div class="request-head">
          <div><strong>${escapeHtml(r.profiles?.full_name || "Unknown")}</strong> —
            ${fmtDateNice(r.from_date)}${r.to_date !== r.from_date ? " – " + fmtDateNice(r.to_date) : ""}</div>
        </div>
        <div class="hint-text">${escapeHtml(r.reason)}</div>
        ${days.map((d) => { const b = leaveDayBadge(d.day_portion, d.type); return `
          <div class="day-line"><span>${fmtDateNice(d.date)}</span><span class="badge ${b.cls}">${b.label}</span></div>`; }).join("")}
        <div style="margin-top:10px;">
          <button class="btn btn-primary btn-small act-approve" data-id="${r.id}">Approve</button>
          <button class="btn btn-danger btn-small act-reject" data-id="${r.id}">Reject</button>
        </div>
      </div>`;
  }).join("");

  $all(".act-approve", container).forEach((btn) => {
    btn.onclick = async () => {
      const { error } = await sb.from("leave_requests").update({
        status: "approved", reviewed_by: profile.id, reviewed_at: new Date().toISOString(),
      }).eq("id", btn.dataset.id);
      if (error) { alert("Couldn't approve: " + error.message); return; }
      renderApprovalsTab(el);
    };
  });
  $all(".act-reject", container).forEach((btn) => {
    btn.onclick = async () => {
      const { error } = await sb.from("leave_requests").update({
        status: "rejected", reviewed_by: profile.id, reviewed_at: new Date().toISOString(),
      }).eq("id", btn.dataset.id);
      if (error) { alert("Couldn't reject: " + error.message); return; }
      renderApprovalsTab(el);
    };
  });
}

// ============================================================================
// OWNER: Staff & Salary tab
// ============================================================================
async function renderStaffSalaryTab(el) {
  el.innerHTML = `<div class="card"><h2>Staff Directory</h2><div id="staff-salary-list">Loading…</div></div>`;
  const container = $("#staff-salary-list");

  const { data, error } = await sb
    .from("profiles")
    .select("id, full_name, employee_code, department, designation, is_active, staff_salary!staff_id(monthly_salary)")
    .order("full_name");

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }

  container.innerHTML = (data || []).map((s) => `
    <div class="staff-row">
      <div>
        <div class="staff-name">${escapeHtml(s.full_name)} <span class="hint-text">(${escapeHtml(s.role || "")})</span></div>
        <div class="staff-meta">${escapeHtml(s.employee_code || "")} ${s.department ? "· " + escapeHtml(s.department) : ""} ${s.is_active ? "" : "· inactive"}</div>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <input type="number" step="0.01" class="salary-input" data-staff="${s.id}" style="width:120px;"
          value="${s.staff_salary?.monthly_salary ?? ""}" placeholder="Monthly salary" />
        <button class="btn btn-primary btn-small act-save-salary" data-staff="${s.id}">Save</button>
      </div>
    </div>`).join("");

  $all(".act-save-salary", container).forEach((btn) => {
    btn.onclick = async () => {
      const staffId = btn.dataset.staff;
      const input = $(`.salary-input[data-staff="${staffId}"]`, container);
      const val = parseFloat(input.value);
      if (isNaN(val)) { alert("Enter a salary amount first."); return; }
      const { error } = await sb.from("staff_salary").upsert(
        { staff_id: staffId, monthly_salary: val, updated_by: profile.id },
        { onConflict: "staff_id" }
      );
      if (error) { alert("Couldn't save: " + error.message); return; }
      btn.textContent = "Saved";
      setTimeout(() => { btn.textContent = "Save"; }, 1200);
    };
  });
}

// ============================================================================
// OWNER: Balance Adjustments tab
// ============================================================================
async function renderAdjustmentsTab(el) {
  const { data: staffList } = await sb.from("profiles").select("id, full_name").eq("role", "staff").order("full_name");

  el.innerHTML = `
    <div class="card">
      <h2>Add a paid leave adjustment</h2>
      <label>Staff member</label>
      <select id="adj-staff">${(staffList || []).map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("")}</select>
      <div class="row">
        <div><label>Year</label><input type="number" id="adj-year" value="${new Date().getFullYear()}" /></div>
        <div><label>Month (1-12)</label><input type="number" id="adj-month" min="1" max="12" value="${new Date().getMonth() + 1}" /></div>
      </div>
      <label>Adjustment amount (+ or -, e.g. 0.5 or -1)</label>
      <input type="number" step="0.5" id="adj-amount" />
      <label>Reason</label>
      <textarea id="adj-reason"></textarea>
      <button class="btn btn-primary" id="adj-submit" style="margin-top:10px;">Save adjustment</button>
    </div>
    <div class="card">
      <h2>Recent adjustments</h2>
      <div id="adj-list">Loading…</div>
    </div>
  `;

  $("#adj-submit").onclick = async () => {
    const staff_id = $("#adj-staff").value;
    const year = parseInt($("#adj-year").value, 10);
    const month = parseInt($("#adj-month").value, 10);
    const adjustment_amount = parseFloat($("#adj-amount").value);
    const reason = $("#adj-reason").value;
    if (!staff_id || isNaN(adjustment_amount)) { alert("Fill in staff and amount."); return; }
    const { error } = await sb.from("leave_balance_adjustments").insert({
      staff_id, year, month, adjustment_amount, reason, created_by: profile.id,
    });
    if (error) { alert("Couldn't save: " + error.message); return; }
    $("#adj-amount").value = ""; $("#adj-reason").value = "";
    loadAdjustmentsList();
  };

  loadAdjustmentsList();
}

async function loadAdjustmentsList() {
  const container = $("#adj-list");
  const { data, error } = await sb
    .from("leave_balance_adjustments")
    .select("*, profiles!staff_id(full_name)")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = `<div class="hint-text">No adjustments logged yet.</div>`; return; }
  container.innerHTML = data.map((a) => `
    <div class="day-line">
      <span>${escapeHtml(a.profiles?.full_name || "")} — ${a.month}/${a.year}</span>
      <span>${a.adjustment_amount > 0 ? "+" : ""}${a.adjustment_amount} <span class="hint-text">${escapeHtml(a.reason || "")}</span></span>
    </div>`).join("");
}

// ----------------------------------------------------------------------------
boot();
