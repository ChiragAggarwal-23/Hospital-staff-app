// ============================================================================
// Ananda Asian Staff Manager — app.js
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
function openModal(title, bodyHtml, submitLabel = "Save") {
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
          <button type="submit" form="modal-form" class="btn btn-primary" id="modal-submit">${escapeHtml(submitLabel)}</button>
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

// A styled Yes/No confirmation, built on the same modal used everywhere
// else. Resolves true if the person confirmed, false if they backed out.
function confirmAction(message, submitLabel = "Yes, continue") {
  return openModal("Please confirm", `<p style="margin:0;">${escapeHtml(message)}</p>`, submitLabel)
    .then((r) => r !== null);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function monthSelectHtml(id, selectedMonth) {
  return `<select id="${id}">${MONTH_NAMES.map((name, i) =>
    `<option value="${i + 1}" ${i + 1 === selectedMonth ? "selected" : ""}>${name}</option>`
  ).join("")}</select>`;
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
  // Registered before the initial getSession() so a password-recovery link
  // (the browser landing here with #type=recovery in the URL) is caught
  // even if Supabase fires the event before the rest of boot() resolves.
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") renderLogin();
    if (event === "PASSWORD_RECOVERY") renderSetNewPassword();
  });

  if (window.location.hash.includes("type=recovery")) {
    renderSetNewPassword();
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await loadProfileAndRender();
  } else {
    renderLogin();
  }
}

function renderLogin() {
  profile = null;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h1>Ananda Asian Staff Manager</h1>
        <p class="sub">Sign in with the login you were given.</p>
        <form id="login-form">
          <label>Email or login ID</label>
          <input type="text" name="email" required autocomplete="username" />
          <label>Password</label>
          <input type="password" name="password" required autocomplete="current-password" />
          <button class="btn btn-primary" style="width:100%; margin-top:16px;" type="submit">Sign in</button>
        </form>
        <div class="error-text" id="login-error" style="display:none"></div>
        <a href="#" id="signup-link" class="forgot-link">New here? Create an account</a>
        <a href="#" id="forgot-link" class="forgot-link">Forgot password?</a>
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

  $("#forgot-link").addEventListener("click", async (e) => {
    e.preventDefault();
    await handleForgotPassword();
  });

  $("#signup-link").addEventListener("click", async (e) => {
    e.preventDefault();
    await handleSignUp();
  });
}

// Self-signup. Collects only what the person themself should be trusted to
// provide -- name, email, password. Nothing role/access-related is asked
// here; the account lands as "pending" (see handle_new_user() in the
// database) until the owner reviews it and fills in the rest from the
// Staff Directory tab.
async function handleSignUp() {
  const data = await openModal(
    "Create an account",
    `
    <label>Full name</label>
    <input type="text" name="full_name" required autocomplete="name" />
    <label>Email</label>
    <input type="email" name="email" required autocomplete="username" />
    <label>Password</label>
    <input type="password" name="password" required minlength="6" autocomplete="new-password" />
    <label>Confirm password</label>
    <input type="password" name="confirm" required minlength="6" autocomplete="new-password" />
    <p class="hint-text" style="margin-top:8px;">After you sign up, the owner will need to approve your account before you can sign in.</p>
    `,
    "Sign up"
  );
  if (!data) return;

  const full_name = (data.full_name || "").trim();
  const email = (data.email || "").trim();
  if (!full_name || !email) { alert("Fill in your name and email."); return; }
  if (data.password !== data.confirm) { alert("Passwords don't match."); return; }
  if (data.password.length < 6) { alert("Password must be at least 6 characters."); return; }

  const { data: signUpData, error } = await sb.auth.signUp({
    email,
    password: data.password,
    options: { data: { full_name } },
  });
  if (error) { alert("Couldn't sign up: " + error.message); return; }

  if (signUpData.session) {
    await loadProfileAndRender();
  } else {
    alert("Account created! Check your email to confirm it, then sign in. After confirming, the owner still needs to approve your account before you can use the app.");
  }
}

// Sends a password-reset email. Uses whatever URL the app is currently
// running at as the return address, so it works the same on any hosting
// (GitHub Pages, a custom domain, etc.) without needing to hardcode one --
// as long as that URL is also listed under Authentication > URL
// Configuration > Redirect URLs in the Supabase dashboard.
async function handleForgotPassword() {
  const data = await openModal(
    "Reset your password",
    `<label>Email</label>
     <input type="email" name="email" required autocomplete="username" />
     <p class="hint-text" style="margin-top:8px;">We'll email a link to set a new password. This only works if your account was set up with an email address.</p>`,
    "Send reset link"
  );
  if (!data) return;
  const email = (data.email || "").trim();
  if (!email) return;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) {
    alert("Couldn't send reset link: " + error.message);
    return;
  }
  alert("If that email has an account, a reset link has been sent. Check the inbox (and spam folder).");
}

// Shown when the page is opened from a password-reset email link. The
// Supabase client has already turned that link's token into a temporary
// "recovery" session behind the scenes -- this screen just collects the
// new password and applies it to that session.
function renderSetNewPassword() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h1>Set a new password</h1>
        <p class="sub">Choose a new password for your account.</p>
        <form id="reset-form">
          <label>New password</label>
          <input type="password" name="password" required minlength="6" autocomplete="new-password" />
          <label>Confirm new password</label>
          <input type="password" name="confirm" required minlength="6" autocomplete="new-password" />
          <button class="btn btn-primary" style="width:100%; margin-top:16px;" type="submit">Set password</button>
        </form>
        <div class="error-text" id="reset-error" style="display:none"></div>
      </div>
    </div>`;

  $("#reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const password = fd.get("password");
    const confirm = fd.get("confirm");
    const errEl = $("#reset-error");
    if (password !== confirm) {
      errEl.style.display = "block";
      errEl.textContent = "Passwords don't match.";
      return;
    }
    const btn = $("#reset-form button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Saving…";
    const { error } = await sb.auth.updateUser({ password });
    btn.disabled = false;
    btn.textContent = "Set password";
    if (error) {
      errEl.style.display = "block";
      errEl.textContent = error.message;
      return;
    }
    // Drop the recovery token from the URL so a reload doesn't re-trigger this screen.
    history.replaceState(null, "", window.location.pathname);
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
  if (!profile.role) { renderPendingScreen(); return; }
  activeTab = defaultTabForRole(profile.role);
  renderShell();
}

// Shown for a self-signed-up account the owner hasn't approved yet (no
// role assigned). No tabs, nothing to do here but wait or sign out.
function renderPendingScreen() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h1>Account pending approval</h1>
        <p class="sub">Hi ${escapeHtml(profile.full_name)} — your account has been created but isn't active yet.
        The owner needs to review it and assign your role before you can sign in. Check back later, or reach out to the owner directly.</p>
        <button class="btn btn-outline" id="pending-signout-btn" style="width:100%;">Sign out</button>
      </div>
    </div>`;
  $("#pending-signout-btn").onclick = logout;
}

