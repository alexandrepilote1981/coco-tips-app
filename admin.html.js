
let TOKEN = sessionStorage.getItem("adminToken") || "";
let overview = null;

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN, ...(opts && opts.headers) },
  });
  if (!res.ok) throw new Error((await res.json()).error || "Erreur");
  return res.json();
}

function fmtMoney(n) { n = isFinite(n) ? n : 0; return n.toLocaleString("fr-CA", { style: "currency", currency: "CAD" }); }
function fmtPct(n) { n = isFinite(n) ? n : 0; return (n * 100).toFixed(1) + "%"; }

async function login(password) {
  const r = await fetch("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error("Mot de passe incorrect");
  const { token } = await r.json();
  TOKEN = token;
  sessionStorage.setItem("adminToken", token);
}

function renderLogin(errorMsg) {
  document.getElementById("app").innerHTML = `
    <div class="login-box">
      <h2>Accès admin</h2>
      <input type="password" id="pw" placeholder="Mot de passe" />
      <button id="loginBtn" style="width:100%">Entrer</button>
      ${errorMsg ? `<p style="color:#F26D6D; font-size:12px;">${errorMsg}</p>` : ""}
    </div>`;
  document.getElementById("loginBtn").addEventListener("click", async () => {
    try {
      await login(document.getElementById("pw").value);
      await load();
    } catch (e) {
      renderLogin(e.message);
    }
  });
}

async function load() {
  try {
    overview = await api("/api/admin/overview");
    render();
  } catch (e) {
    renderLogin();
  }
}

function render() {
  const origin = window.location.origin;
  let html = `
    <div class="header"><p class="title">🍧 Tableau de bord — Coco Frutti</p></div>
    <div class="content">
      <div class="card">
        <div class="section-label">Ajouter un restaurant</div>
        <div class="add-form">
          <input type="text" id="newRestaurantName" placeholder="Nom du restaurant (ex: Coco Frutti 016)" />
          <button id="addRestaurantBtn">+ Ajouter</button>
        </div>
      </div>
  `;

  overview.restaurants.forEach((r) => {
    const totVentes = r.employees.reduce((s, e) => s + e.totals.ventes, 0);
    const totNet = r.employees.reduce((s, e) => s + e.totals.net, 0);
    html += `
      <div class="card">
        <div class="restaurant-title">
          <span>${r.name}</span>
          <button class="danger" data-action="delRestaurant" data-id="${r.id}" style="font-size:11px; padding:4px 10px;">Supprimer</button>
        </div>
        <div style="font-size:12px; color:rgba(0,0,0,0.55); margin-bottom:8px;">
          Total : ${fmtMoney(totVentes)} ventes · <b style="color:#2E9E5B">${fmtMoney(totNet)}</b> pourboires nets
        </div>
    `;
    r.employees.forEach((e) => {
      const link = `${origin}/e/${e.access_code}`;
      html += `
        <div class="employee-row">
          <div>
            <div class="employee-name">${e.name} ${e.employee_number ? "· #" + e.employee_number : ""}</div>
            <div class="employee-sub">Code : <b>${e.access_code}</b></div>
            <div class="link-box">${link}</div>
          </div>
          <div class="totals">
            ${fmtMoney(e.totals.ventes)} ventes<br>
            <b>${fmtMoney(e.totals.net)}</b> net · ${fmtPct(e.totals.pctMoyen)}<br>
            <button class="danger" data-action="delEmployee" data-id="${e.id}" style="font-size:10px; padding:3px 8px; margin-top:4px;">Retirer</button>
          </div>
        </div>
      `;
    });
    html += `
        <div class="add-form">
          <input type="text" placeholder="Nom employé" data-restaurant="${r.id}" class="empName" />
          <input type="text" placeholder="# employé" data-restaurant="${r.id}" class="empNumber" style="max-width:100px;" />
          <button data-action="addEmployee" data-id="${r.id}">+ Employé</button>
        </div>
      </div>
    `;
  });

  document.getElementById("app").innerHTML = html;

  document.getElementById("addRestaurantBtn").addEventListener("click", async () => {
    const name = document.getElementById("newRestaurantName").value.trim();
    if (!name) return;
    await api("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name }) });
    await load();
  });

  document.querySelectorAll('[data-action="addEmployee"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rid = btn.dataset.id;
      const name = document.querySelector(`.empName[data-restaurant="${rid}"]`).value.trim();
      const number = document.querySelector(`.empNumber[data-restaurant="${rid}"]`).value.trim();
      if (!name) return;
      await api("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ restaurant_id: rid, name, employee_number: number }),
      });
      await load();
    });
  });

  document.querySelectorAll('[data-action="delEmployee"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Retirer cet employé et ses données?")) return;
      await api(`/api/admin/employees/${btn.dataset.id}`, { method: "DELETE" });
      await load();
    });
  });

  document.querySelectorAll('[data-action="delRestaurant"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Supprimer ce restaurant et toutes ses données?")) return;
      await api(`/api/admin/restaurants/${btn.dataset.id}`, { method: "DELETE" });
      await load();
    });
  });
}

if (TOKEN) load(); else renderLogin();
