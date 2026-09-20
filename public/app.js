const state = { jobs: [], editId: null, selectedJobId: "", files: [], batch: null, progress: null };
const $ = (selector) => document.querySelector(selector);
const labels = {
  match: "建议匹配", review: "人工复核", not_match: "条件不符", error: "处理失败",
  met: "满足", unmet: "不满足", unknown: "信息不足", scored: "等级评分"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 4200);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function jsonOptions(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function updateMetrics() {
  $("#job-count").textContent = state.jobs.length;
  $("#saved-count").textContent = state.jobs.length;
  $("#resume-count").textContent = state.batch?.total ?? 0;
  $("#match-count").textContent = state.batch?.counts.match ?? 0;
}

function renderJobs() {
  const list = $("#jobs-list");
  if (!state.jobs.length) {
    list.innerHTML = '<div class="job-empty"><div class="job-empty-icon">▤</div><strong>还没有保存的职位</strong><p>从右侧创建一个职位，<br>即可开始筛选简历。</p></div>';
  } else {
    list.innerHTML = state.jobs.map((job) => `
      <button type="button" class="job-item ${job.id === state.editId ? "active" : ""}" data-job-id="${escapeHtml(job.id)}">
        <span class="job-avatar">${escapeHtml(job.title.slice(0, 1))}</span>
        <span class="job-item-copy"><strong>${escapeHtml(job.title)}</strong><small>${job.requirements.length} 条招聘要求</small></span>
        <span class="job-item-arrow">›</span>
      </button>`).join("");
  }
  const select = $("#screen-job");
  select.innerHTML = '<option value="">请选择已保存的职位</option>' + state.jobs.map((job) =>
    `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join("");
  if (!state.jobs.some((job) => job.id === state.selectedJobId)) state.selectedJobId = state.jobs[0]?.id ?? "";
  select.value = state.selectedJobId;
  updateMetrics();
}

function requirementKind(item) {
  if (item.required !== false) return "required";
  if (item.levels) return "bonus-graded";
  if (item.bonusPoints) return "bonus-binary";
  return "optional";
}

function updateRequirementCard(card) {
  const kind = card.querySelector(".requirement-kind").value;
  card.classList.toggle("is-bonus", kind.startsWith("bonus-"));
  card.classList.toggle("is-graded", kind === "bonus-graded");
}

function renumberRequirements() {
  $("#requirement-list").querySelectorAll(".requirement-card").forEach((card, index) => {
    card.querySelector(".requirement-number").textContent = `条件 ${String(index + 1).padStart(2, "0")}`;
  });
  $("#job-form-hint").textContent = `当前 ${$("#requirement-list").children.length} 条招聘要求`;
}

function addRequirement(item = {}) {
  const fragment = $("#requirement-template").content.cloneNode(true);
  const card = fragment.querySelector(".requirement-card");
  card.dataset.id = item.id || `r_${crypto.randomUUID().slice(0, 8)}`;
  card.querySelector(".requirement-kind").value = requirementKind(item);
  card.querySelector(".requirement-text").value = item.text || "";
  card.querySelector(".bonus-points").value = item.bonusPoints ?? 10;
  card.querySelector(".requirement-levels").value = item.levels?.join("\n") || "";
  card.querySelector(".requirement-kind").addEventListener("change", () => updateRequirementCard(card));
  card.querySelector(".remove-requirement").addEventListener("click", () => {
    card.remove();
    renumberRequirements();
  });
  updateRequirementCard(card);
  $("#requirement-list").append(card);
  renumberRequirements();
}

function editJob(job = null) {
  const isSaved = Boolean(job?.id);
  state.editId = isSaved ? job.id : null;
  $("#job-title").value = job?.title || "";
  $("#editor-title").textContent = isSaved ? "编辑职位" : "新建职位";
  $("#delete-job-button").hidden = !isSaved;
  $("#requirement-list").replaceChildren();
  for (const item of job?.requirements?.length ? job.requirements : [{}]) addRequirement(item);
  renderJobs();
}

function readJobForm() {
  const title = $("#job-title").value.trim();
  if (!title) throw new Error("请输入职位名称");
  const cards = [...$("#requirement-list").querySelectorAll(".requirement-card")];
  if (!cards.length) throw new Error("请至少添加一条招聘要求");
  const requirements = cards.map((card, index) => {
    const text = card.querySelector(".requirement-text").value.trim();
    if (!text) throw new Error(`请填写第 ${index + 1} 条招聘要求`);
    const kind = card.querySelector(".requirement-kind").value;
    const item = { id: card.dataset.id, text, required: kind === "required" };
    if (kind.startsWith("bonus-")) {
      const points = Number(card.querySelector(".bonus-points").value);
      if (!Number.isFinite(points) || points <= 0 || points > 100) throw new Error(`第 ${index + 1} 条加分值应在 1–100 之间`);
      item.bonusPoints = points;
    }
    if (kind === "bonus-graded") {
      const levels = card.querySelector(".requirement-levels").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (levels.length < 2 || levels.length > 5) throw new Error(`第 ${index + 1} 条需要 2–5 个评分等级`);
      item.levels = levels;
    }
    return item;
  });
  return { title, requirements };
}

async function refreshJobs() {
  state.jobs = (await api("/api/jobs")).jobs;
  renderJobs();
}

const javaPreset = {
  title: "Java 高级开发",
  requirements: [
    { id: "experience", text: "有至少 5 年 Java 后端开发工作经验", required: true },
    { id: "delivery", text: "亲自参与过至少一个已上线或实际落地的项目，并能说明承担的具体工作", required: true },
    { id: "company", text: "曾在 HR 指定的企业名单（阿里巴巴、腾讯、字节跳动）中至少一家作为正式员工任职满 12 个月；外包或驻场不计", required: false, bonusPoints: 10 },
    { id: "complex", text: "参与或主导过已上线复杂生产系统的设计与优化，能说明本人职责、系统规模、技术难点和实际结果", required: false, bonusPoints: 20,
      levels: ["没有可核实的复杂生产系统经历，或只有技术名词而无项目事实", "参与已上线复杂生产系统的模块开发，能说明本人职责", "负责已上线复杂生产系统的关键模块设计或优化，说明规模、难点、方案和结果", "主导已上线复杂生产系统的架构或性能治理，给出量化规模、关键决策和验证结果"] }
  ]
};

function addFiles(incoming) {
  for (const file of incoming) {
    if (!/\.(pdf|zip)$/i.test(file.name)) {
      toast(`仅支持 PDF 或 ZIP：${file.name}`, true);
      continue;
    }
    if (!state.files.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) {
      state.files.push(file);
    }
  }
  renderFiles();
}

function renderFiles() {
  $("#file-list").innerHTML = state.files.map((file, index) => `
    <span class="file-chip"><span>${file.name.toLowerCase().endsWith("zip") ? "ZIP" : "PDF"}</span><span class="file-chip-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><button type="button" data-remove-file="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button></span>`).join("");
}

function statusClass(status) {
  return ["match", "review", "not_match", "met", "unmet", "unknown", "scored", "error"].includes(status) ? status : "review";
}

function renderCondition(item) {
  const type = item.required ? "必要条件" : item.bonusPointsPossible ? "加分项" : "偏好条件";
  const points = item.bonusPointsPossible !== undefined
    ? `<span class="condition-score">${item.score === undefined ? "" : `等级 ${Number(item.score).toFixed(2)}/${item.scoreMax} · `}+${item.bonusPointsEarned} / ${item.bonusPointsPossible} 分</span>`
    : item.score !== undefined ? `<span class="condition-score">等级 ${Number(item.score).toFixed(2)} / ${item.scoreMax}</span>` : "";
  return `<div class="condition-row"><div class="condition-head"><span class="condition-type">${type}</span><strong>${escapeHtml(item.condition)}</strong><span class="badge ${statusClass(item.status)}">${labels[item.status] || "待核对"}</span>${points}</div>
    ${item.evidence ? `<blockquote class="evidence">${escapeHtml(item.evidence.text)}</blockquote>` : ""}
    ${item.reviewReason ? `<p class="review-reason">${escapeHtml(item.reviewReason)}</p>` : ""}</div>`;
}

const lanes = [
  { key: "match", title: "建议匹配", description: "必要条件全部满足", symbol: "✓" },
  { key: "not_match", title: "条件不符", description: "必要条件明确不满足", symbol: "×" },
  { key: "review", title: "人工复核", description: "信息或证据需要确认", symbol: "?" },
  { key: "error", title: "处理失败", description: "文件或服务需要检查", symbol: "!" }
];

function resultCategory(item) {
  return item.status === "error" ? "error" : item.screening.recommendation;
}

function resultSummary(item) {
  if (item.status === "error") return item.error;
  const requirements = item.screening.requirements;
  const required = requirements.filter((condition) => condition.required);
  const met = required.filter((condition) => condition.status === "met").length;
  const exception = required.find((condition) => condition.status === "unmet" || condition.status === "review" || condition.status === "unknown");
  if (exception) return `${met}/${required.length} 项必要条件满足 · ${exception.condition}`;
  return `${met}/${required.length} 项必要条件满足${item.screening.bonus ? ` · 加分 ${item.screening.bonus.earned}/${item.screening.bonus.possible}` : ""}`;
}

function renderResumeSlip(item, index) {
  const category = resultCategory(item);
  return `<button type="button" class="resume-slip ${statusClass(category)}" data-result-index="${index}" aria-label="查看 ${escapeHtml(item.fileName)} 的判断原因">
    <span class="slip-icon">PDF</span><span class="slip-copy"><strong title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</strong><small>${escapeHtml(resultSummary(item))}</small></span><span class="slip-arrow" aria-hidden="true">↗</span>
  </button>`;
}

function renderResults() {
  if (!state.batch) return;
  const batch = state.batch;
  const progress = state.progress;
  const completed = progress?.completed ?? batch.total;
  const total = progress?.total || batch.total;
  const percent = total ? Math.round(completed / total * 100) : 0;
  const active = progress?.active;
  const grouped = Object.fromEntries(lanes.map(({ key }) => [key, []]));
  batch.results.forEach((item, index) => grouped[resultCategory(item)].push(renderResumeSlip(item, index)));
  $("#results-content").innerHTML = `
    <div class="sorting-console ${active ? "is-running" : "is-done"}">
      <div class="sorting-topline"><span class="sorting-live-dot"></span><span>${active ? "正在逐份筛选" : "本批次已完成"}</span><strong id="sorting-fraction">${completed} / ${total || "—"}</strong></div>
      <div class="progress-track" role="progressbar" aria-label="简历筛选进度" aria-valuemin="0" aria-valuemax="${total || 100}" aria-valuenow="${completed}"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="sorting-flow"><div class="source-stack" aria-hidden="true"><span></span><span></span><span></span></div><div class="sorting-source"><small>待分拣</small><strong id="sorting-remaining">${Math.max(0, total - completed)}</strong><span>份简历</span></div><span class="sorting-route" aria-hidden="true">⟶</span><div class="sorting-current" id="sorting-current"><small>${active ? "正在等待下一份结果" : "已按判断结果分区"}</small><strong>${active ? "简历逐份进入对应区域" : "点击任意简历查看判断原因"}</strong></div></div>
    </div>
    <div class="board-intro"><div><span class="section-kicker">LIVE SORTING BOARD</span><h3>简历分拣区</h3></div><p>按必要条件分区；加分只影响同一区域内的排序。</p></div>
    <div class="sorting-board">${lanes.map((lane) => `<section class="sort-lane lane-${lane.key}" aria-label="${lane.title}"><div class="lane-heading"><span class="lane-symbol">${lane.symbol}</span><div><strong>${lane.title}</strong><small>${lane.description}</small></div><span class="lane-count" data-lane-count="${lane.key}">${batch.counts[lane.key]}</span></div><div class="lane-list" data-lane-list="${lane.key}">${grouped[lane.key].join("") || '<p class="lane-empty">简历会自动归入这里</p>'}</div></section>`).join("")}</div>`;
  $("#progress-fill").style.width = `${percent}%`;
  updateMetrics();
}

function updateSortingProgress(event) {
  state.progress.completed = event.completed;
  const total = state.progress.total;
  const percent = total ? Math.round(event.completed / total * 100) : 0;
  $("#sorting-fraction").textContent = `${event.completed} / ${total}`;
  $("#sorting-remaining").textContent = Math.max(0, total - event.completed);
  const bar = $("#progress-fill");
  bar.style.width = `${percent}%`;
  bar.parentElement.setAttribute("aria-valuenow", event.completed);
  const category = resultCategory(event.item);
  const current = $("#sorting-current");
  current.className = `sorting-current current-${statusClass(category)}`;
  current.innerHTML = `<small>刚刚分拣 · ${labels[category]}</small><strong>${escapeHtml(event.item.fileName)}</strong>`;
  current.animate([{ opacity: 0.35, transform: "translateX(-12px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: 360, easing: "ease-out" });
  const list = $(`[data-lane-list="${category}"]`);
  list.querySelector(".lane-empty")?.remove();
  list.insertAdjacentHTML("beforeend", renderResumeSlip(event.item, state.batch.results.length - 1));
  list.lastElementChild.classList.add("slip-arrived");
  $(`[data-lane-count="${category}"]`).textContent = state.batch.counts[category];
  updateMetrics();
}

function openResultDetails(index) {
  const item = state.batch?.results[index];
  if (!item) return;
  const category = resultCategory(item);
  $("#result-dialog-title").textContent = item.fileName;
  const body = $("#result-dialog-content");
  if (item.status === "error") {
    body.innerHTML = `<div class="decision-panel decision-error"><span class="badge error">处理失败</span><p>${escapeHtml(item.error)}</p></div>`;
  } else {
    const screening = item.screening;
    const required = screening.requirements.filter((condition) => condition.required);
    const met = required.filter((condition) => condition.status === "met").length;
    const rule = category === "match" ? "所有必要条件均满足，因此建议匹配。"
      : category === "not_match" ? "至少一条必要条件明确不满足，因此归入条件不符。"
        : "必要条件存在信息不足或需要核对的判断，因此归入人工复核。";
    body.innerHTML = `<div class="decision-panel decision-${statusClass(category)}"><span class="badge ${statusClass(category)}">${labels[category]}</span><strong>${met} / ${required.length} 项必要条件满足</strong><p>${rule}</p>${screening.bonus ? `<span class="decision-bonus">加分 ${screening.bonus.earned} / ${screening.bonus.possible} · 只用于排序，不改变必要条件的判断</span>` : ""}</div><h3 class="dialog-subtitle">逐条判断与简历证据</h3><div class="condition-list">${screening.requirements.map(renderCondition).join("")}</div>`;
  }
  $("#result-dialog").showModal();
}

async function streamScreening(form, onEvent) {
  const response = await fetch("/api/screen-files/stream", { method: "POST", body: form });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error("浏览器无法读取筛选进度");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let complete = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let lineEnd;
    while ((lineEnd = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, lineEnd);
      pending = pending.slice(lineEnd + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "error") throw new Error(event.error);
      onEvent(event);
      if (event.type === "complete") complete = true;
    }
  }
  if (!complete) throw new Error("筛选连接意外中断，请重新上传");
}

function setUploadStatus(message, error = false) {
  const element = $("#upload-status");
  element.textContent = message;
  element.classList.toggle("is-error", error);
}

$("#jobs-list").addEventListener("click", (event) => {
  const id = event.target.closest("[data-job-id]")?.dataset.jobId;
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (job) { editJob(job); state.selectedJobId = job.id; $("#screen-job").value = job.id; }
});
$("#new-job-button").addEventListener("click", () => { editJob(); $("#job-title").focus(); });
$("#preset-button").addEventListener("click", () => { editJob(javaPreset); $("#job-title").focus(); toast("已加载示例，请按实际岗位调整后保存"); });
$("#add-requirement").addEventListener("click", () => addRequirement());
$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const job = readJobForm();
    const result = await api(state.editId ? `/api/jobs/${state.editId}` : "/api/jobs", jsonOptions(state.editId ? "PUT" : "POST", job));
    await refreshJobs();
    state.selectedJobId = result.job.id;
    editJob(result.job);
    $("#screen-job").value = result.job.id;
    toast("职位已保存，可以开始筛选简历");
  } catch (error) { toast(error.message, true); }
});
$("#delete-job-button").addEventListener("click", async () => {
  if (!state.editId || !window.confirm("确定删除这个职位？")) return;
  try {
    await api(`/api/jobs/${state.editId}`, { method: "DELETE" });
    state.editId = null;
    await refreshJobs();
    editJob();
    toast("职位已删除");
  } catch (error) { toast(error.message, true); }
});
$("#screen-job").addEventListener("change", (event) => { state.selectedJobId = event.target.value; });

const dropZone = $("#drop-zone");
dropZone.addEventListener("click", () => $("#file-input").click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("#file-input").click(); }
});
for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("dragover"); });
for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("dragover"); });
dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
$("#file-input").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
$("#file-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-file]");
  if (!button) return;
  state.files.splice(Number(button.dataset.removeFile), 1);
  renderFiles();
});
$("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedJobId) return toast("请先选择一个已保存的职位", true);
  if (!state.files.length) return toast("请添加 PDF 或 ZIP 文件", true);
  if (state.files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) return toast("上传总量不能超过 40 MB", true);
  const data = new FormData();
  data.append("jobId", state.selectedJobId);
  for (const file of state.files) data.append("files", file, file.name);
  const button = $("#run-button");
  button.disabled = true;
  button.textContent = "正在筛选…";
  const job = state.jobs.find((candidate) => candidate.id === state.selectedJobId);
  state.batch = { job: { id: job.id, title: job.title }, total: 0,
    counts: { match: 0, review: 0, not_match: 0, error: 0 }, results: [] };
  state.progress = { active: true, total: 0, completed: 0 };
  renderResults();
  setUploadStatus("正在上传并准备简历，随后会逐份显示筛选进度。");
  $("#results").scrollIntoView({ behavior: "smooth" });
  try {
    await streamScreening(data, (event) => {
      if (event.type === "start") {
        state.batch.total = event.total;
        state.batch.job = event.job;
        state.progress.total = event.total;
        renderResults();
        setUploadStatus(`已读取 ${event.total} 份简历，正在逐份筛选。`);
      } else if (event.type === "item") {
        state.batch.results.push(event.item);
        state.batch.counts[resultCategory(event.item)]++;
        updateSortingProgress(event);
        setUploadStatus(`已完成 ${event.completed} / ${event.total} 份 · 建议匹配 ${state.batch.counts.match} · 条件不符 ${state.batch.counts.not_match} · 待复核 ${state.batch.counts.review}`);
      } else if (event.type === "complete") {
        state.batch = event.batch;
        state.progress = { active: false, total: event.batch.total, completed: event.batch.total };
        renderResults();
      }
    });
    setUploadStatus(`筛选完成：${state.batch.counts.match} 份建议匹配，${state.batch.counts.review} 份待复核，${state.batch.counts.error} 份处理失败。`);
  } catch (error) {
    state.progress.active = false;
    renderResults();
    setUploadStatus(error.message, true);
    toast(error.message, true);
  }
  finally { button.disabled = false; button.innerHTML = "开始筛选 <span>→</span>"; }
});
$("#results-content").addEventListener("click", (event) => {
  const button = event.target.closest("[data-result-index]");
  if (button) openResultDetails(Number(button.dataset.resultIndex));
});
$("#close-result-dialog").addEventListener("click", () => $("#result-dialog").close());
$("#result-dialog").addEventListener("click", (event) => {
  if (event.target === $("#result-dialog")) $("#result-dialog").close();
});

editJob();
refreshJobs().catch((error) => toast(`无法加载职位：${error.message}`, true));