function defaultTabForRole(role) {
  if (role === "marker") return "mark";
  if (role === "staff") return "my-attendance";
  return "approvals"; // owner
}

async function logout() {
  await sb.auth.signOut();
}

// Account settings, reachable by any role from the topbar. Currently just
// a change-password form; re-verifies the current password first so an
// unattended, already-signed-in session can't be hijacked into a takeover.
async function openAccountModal() {
  const data = await openModal(
    "Account settings",
    `
    <p class="hint-text" style="margin:0 0 10px;">Signed in as ${escapeHtml(profile.full_name)} (${escapeHtml(roleLabel(profile.role))})</p>
    <h3 style="margin-top:0;">Change password</h3>
    <label>Current password</label>
    <input type="password" name="current" required autocomplete="current-password" />
    <label>New password</label>
    <input type="password" name="new_password" required minlength="6" autocomplete="new-password" />
    <label>Confirm new password</label>
    <input type="password" name="confirm" required minlength="6" autocomplete="new-password" />
    `,
    "Change password"
  );
  if (!data) return;

  if (data.new_password !== data.confirm) {
    alert("New passwords don't match.");
    return;
  }
  if (data.new_password.length < 6) {
    alert("New password must be at least 6 characters.");
    return;
  }

  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) {
    alert("This account has no email on file, so password changes aren't available here yet. Ask the owner to update it.");
    return;
  }

  const { error: verifyError } = await sb.auth.signInWithPassword({ email: user.email, password: data.current });
  if (verifyError) {
    alert("Current password is incorrect.");
    return;
  }

  const { error } = await sb.auth.updateUser({ password: data.new_password });
  if (error) { alert("Couldn't change password: " + error.message); return; }
  alert("Password changed.");
}

// ----------------------------------------------------------------------------
// Shell: topbar + tabs + tab content
// ----------------------------------------------------------------------------
function tabsForRole(role) {
  if (role === "marker") return [["mark", "Mark Attendance"], ["monthly", "Monthly Overview"]];
  if (role === "staff") return [["my-attendance", "My Attendance"], ["leave", "Leave Requests"]];
  return [
    ["approvals", "Approvals"],
    ["attendance", "Attendance"],
    ["staff", "Staff Directory"],
    ["payroll", "Payroll"],
    ["adjustments", "Paid Leave Adjustments"],
  ];
}

