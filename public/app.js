"use strict";

const API = "/api/jds";

const state = {
  items: [],
  selectedId: null,
  search: "",
  status: "all",
  editingId: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------- api ----------

async function api(path, options) {
  const res = await fetch(API + (path || ""), {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

// ---------- helpers ----------

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

const esc = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// ---------- list ----------

function renderList() {
  const q = state.search.toLowerCase();
  const filtered = state.items.filter((jd) => {
    const matchesSearch =
      !q ||
      jd.title.toLowerCase().includes(q) ||
      (jd.department || "").toLowerCase().includes(q);
    const matchesStatus = state.status === "all" || jd.status === state.status;
    return matchesSearch && matchesStatus;
  });

  const list = $("#list");
  list.innerHTML = "";
  $("#emptyList").classList.toggle("hidden", filtered.length > 0);

  filtered.forEach((jd) => {
    const btn = document.createElement("button");
    btn.className = "list-item" + (jd.id === state.selectedId ? " selected" : "");
    btn.innerHTML = `
      <div class="li-title">${esc(jd.title)}</div>
      <div class="li-meta">
        ${esc(jd.department || "No department")} ·
        <span class="badge ${jd.status}">${jd.status}</span>
      </div>`;
    btn.onclick = () => selectJd(jd.id);
    list.appendChild(btn);
  });
}

// ---------- viewer ----------

function renderViewer() {
  const jd = state.items.find((j) => j.id === state.selectedId);
  const viewer = $("#viewer");

  if (!jd) {
    viewer.innerHTML = `
      <div class="placeholder">
        <h2>Select a job description</h2>
        <p class="muted">Choose one from the list, or create a new one to get started.</p>
      </div>`;
    return;
  }

  const meta = [jd.department, jd.location, jd.employmentType]
    .filter(Boolean)
    .map(esc)
    .join(" · ");

  const sections = jd.sections
    .filter((s) => s.heading || s.items.length)
    .map(
      (s) => `
      <div class="doc-section">
        <h3>${esc(s.heading)}</h3>
        <ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      </div>`
    )
    .join("");

  viewer.innerHTML = `
    <div class="doc-head">
      <div>
        <h2>${esc(jd.title)}</h2>
        <div class="doc-meta">
          ${meta ? `<span>${meta}</span>` : ""}
          <span class="badge ${jd.status}">${jd.status}</span>
          <span>Updated ${new Date(jd.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="doc-actions">
        <button class="btn btn-ghost" id="printBtn">Print</button>
        <button class="btn btn-primary" id="editBtn">Edit</button>
      </div>
    </div>
    ${jd.summary ? `<div class="doc-summary">${esc(jd.summary)}</div>` : ""}
    ${sections || '<p class="muted">No sections yet — click Edit to add responsibilities.</p>'}
  `;

  $("#editBtn").onclick = () => openEditor(jd);
  $("#printBtn").onclick = () => window.print();
}

function selectJd(id) {
  state.selectedId = id;
  renderList();
  renderViewer();
}

// ---------- editor ----------

const editor = $("#editor");
const sectionsEl = $("#sections");
const sectionTpl = $("#sectionTemplate");

function addSectionRow(section = { heading: "", items: [] }) {
  const node = sectionTpl.content.firstElementChild.cloneNode(true);
  node.querySelector(".section-heading").value = section.heading || "";
  const itemsEl = node.querySelector(".items");

  const addItemRow = (value = "") => {
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `<input value="${esc(value)}" placeholder="Responsibility / bullet" />
      <button type="button" class="icon-btn" aria-label="Remove bullet">✕</button>`;
    row.querySelector("button").onclick = () => row.remove();
    itemsEl.appendChild(row);
  };

  (section.items && section.items.length ? section.items : [""]).forEach(addItemRow);

  node.querySelector(".add-item").onclick = () => addItemRow();
  node.querySelector(".remove-section").onclick = () => node.remove();
  sectionsEl.appendChild(node);
}

function openEditor(jd) {
  state.editingId = jd ? jd.id : null;
  $("#editorTitle").textContent = jd ? "Edit Job Description" : "New Job Description";
  sectionsEl.innerHTML = "";

  const form = $("#editorForm");
  form.reset();

  if (jd) {
    form.title.value = jd.title || "";
    form.department.value = jd.department || "";
    form.location.value = jd.location || "";
    form.employmentType.value = jd.employmentType || "";
    form.summary.value = jd.summary || "";
    form.status.value = jd.status || "draft";
    jd.sections.forEach(addSectionRow);
  } else {
    addSectionRow({ heading: "", items: [""] });
  }

  $("#deleteBtn").classList.toggle("hidden", !jd);
  editor.showModal();
}

function collectForm() {
  const form = $("#editorForm");
  const sections = [...sectionsEl.querySelectorAll(".section-row")].map((row) => ({
    heading: row.querySelector(".section-heading").value,
    items: [...row.querySelectorAll(".item-row input")].map((i) => i.value),
  }));

  return {
    title: form.title.value,
    department: form.department.value,
    location: form.location.value,
    employmentType: form.employmentType.value,
    summary: form.summary.value,
    status: form.status.value,
    sections,
  };
}

async function save() {
  const payload = collectForm();
  if (!payload.title.trim()) return toast("Job title is required");

  try {
    let saved;
    if (state.editingId) {
      saved = await api("/" + state.editingId, { method: "PUT", body: JSON.stringify(payload) });
      state.items = state.items.map((j) => (j.id === saved.id ? saved : j));
    } else {
      saved = await api("", { method: "POST", body: JSON.stringify(payload) });
      state.items.unshift(saved);
    }
    state.selectedId = saved.id;
    editor.close();
    renderList();
    renderViewer();
    toast("Saved");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function removeJd() {
  if (!state.editingId || !confirm("Delete this job description?")) return;
  try {
    await api("/" + state.editingId, { method: "DELETE" });
    state.items = state.items.filter((j) => j.id !== state.editingId);
    if (state.selectedId === state.editingId) state.selectedId = null;
    state.editingId = null;
    editor.close();
    renderList();
    renderViewer();
    toast("Deleted");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

// ---------- wiring ----------

$("#newBtn").onclick = () => openEditor(null);
$("#addSection").onclick = () => addSectionRow();
$("#closeEditor").onclick = () => editor.close();
$("#cancelBtn").onclick = () => editor.close();
$("#deleteBtn").onclick = removeJd;
$("#editorForm").onsubmit = (e) => {
  e.preventDefault();
  save();
};
$("#search").oninput = (e) => {
  state.search = e.target.value;
  renderList();
};
$("#filters").onclick = (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.status = chip.dataset.status;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderList();
};

// ---------- init ----------

(async function init() {
  try {
    state.items = await api();
    if (state.items.length) state.selectedId = state.items[0].id;
    renderList();
    renderViewer();
  } catch (err) {
    toast("Failed to load: " + err.message);
  }
})();
