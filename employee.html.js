
const CODE = window.location.pathname.split("/").pop();
let state = null;

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts && opts.headers) },
  });
  if (!res.ok) throw new Error((await res.json()).error || "Erreur");
  return res.json();
}

function fmtMoney(n) {
  n = isFinite(n) ? n : 0;
  return n.toLocaleString("fr-CA", { style: "currency", currency: "CAD" });
}
function fmtPct(n) {
  n = isFinite(n) ? n : 0;
  return n.toFixed(1) + "%";
}

async function load() {
  try {
    state = await api(`/api/employee/${CODE}`);
    render();
  } catch (e) {
    document.getElementById("app").innerHTML = `
      <div class="error-box">
        <h2>Code invalide</h2>
        <p>Vérifie le lien reçu, ou contacte ton gérant.</p>
      </div>`;
  }
}

async function saveEntry(entry) {
  await api(`/api/employee/${CODE}/entries`, { method: "POST", body: JSON.stringify(entry) });
}

async function deleteEntry(date) {
  await api(`/api/employee/${CODE}/entries/${date}`, { method: "DELETE" });
}

function render() {
  const { employee, restaurant, entries } = state;
  const totVentes = entries.reduce((s, e) => s + e.ventes, 0);
  const totClients = entries.reduce((s, e) => s + e.clients, 0);
  const totBrut = entries.reduce((s, e) => s + e.pourboireBrut, 0);
  const totNet = entries.reduce((s, e) => s + e.net, 0);
  const pctMoyen = totVentes > 0 ? (totBrut / totVentes) * 100 : 0;
  const parClient = totClients > 0 ? totNet / totClients : 0;

  document.getElementById("app").innerHTML = `
    <div class="header">
      <p class="eyebrow">${restaurant.name}</p>
      <h1 class="title">Salut ${employee.name.split(" ")[0]} 👋</h1>
      <p class="saved-note">Sauvegardé automatiquement</p>
    </div>
    <div class="content">
      <div class="kpi-grid">
        <div class="card"><div class="kpi-label" style="color:#0B5D5C">💰 Ventes totales</div><div class="kpi-value" style="color:#0B5D5C">${fmtMoney(totVentes)}</div></div>
        <div class="card"><div class="kpi-label" style="color:#2E9E5B">📈 Pourboires nets</div><div class="kpi-value" style="color:#2E9E5B">${fmtMoney(totNet)}</div></div>
        <div class="card"><div class="kpi-label" style="color:#F2994A">% Pourboire moyen</div><div class="kpi-value" style="color:#F2994A">${fmtPct(pctMoyen)}</div></div>
        <div class="card"><div class="kpi-label" style="color:#F26D6D">👥 $ moyen / client</div><div class="kpi-value" style="color:#F26D6D">${fmtMoney(parClient)}</div></div>
      </div>

      <div class="section-title">
        <span>Journées (${entries.length})</span>
        <button class="add-btn" id="addBtn">+ Ajouter</button>
      </div>
      <div id="daysList"></div>
    </div>
  `;

  const list = document.getElementById("daysList");
  list.innerHTML = "";
  entries.forEach((e) => {
    const card = document.createElement("div");
    card.className = "card day-card";
    card.innerHTML = `
      <div class="day-head">
        <input type="date" value="${e.date}" data-date="${e.date}" data-field="date" />
        <button class="del-btn" data-date="${e.date}" data-action="del">🗑</button>
      </div>
      <div class="field-grid">
        <div class="field"><label>Ventes $</label>
          <input type="number" inputmode="decimal" placeholder="0.00" value="${e.ventes || ""}" data-date="${e.date}" data-field="ventes" /></div>
        <div class="field"><label># Clients</label>
          <input type="number" inputmode="numeric" placeholder="0" value="${e.clients || ""}" data-date="${e.date}" data-field="clients" /></div>
        <div class="field pct"><label>% Pourboire</label>
          <input type="number" inputmode="decimal" placeholder="10" value="${e.pct || ""}" data-date="${e.date}" data-field="pct" /></div>
        <div class="field"><label>Remis employés $</label>
          <input type="number" inputmode="decimal" placeholder="0.00" value="${e.remis || ""}" data-date="${e.date}" data-field="remis" /></div>
      </div>
      <div class="day-summary">
        <span>Moy./client <b>${fmtMoney(e.moyenne)}</b></span>
        <span>Pourboires <b>${fmtMoney(e.pourboireBrut)}</b></span>
        <span class="net">Net <b>${fmtMoney(e.net)}</b></span>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('input[data-field]:not([data-field="date"])').forEach((inp) => {
    inp.addEventListener("change", async (ev) => {
      const date = ev.target.dataset.date;
      const entry = entries.find((x) => x.date === date) || { date };
      entry[ev.target.dataset.field] = parseFloat(ev.target.value) || 0;
      await saveEntry(entry);
      await load();
    });
  });
  list.querySelectorAll('input[data-field="date"]').forEach((inp) => {
    inp.addEventListener("change", async (ev) => {
      const oldDate = ev.target.dataset.date;
      const entry = entries.find((x) => x.date === oldDate);
      const newDate = ev.target.value;
      await deleteEntry(oldDate);
      await saveEntry({ ...entry, date: newDate });
      await load();
    });
  });
  list.querySelectorAll('[data-action="del"]').forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      await deleteEntry(ev.target.dataset.date);
      await load();
    });
  });

  document.getElementById("addBtn").addEventListener("click", async () => {
    const last = entries[entries.length - 1];
    const base = last ? new Date(last.date + "T12:00:00") : new Date();
    base.setDate(base.getDate() + (last ? 1 : 0));
    const newDate = base.toISOString().slice(0, 10);
    await saveEntry({ date: newDate, ventes: 0, clients: 0, pct: 0, remis: 0 });
    await load();
  });
}

load();