function renderShell() {
  const tabs = tabsForRole(profile.role);
  app.innerHTML = `
    <div class="topbar">
      <div>
        <h1>Ananda Asian Staff Manager</h1>
        <div class="who">${escapeHtml(profile.full_name)} · ${escapeHtml(roleLabel(profile.role))}</div>
      </div>
      <div class="topbar-actions">
        <button id="account-btn">Account</button>
        <button id="logout-btn">Sign out</button>
      </div>
    </div>
    <div class="tabs">
      ${tabs.map(([key, label]) =>
        `<button data-tab="${key}" class="${key === activeTab ? "active" : ""}">${escapeHtml(label)}</button>`
      ).join("")}
    </div>
    <main id="tab-content"></main>
  `;
  $("#logout-btn").onclick = logout;
  $("#account-btn").onclick = openAccountModal;
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
  if (activeTab === "monthly") return renderMarkerMonthlyTab(el);
  if (activeTab === "my-attendance") return renderMyAttendanceTab(el);
  if (activeTab === "leave") return renderMyLeaveTab(el);
  if (activeTab === "approvals") return renderApprovalsTab(el);
  if (activeTab === "attendance") return renderOwnerAttendanceTab(el);
  if (activeTab === "staff") return renderStaffSalaryTab(el);
  if (activeTab === "payroll") return renderPayrollTab(el);
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

  const [{ data: staffList, error: staffErr }, { data: attendance }, { data: leaveDays }, { data: overtimeRows }] = await Promise.all([
    sb.from("profiles").select("id, full_name, employee_code").eq("role", "staff").eq("is_active", true).order("full_name"),
    sb.from("attendance").select("staff_id, status").eq("date", dateStr),
    sb.from("leave_request_days").select("staff_id, day_portion, type").eq("date", dateStr).eq("day_status", "active"),
    sb.from("overtime_credits").select("staff_id, day_portion").eq("date", dateStr),
  ]);

  const listEl = $("#staff-list", el);
  if (staffErr) { listEl.innerHTML = `<div class="error-text">${escapeHtml(staffErr.message)}</div>`; return; }

  const attByStaff = Object.fromEntries((attendance || []).map((a) => [a.staff_id, a.status]));
  const leaveByStaff = Object.fromEntries((leaveDays || []).map((l) => [l.staff_id, l]));
  const overtimeByStaff = Object.fromEntries((overtimeRows || []).map((o) => [o.staff_id, o]));
  const isFutureOrToday = dateStr >= todayStr();

  listEl.innerHTML = (staffList || []).map((s) => {
    const locked = leaveByStaff[s.id];
    const currentStatus = attByStaff[s.id];
    const overtime = overtimeByStaff[s.id];
    let badgeHtml = `<span class="badge badge-none">Not marked</span>`;
    if (locked) {
      const b = leaveDayBadge(locked.day_portion, locked.type);
      badgeHtml = `<span class="badge ${b.cls}">${b.label}</span>`;
    } else if (currentStatus) {
      const b = ATTENDANCE_LABELS[currentStatus];
      badgeHtml = `<span class="badge ${b.cls}">${b.label}</span>`;
    }
    if (overtime) {
      badgeHtml += ` <span class="badge badge-overtime">Overtime${overtime.day_portion === "full" ? " (Full)" : ""}</span>`;
    }

    const canEdit = !locked || isOwner;
    const showOvertimeBtn = !locked && currentStatus === "present" && !overtime;
    const showUnmarkBtn = isOwner && locked && isFutureOrToday;
    let actions = "";
    if (canEdit) {
      actions = `
        <div class="action-group" data-staff="${s.id}" data-name="${escapeHtml(s.full_name)}" data-locked="${locked ? "1" : ""}">
          ${locked ? `<div class="hint-text" style="margin-bottom:4px;">Any action below will cancel the approved leave on this date and restore the balance.</div>` : ""}
          <button class="btn btn-outline btn-small act-present">Present</button>
          <button class="btn btn-outline btn-small act-half-notice">Half-day (No notice)</button>
          <button class="btn btn-outline btn-small act-absent">Absent (No notice)</button>
          <button class="btn btn-outline btn-small act-paid">Log Paid Leave</button>
          <button class="btn btn-outline btn-small act-unpaid">Log Unpaid Leave</button>
          ${showOvertimeBtn ? `<button class="btn btn-outline btn-small act-overtime">Log Overtime</button>` : ""}
          ${showUnmarkBtn ? `<button class="btn btn-outline btn-small act-unmark">Cancel leave (leave unmarked)</button>` : ""}
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
    const wasLocked = grp.dataset.locked === "1";
    const btn = (sel) => $(sel, grp);
    if (btn(".act-present")) btn(".act-present").onclick = () => confirmedMarkAttendance(staffId, staffName, "present", dateStr, el, isOwner, wasLocked);
    if (btn(".act-half-notice")) btn(".act-half-notice").onclick = () => confirmedMarkAttendance(staffId, staffName, "half_day_no_notice", dateStr, el, isOwner, wasLocked);
    if (btn(".act-absent")) btn(".act-absent").onclick = () => confirmedMarkAttendance(staffId, staffName, "absent_no_notice", dateStr, el, isOwner, wasLocked);
    if (btn(".act-paid")) btn(".act-paid").onclick = () => confirmedLogLeave(staffId, staffName, dateStr, "paid", isOwner, el, wasLocked);
    if (btn(".act-unpaid")) btn(".act-unpaid").onclick = () => confirmedLogLeave(staffId, staffName, dateStr, "unpaid", isOwner, el, wasLocked);
    if (btn(".act-overtime")) btn(".act-overtime").onclick = () => logOvertimeQuick(staffId, staffName, dateStr, el, isOwner);
    if (btn(".act-unmark")) btn(".act-unmark").onclick = () => confirmedCancelUnmark(staffId, staffName, dateStr, el, isOwner);
  });
}

// Wrap the override actions with a confirmation whenever they'd be
// cancelling an existing approved leave (misclick protection) -- routine
// marking on an already-open date proceeds straight through, unchanged.
async function confirmedMarkAttendance(staffId, staffName, status, dateStr, el, isOwner, wasLocked) {
  if (wasLocked) {
    const label = ATTENDANCE_LABELS[status].label;
    const ok = await confirmAction(`This will cancel ${staffName}'s approved leave on ${fmtDateNice(dateStr)} and mark them "${label}" instead. Continue?`);
    if (!ok) return;
  }
  await markSimpleAttendance(staffId, status, dateStr, el, isOwner, wasLocked);
}

async function confirmedLogLeave(staffId, staffName, dateStr, type, isOwner, el, wasLocked) {
  if (wasLocked) {
    const ok = await confirmAction(`This will cancel ${staffName}'s existing approved leave on ${fmtDateNice(dateStr)} and log a new ${type} leave instead. Continue?`);
    if (!ok) return;
  }
  await logLeaveQuick(staffId, staffName, dateStr, type, isOwner, el, wasLocked);
}

async function confirmedCancelUnmark(staffId, staffName, dateStr, el, isOwner) {
  const ok = await confirmAction(`This will cancel ${staffName}'s approved leave on ${fmtDateNice(dateStr)} and leave the day unmarked. Continue?`);
  if (!ok) return;
  const done = await cancelLockedLeaveDay(staffId, dateStr);
  if (!done) return;
  renderDailyAttendance(el, { isOwner });
}

// When the owner overrides a date that's currently locked by an approved
// leave day, cancel that leave day first: this restores the staff's paid
// leave balance (if it was paid) and unlocks the date, via the same
// trigger path used for ordinary leave cancellation. Marker never reaches
// here -- locked dates aren't editable by marker at all (see `canEdit`).
async function cancelLockedLeaveDay(staffId, dateStr) {
  const { error } = await sb
    .from("leave_request_days")
    .update({ day_status: "cancelled" })
    .eq("staff_id", staffId)
    .eq("date", dateStr)
    .eq("day_status", "active");
  if (error) {
    alert("Couldn't clear the existing approved leave for this date: " + error.message);
    return false;
  }
  return true;
}

async function markSimpleAttendance(staffId, status, dateStr, el, isOwner, wasLocked) {
  if (wasLocked) {
    const ok = await cancelLockedLeaveDay(staffId, dateStr);
    if (!ok) return;
  }
  const { error } = await sb.from("attendance").upsert(
    { staff_id: staffId, date: dateStr, status, marked_by: profile.id, locked_by_leave: false },
    { onConflict: "staff_id,date" }
  );
  if (error) { alert("Couldn't save: " + error.message); return; }
  renderDailyAttendance(el, { isOwner });
}

async function logLeaveQuick(staffId, staffName, dateStr, type, isOwner, el, wasLocked) {
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

  if (wasLocked) {
    const ok = await cancelLockedLeaveDay(staffId, dateStr);
    if (!ok) return;
  }

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
    <p class="hint-text">Logs a half-day overtime credit for ${escapeHtml(dateStr)} (on top of the full day already worked). Adds 0.5 to this month's paid-leave balance.</p>
    <label>Note (optional)</label>
    <textarea name="reason" placeholder="optional note"></textarea>
  `);
  if (!result) return;
  const { error } = await sb.from("overtime_credits").upsert(
    { staff_id: staffId, date: dateStr, day_portion: "half", reason: result.reason || null, recorded_by: profile.id },
    { onConflict: "staff_id,date" }
  );
  if (error) { alert("Couldn't save: " + error.message); return; }
  renderDailyAttendance(el, { isOwner });
}

function renderMarkerTab(el) { el.dataset.date = el.dataset.date || todayStr(); renderDailyAttendance(el, { isOwner: false }); }

function renderMarkerMonthlyTab(el) {
  el.dataset.year = el.dataset.year || String(new Date().getFullYear());
  el.dataset.month = el.dataset.month || String(new Date().getMonth() + 1);
  renderMonthlyOverview(el, el, { salaryAccess: "none" });
}

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
    renderMonthlyOverview(body, el, { salaryAccess: "owner" });
  }
}

async function renderMonthlyOverview(body, parentEl, opts = {}) {
  const salaryAccess = opts.salaryAccess || "owner";

  // Drilled into one staff member's own calendar -- render that instead of the grid.
  if (body.dataset.drillStaff) {
    return renderPersonalCalendar(body, {
      staffId: body.dataset.drillStaff,
      staffName: body.dataset.drillStaffName,
      salaryAccess,
      onBack: () => {
        delete body.dataset.drillStaff;
        delete body.dataset.drillStaffName;
        renderMonthlyOverview(body, parentEl, opts);
      },
    });
  }

  const year = parseInt(body.dataset.year, 10);
  const month = parseInt(body.dataset.month, 10);
  const [start, end, lastDay] = monthRange(year, month);

  body.innerHTML = `
    <div class="card">
      <h2>Monthly overview</h2>
      <div class="row">
        <div><label>Month</label>${monthSelectHtml("mo-month", month)}</div>
        <div><label>Year</label><input type="number" id="mo-year" value="${year}" /></div>
      </div>
      <div class="hint-text" style="margin-top:6px;">Click a staff member's name to see their personal calendar.</div>
      <div id="mo-grid" style="overflow-x:auto; margin-top:14px;">Loading…</div>
    </div>
  `;

  const rerender = () => { body.dataset.year = $("#mo-year", body).value; body.dataset.month = $("#mo-month", body).value; parentEl.dataset.year = body.dataset.year; parentEl.dataset.month = body.dataset.month; renderMonthlyOverview(body, parentEl, opts); };
  $("#mo-year", body).addEventListener("change", rerender);
  $("#mo-month", body).addEventListener("change", rerender);

  const [{ data: staffList, error: staffErr }, { data: att }, { data: otRows }] = await Promise.all([
    sb.from("profiles").select("id, full_name").eq("role", "staff").eq("is_active", true).order("full_name"),
    sb.from("attendance").select("staff_id, date, status").gte("date", start).lte("date", end),
    sb.from("overtime_credits").select("staff_id, date").gte("date", start).lte("date", end),
  ]);

  const gridEl = $("#mo-grid", body);
  if (staffErr) { gridEl.innerHTML = `<div class="error-text">${escapeHtml(staffErr.message)}</div>`; return; }
  if (!staffList || staffList.length === 0) { gridEl.innerHTML = `<div class="hint-text">No active staff yet.</div>`; return; }

  const byStaffDate = {};
  (att || []).forEach((a) => { byStaffDate[a.staff_id + "|" + a.date] = a.status; });
  const otSet = new Set((otRows || []).map((o) => o.staff_id + "|" + o.date));

  const shortLabel = { present: "P", half_day_no_notice: "H", absent_no_notice: "A",
    approved_paid_leave: "PL", approved_unpaid_leave: "UL",
    half_day_approved_paid: "HPL", half_day_approved_unpaid: "HUL" };

  let html = `<table style="border-collapse:collapse; font-size:11px; min-width:700px;"><thead><tr>
    <th style="text-align:left; padding:4px 8px; position:sticky; left:0; background:#fff;">Staff</th>
    ${Array.from({ length: lastDay }, (_, i) => `<th style="padding:4px 3px;">${i + 1}</th>`).join("")}
    </tr></thead><tbody>`;

  staffList.forEach((s) => {
    html += `<tr><td class="mo-staff-name" data-staff-id="${s.id}" data-staff-name="${escapeHtml(s.full_name)}"
      style="padding:4px 8px; white-space:nowrap; position:sticky; left:0; background:#fff; border-right:1px solid var(--border); cursor:pointer; color:var(--green-dark); text-decoration:underline;">${escapeHtml(s.full_name)}</td>`;
    for (let d = 1; d <= lastDay; d++) {
      const dStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const status = byStaffDate[s.id + "|" + dStr];
      const info = status ? ATTENDANCE_LABELS[status] : null;
      const bg = info ? cssVarFromClass(info.cls) : "#f4f6f5";
      const hasOt = otSet.has(s.id + "|" + dStr);
      const title = (info ? info.label : "Not marked") + (hasOt ? " + Overtime" : "");
      html += `<td title="${escapeHtml(title)}" style="background:${bg}; text-align:center; padding:5px 2px; border-radius:4px;">${status ? shortLabel[status] : ""}${hasOt ? `<sup style="color:#8a5a00;">OT</sup>` : ""}</td>`;
    }
    html += `</tr>`;
  });
  html += `</tbody></table>
    <div class="hint-text" style="margin-top:8px;">P=Present · H=Half-day (no notice) · A=Absent (no notice) · PL=Paid Leave · UL=Unpaid Leave · HPL/HUL=Half-day leave · OT=Overtime logged</div>`;
  gridEl.innerHTML = html;

  $all(".mo-staff-name", gridEl).forEach((td) => {
    td.onclick = () => {
      body.dataset.drillStaff = td.dataset.staffId;
      body.dataset.drillStaffName = td.dataset.staffName;
      renderMonthlyOverview(body, parentEl, opts);
    };
  });
}

// ============================================================================
// Shared: one staff member's personal calendar (used by the staff role for
// their own "My Attendance" tab, and by owner/marker drilling into someone
// else's month from the Monthly Overview grid).
//   salaryAccess: "self"  -- staff viewing their own (salary only once the
//                             viewed month has fully ended)
//                 "owner" -- owner viewing anyone (always, balance shown too)
//                 "none"  -- marker viewing someone else (no salary, no
//                             balance -- only attendance + effective days)
// ============================================================================
async function renderPersonalCalendar(el, { staffId, staffName, salaryAccess, onBack }) {
  const now = new Date();
  let year = parseInt(el.dataset.year || now.getFullYear(), 10);
  let month = parseInt(el.dataset.month || now.getMonth() + 1, 10);
  el.dataset.year = year;
  el.dataset.month = month;

  const [start, end, lastDay] = monthRange(year, month);
  const monthComplete = end < todayStr();
  const showSalary = salaryAccess === "owner" || (salaryAccess === "self" && monthComplete);
  const showBalance = salaryAccess !== "none";

  const [{ data: att }, { data: otRows }, { data: effRows, error: effErr }] = await Promise.all([
    sb.from("attendance").select("date, status").eq("staff_id", staffId).gte("date", start).lte("date", end),
    sb.from("overtime_credits").select("date, day_portion").eq("staff_id", staffId).gte("date", start).lte("date", end),
    sb.rpc("effective_working_days", { p_staff_id: staffId, p_year: year, p_month: month }),
  ]);

  let balance = null, balErr = null;
  if (showBalance) {
    const balRes = await sb.rpc("staff_paid_leave_balance", { p_staff_id: staffId, p_year: year, p_month: month });
    balance = balRes.data; balErr = balRes.error;
  }

  let salaryText = null;
  if (showSalary) {
    const salRes = await sb.rpc("calculate_salary", { p_staff_id: staffId, p_year: year, p_month: month });
    salaryText = salRes.error ? "—" : money(salRes.data);
  }

  const attByDate = Object.fromEntries((att || []).map((a) => [a.date, a.status]));
  const otByDate = Object.fromEntries((otRows || []).map((o) => [o.date, o]));
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const eff = (effRows && effRows[0]) || {};

  let cells = "";
  for (let i = 0; i < firstWeekday; i++) cells += `<div></div>`;
  for (let d = 1; d <= lastDay; d++) {
    const dStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const status = attByDate[dStr];
    const info = status ? ATTENDANCE_LABELS[status] : null;
    const bg = info ? cssVarFromClass(info.cls) : "#f4f6f5";
    const ot = otByDate[dStr];
    cells += `<div class="cal-cell" style="background:${bg}">
      <div class="cal-daynum">${d}</div>
      <div class="cal-label">${info ? info.label : ""}</div>
      ${ot ? `<div class="cal-label" style="color:#8a5a00;">OT${ot.day_portion === "full" ? " (Full)" : ""}</div>` : ""}
    </div>`;
  }

  const salaryTileHtml = salaryAccess === "none" ? "" : showSalary
    ? `<div class="tile"><div class="num">${salaryText}</div><div class="lbl">Calculated salary (${monthLabel})</div></div>`
    : `<div class="tile"><div class="num">—</div><div class="lbl">Salary (available after ${monthLabel} ends)</div></div>`;
  const balanceTileHtml = showBalance
    ? `<div class="tile"><div class="num">${balErr ? "—" : Number(balance).toFixed(2)}</div><div class="lbl">Paid leave balance</div></div>` : "";
  const effTileHtml = `<div class="tile"><div class="num">${effErr ? "—" : Number(eff.effective_days ?? 0).toFixed(2)}</div><div class="lbl">Effective working days</div></div>`;

  el.innerHTML = `
    ${onBack ? `<button class="btn btn-outline btn-small" id="cal-back" style="margin-bottom:10px;">&larr; Back to overview</button>` : ""}
    <div class="card">
      <h2>${staffName ? escapeHtml(staffName) + "'s attendance" : "My monthly salary"}</h2>
      <div class="summary-tiles">
        ${salaryTileHtml}
        ${balanceTileHtml}
        ${effTileHtml}
      </div>
      ${!effErr && eff.unmarked_days ? `<div class="hint-text">${eff.unmarked_days} day(s) not marked yet this month.</div>` : ""}
      ${balErr ? `<div class="error-text">${escapeHtml(balErr.message)}</div>` : ""}
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:10px;">
        <div><label>Month</label>${monthSelectHtml("cal-month", month)}</div>
        <div><label>Year</label><input type="number" id="cal-year" value="${year}" /></div>
      </div>
      <div class="staff-row" style="border-bottom:none; padding-top:0;">
        <button class="btn btn-outline btn-small" id="prev-month">&larr; Prev</button>
        <h2 style="margin:0;">${monthLabel}</h2>
        <button class="btn btn-outline btn-small" id="next-month">Next &rarr;</button>
      </div>
      <div class="calendar-grid">${cells}</div>
    </div>
  `;

  if (onBack) $("#cal-back", el).onclick = onBack;

  function goTo(y, m) {
    el.dataset.year = y; el.dataset.month = m;
    renderPersonalCalendar(el, { staffId, staffName, salaryAccess, onBack });
  }
  $("#prev-month", el).onclick = () => { let m = month - 1, y = year; if (m < 1) { m = 12; y -= 1; } goTo(y, m); };
  $("#next-month", el).onclick = () => { let m = month + 1, y = year; if (m > 12) { m = 1; y += 1; } goTo(y, m); };
  $("#cal-month", el).onchange = (e) => goTo(year, parseInt(e.target.value, 10));
  $("#cal-year", el).onchange = (e) => goTo(parseInt(e.target.value, 10), month);
}

// ============================================================================
// STAFF: My Attendance tab (calendar + balance + salary) -- thin wrapper
// around the shared personal-calendar renderer.
// ============================================================================
function renderMyAttendanceTab(el) {
  return renderPersonalCalendar(el, { staffId: profile.id, staffName: null, salaryAccess: "self", onBack: null });
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
            <div class="day-line" data-day-id="${d.id}" data-portion="${d.day_portion}" data-date="${d.date}">
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
      const ok = await confirmAction(`Cancel your approved leave for ${fmtDateNice(line.dataset.date)}?`);
      if (!ok) return;
      const { error } = await sb.from("leave_request_days").update({ day_status: "cancelled" }).eq("id", line.dataset.dayId);
      if (error) { alert("Couldn't cancel: " + error.message); return; }
      await loadMyRequests();
    };
  });
  $all(".act-shorten-day", container).forEach((btn) => {
    btn.onclick = async () => {
      const line = btn.closest(".day-line");
      const ok = await confirmAction(`Shorten your approved leave for ${fmtDateNice(line.dataset.date)} to a half-day?`);
      if (!ok) return;
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
// OWNER: Approvals tab -- Notifications subtab + Approvals subtab
// (pending + history, with the ability to alter already-approved leave)
// ============================================================================
function renderApprovalsTab(el) {
  const view = el.dataset.view || "notifications";
  el.innerHTML = `
    <div class="subtabs">
      <button data-view="notifications" class="${view === "notifications" ? "active" : ""}">Notifications</button>
      <button data-view="approvals" class="${view === "approvals" ? "active" : ""}">Approvals</button>
    </div>
    <div id="approvals-body"></div>
  `;
  $all(".subtabs button", el).forEach((btn) => {
    btn.onclick = () => { el.dataset.view = btn.dataset.view; renderApprovalsTab(el); };
  });
  const body = $("#approvals-body", el);
  if (view === "notifications") return renderNotificationsView(body);
  return renderApprovalsView(body);
}

const NOTIFICATION_LABELS = {
  leave_requested: "New leave request",
  leave_altered: "Approved leave altered",
  absent_no_notice: "Absent (no notice)",
  half_day_no_notice: "Half-day (no notice)",
  overtime_logged: "Overtime logged",
  balance_adjusted: "Balance adjusted",
};

async function renderNotificationsView(el) {
  el.innerHTML = `<div class="card"><h2>Notifications</h2><div id="notif-list">Loading…</div></div>`;
  const container = $("#notif-list");

  const { data, error } = await sb
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = `<div class="hint-text">Nothing to show yet.</div>`; return; }

  container.innerHTML = data.map((n) => `
    <div class="day-line" data-id="${n.id}" style="${n.is_read ? "opacity:0.55;" : ""}">
      <span>
        <strong>${escapeHtml(NOTIFICATION_LABELS[n.type] || n.type)}</strong> — ${escapeHtml(n.message)}
        <div class="hint-text">${new Date(n.created_at).toLocaleString()}</div>
      </span>
      ${!n.is_read ? `<button class="btn btn-outline btn-small act-mark-read">Mark read</button>` : ""}
    </div>`).join("");

  $all(".act-mark-read", container).forEach((btn) => {
    btn.onclick = async () => {
      const line = btn.closest(".day-line");
      const { error: e2 } = await sb.from("notifications").update({ is_read: true }).eq("id", line.dataset.id);
      if (e2) { alert("Couldn't update: " + e2.message); return; }
      renderNotificationsView(el);
    };
  });
}

async function renderApprovalsView(el) {
  el.innerHTML = `
    <div class="card"><h2>Pending leave requests</h2><div id="approvals-list">Loading…</div></div>
    <div class="card"><h2>Leave history</h2><div id="approvals-history">Loading…</div></div>
  `;
  await loadPendingApprovals($("#approvals-list", el), el);
  await loadApprovalsHistory($("#approvals-history", el), el);
}

async function loadPendingApprovals(container, parentEl) {
  const { data, error } = await sb
    .from("leave_requests")
    .select("*, profiles!staff_id(full_name), leave_request_days(*)")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = `<div class="hint-text">Nothing waiting on you right now.</div>`; return; }

  container.innerHTML = data.map((r) => {
    const days = (r.leave_request_days || []).filter((d) => d.day_status === "active").sort((a, b) => a.date.localeCompare(b.date));
    return `
      <div class="request-item" data-req-id="${r.id}">
        <div class="request-head">
          <div><strong>${escapeHtml(r.profiles?.full_name || "Unknown")}</strong> —
            ${fmtDateNice(r.from_date)}${r.to_date !== r.from_date ? " – " + fmtDateNice(r.to_date) : ""}</div>
        </div>
        <div class="hint-text">${escapeHtml(r.reason)}</div>
        ${days.length > 1 ? `<div class="hint-text">Untick any date you don't want to approve — the paid/unpaid split for the remaining dates is recalculated against the balance automatically.</div>` : ""}
        ${days.map((d) => { const b = leaveDayBadge(d.day_portion, d.type); return `
          <div class="day-line">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
              <input type="checkbox" class="day-check" data-day-id="${d.id}" checked />
              <span>${fmtDateNice(d.date)}</span>
            </label>
            <span class="badge ${b.cls}">${b.label}</span>
          </div>`; }).join("")}
        <div style="margin-top:10px;">
          <button class="btn btn-primary btn-small act-approve" data-id="${r.id}">Approve selected dates</button>
          <button class="btn btn-danger btn-small act-reject" data-id="${r.id}">Reject entire request</button>
        </div>
      </div>`;
  }).join("");

  $all(".act-approve", container).forEach((btn) => {
    btn.onclick = async () => {
      const reqId = btn.dataset.id;
      const item = btn.closest(".request-item");
      const checks = $all(".day-check", item);
      const uncheckedIds = checks.filter((c) => !c.checked).map((c) => c.dataset.dayId);
      const checkedCount = checks.length - uncheckedIds.length;
      if (checkedCount === 0) {
        alert('At least one date must stay checked to approve. Use "Reject entire request" if none of these dates should be approved.');
        return;
      }
      if (uncheckedIds.length > 0) {
        const { error: cancelErr } = await sb
          .from("leave_request_days")
          .update({ day_status: "cancelled" })
          .in("id", uncheckedIds)
          .eq("day_status", "active");
        if (cancelErr) { alert("Couldn't update the excluded dates: " + cancelErr.message); return; }
      }
      const { error } = await sb.from("leave_requests").update({
        status: "approved", reviewed_by: profile.id, reviewed_at: new Date().toISOString(),
      }).eq("id", reqId);
      if (error) { alert("Couldn't approve: " + error.message); return; }
      renderApprovalsView(parentEl);
    };
  });
  $all(".act-reject", container).forEach((btn) => {
    btn.onclick = async () => {
      const { error } = await sb.from("leave_requests").update({
        status: "rejected", reviewed_by: profile.id, reviewed_at: new Date().toISOString(),
      }).eq("id", btn.dataset.id);
      if (error) { alert("Couldn't reject: " + error.message); return; }
      renderApprovalsView(parentEl);
    };
  });
}

async function loadApprovalsHistory(container, parentEl) {
  const { data, error } = await sb
    .from("leave_requests")
    .select("*, profiles!staff_id(full_name), leave_request_days(*)")
    .in("status", ["approved", "rejected"])
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = `<div class="hint-text">No decided requests yet.</div>`; return; }

  const statusCls = { approved: "badge-approved", rejected: "badge-rejected" };

  container.innerHTML = data.map((r) => {
    const days = (r.leave_request_days || []).sort((a, b) => a.date.localeCompare(b.date));
    return `
      <div class="request-item">
        <div class="request-head">
          <div><strong>${escapeHtml(r.profiles?.full_name || "Unknown")}</strong> —
            ${fmtDateNice(r.from_date)}${r.to_date !== r.from_date ? " – " + fmtDateNice(r.to_date) : ""}</div>
          <span class="badge ${statusCls[r.status]}">${r.status}</span>
        </div>
        <div class="hint-text">${escapeHtml(r.reason)}</div>
        ${days.map((d) => {
          const badge = d.day_status === "cancelled"
            ? `<span class="badge badge-cancelled">Cancelled</span>`
            : (() => { const b = leaveDayBadge(d.day_portion, d.type); return `<span class="badge ${b.cls}">${b.label}</span>`; })();
          const canAct = r.status === "approved" && d.day_status === "active";
          return `
            <div class="day-line" data-day-id="${d.id}" data-date="${d.date}" data-portion="${d.day_portion}" data-staff-name="${escapeHtml(r.profiles?.full_name || "")}">
              <span>${fmtDateNice(d.date)}</span>
              <span style="display:flex; gap:6px; align-items:center;">
                ${badge}
                ${canAct ? `<button class="btn btn-outline btn-small act-owner-cancel-day">Cancel</button>` : ""}
                ${canAct && d.day_portion === "full" ? `<button class="btn btn-outline btn-small act-owner-shorten-day">Shorten to half-day</button>` : ""}
              </span>
            </div>`;
        }).join("")}
      </div>`;
  }).join("");

  $all(".act-owner-cancel-day", container).forEach((btn) => {
    btn.onclick = async () => {
      const line = btn.closest(".day-line");
      const ok = await confirmAction(`Cancel ${line.dataset.staffName}'s approved leave for ${fmtDateNice(line.dataset.date)}?`);
      if (!ok) return;
      const { error: e2 } = await sb.from("leave_request_days").update({ day_status: "cancelled" }).eq("id", line.dataset.dayId);
      if (e2) { alert("Couldn't cancel: " + e2.message); return; }
      renderApprovalsView(parentEl);
    };
  });
  $all(".act-owner-shorten-day", container).forEach((btn) => {
    btn.onclick = async () => {
      const line = btn.closest(".day-line");
      const ok = await confirmAction(`Shorten ${line.dataset.staffName}'s approved leave for ${fmtDateNice(line.dataset.date)} to a half-day?`);
      if (!ok) return;
      const { error: e2 } = await sb.from("leave_request_days").update({ day_portion: "half" }).eq("id", line.dataset.dayId);
      if (e2) { alert("Couldn't update: " + e2.message); return; }
      renderApprovalsView(parentEl);
    };
  });
}

// ============================================================================
// OWNER: Staff & Salary tab
// ============================================================================
// Self-signed-up accounts (role is still null) waiting on the owner to
// review them. Approving fills in exactly the fields the account needs to
// start using the app; salary (for staff) is set afterward from the
// regular Staff Directory list below, same as any other staff member.
async function renderPendingSignups(cardEl, listEl, parentEl) {
  const { data, error } = await sb
    .from("profiles")
    .select("id, full_name, created_at")
    .is("role", null)
    .order("created_at");

  if (error || !data || data.length === 0) { cardEl.style.display = "none"; return; }
  cardEl.style.display = "block";

  listEl.innerHTML = data.map((p) => `
    <div class="request-item" data-pending="${p.id}">
      <strong>${escapeHtml(p.full_name)}</strong>
      <div class="hint-text">Signed up ${fmtDateNice((p.created_at || "").slice(0, 10))}</div>
      <div class="row" style="margin-top:8px;">
        <div><label>Employee code</label><input type="text" class="pend-code" placeholder="e.g. E010" /></div>
        <div><label>Role</label>
          <select class="pend-role">
            <option value="staff">Staff</option>
            <option value="marker">Attendance Marker</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div><label>Department</label><input type="text" class="pend-dept" /></div>
        <div><label>Designation</label><input type="text" class="pend-desig" /></div>
      </div>
      <label>Join date</label>
      <input type="date" class="pend-join" value="${todayStr()}" />
      <div class="action-group" style="margin-top:10px;">
        <button class="btn btn-primary btn-small act-approve">Approve</button>
        <button class="btn btn-danger btn-small act-dismiss">Dismiss</button>
      </div>
    </div>`).join("");

  $all(".act-approve", listEl).forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest("[data-pending]");
      const id = row.dataset.pending;
      const name = $("strong", row).textContent;
      const code = $(".pend-code", row).value.trim();
      const role = $(".pend-role", row).value;
      const department = $(".pend-dept", row).value.trim();
      const designation = $(".pend-desig", row).value.trim();
      const join_date = $(".pend-join", row).value;
      if (!code) { alert("Enter an employee code first."); return; }
      const ok = await confirmAction(`Approve ${name} as ${role === "marker" ? "Attendance Marker" : "Staff"} with employee code "${code}"?`);
      if (!ok) return;
      const { error: updErr } = await sb.from("profiles").update({
        employee_code: code, role, department: department || null, designation: designation || null,
        join_date: join_date || null, is_active: true,
      }).eq("id", id);
      if (updErr) { alert("Couldn't approve: " + updErr.message); return; }
      renderStaffSalaryTab(parentEl);
    };
  });

  $all(".act-dismiss", listEl).forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest("[data-pending]");
      const id = row.dataset.pending;
      const name = $("strong", row).textContent;
      const ok = await confirmAction(`Dismiss ${name}'s sign-up request? They'd need to sign up again if this was a mistake.`);
      if (!ok) return;
      const { error: delErr } = await sb.from("profiles").delete().eq("id", id);
      if (delErr) { alert("Couldn't dismiss: " + delErr.message); return; }
      renderStaffSalaryTab(parentEl);
    };
  });
}

async function renderStaffSalaryTab(el) {
  el.innerHTML = `
    <div class="card" id="pending-signups-card" style="display:none;">
      <h2>Pending sign-ups</h2>
      <div id="pending-signups-list"></div>
    </div>
    <div class="card"><h2>Staff Directory</h2><div id="staff-salary-list">Loading…</div></div>`;

  await renderPendingSignups($("#pending-signups-card", el), $("#pending-signups-list", el), el);

  const container = $("#staff-salary-list", el);

  const { data, error } = await sb
    .from("profiles")
    .select("id, full_name, employee_code, role, department, designation, is_active, staff_salary!staff_id(monthly_salary)")
    .not("role", "is", null)
    .order("full_name");

  if (error) { container.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; return; }

  container.innerHTML = (data || []).map((s) => `
    <div class="staff-row">
      <div>
        <div class="staff-name" data-name="${escapeHtml(s.full_name)}">${escapeHtml(s.full_name)} <span class="hint-text">(${escapeHtml(s.role || "")})</span></div>
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
      const row = btn.closest(".staff-row");
      const staffName = $(".staff-name", row).dataset.name;
      const input = $(`.salary-input[data-staff="${staffId}"]`, container);
      const val = parseFloat(input.value);
      if (isNaN(val)) { alert("Enter a salary amount first."); return; }
      const ok = await confirmAction(`Set ${staffName}'s monthly salary to ${money(val)}?`);
      if (!ok) return;
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
// OWNER: Payroll tab
// ============================================================================
async function renderPayrollTab(el) {
  const now = new Date();
  let year = parseInt(el.dataset.year || now.getFullYear(), 10);
  let month = parseInt(el.dataset.month || now.getMonth() + 1, 10);
  el.dataset.year = year; el.dataset.month = month;

  el.innerHTML = `
    <div class="card">
      <h2>Payroll</h2>
      <div class="row">
        <div><label>Month</label>${monthSelectHtml("pr-month", month)}</div>
        <div><label>Year</label><input type="number" id="pr-year" value="${year}" /></div>
      </div>
      <div id="pr-table" style="overflow-x:auto; margin-top:14px;">Loading…</div>
    </div>
  `;
  $("#pr-month", el).onchange = (e) => { el.dataset.month = e.target.value; renderPayrollTab(el); };
  $("#pr-year", el).onchange = (e) => { el.dataset.year = e.target.value; renderPayrollTab(el); };

  const tableEl = $("#pr-table", el);
  const { data: staffList, error: staffErr } = await sb
    .from("profiles").select("id, full_name").eq("role", "staff").eq("is_active", true).order("full_name");
  if (staffErr) { tableEl.innerHTML = `<div class="error-text">${escapeHtml(staffErr.message)}</div>`; return; }
  if (!staffList || staffList.length === 0) { tableEl.innerHTML = `<div class="hint-text">No active staff yet.</div>`; return; }

  const rows = await Promise.all(staffList.map(async (s) => {
    const [{ data: eff }, { data: bal }, { data: sal }] = await Promise.all([
      sb.rpc("effective_working_days", { p_staff_id: s.id, p_year: year, p_month: month }),
      sb.rpc("staff_paid_leave_balance", { p_staff_id: s.id, p_year: year, p_month: month }),
      sb.rpc("calculate_salary", { p_staff_id: s.id, p_year: year, p_month: month }),
    ]);
    const e = (eff && eff[0]) || {};
    return { name: s.full_name, effective: e.effective_days, unmarked: e.unmarked_days, balance: bal, salary: sal };
  }));

  tableEl.innerHTML = `<table style="border-collapse:collapse; width:100%; font-size:13px;">
    <thead><tr>
      <th style="text-align:left; padding:6px;">Staff</th>
      <th style="padding:6px;">Effective days</th>
      <th style="padding:6px;">Unmarked</th>
      <th style="padding:6px;">Paid leave balance</th>
      <th style="padding:6px;">Calculated salary</th>
    </tr></thead>
    <tbody>
      ${rows.map((r) => `
        <tr style="border-top:1px solid var(--border);">
          <td style="padding:6px;">${escapeHtml(r.name)}</td>
          <td style="padding:6px; text-align:center;">${r.effective != null ? Number(r.effective).toFixed(2) : "—"}</td>
          <td style="padding:6px; text-align:center;">${r.unmarked ?? "—"}</td>
          <td style="padding:6px; text-align:center;">${r.balance != null ? Number(r.balance).toFixed(2) : "—"}</td>
          <td style="padding:6px; text-align:right;">${r.salary != null ? money(r.salary) : "—"}</td>
        </tr>`).join("")}
    </tbody>
  </table>`;
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
