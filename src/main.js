import {
  buildDocIndex,
  extractAnnotationData,
  matchAllAnnotations,
  drawAnnotationsInTarget,
  getAnnotationLabel,
} from "./annotation-matcher.js";

const NV = () => window.NutrientViewer;

// Read at build time from .env (VITE_NUTRIENT_LICENSE_KEY). Empty = evaluation mode.
const LICENSE_KEY = import.meta.env.VITE_NUTRIENT_LICENSE_KEY || undefined;

// every viewer of the app goes through here, so the license key is set in one place
function loadViewer(container, document) {
  return NV().load({ container, document, licenseKey: LICENSE_KEY, useCDN: true });
}

// ---- state ----

let mainInstance = null;
let leftInstance = null;
let rightInstance = null;
let hiddenRefInstance = null;
let hiddenTargetInstance = null;
let lastMatchResults = null;
let pendingTargetFile = null;
let pendingRefFile = null;

// ---- hidden viewers ----
// both documents are loaded in invisible containers for the analysis, the user only
// sees the final result in the main viewer

function getOrCreateHiddenContainer(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
    document.body.appendChild(el);
  }
  return el;
}

async function loadDocumentHidden(id, arrayBuffer) {
  getOrCreateHiddenContainer(id);
  const selector = `#${id}`;
  try { NV().unload(selector); } catch (_) {}

  return loadViewer(selector, arrayBuffer);
}

// ---- main viewer ----

function showView(which) {
  document.getElementById("emptyState").style.display = which === "empty" ? "" : "none";
  document.getElementById("singleViewer").style.display = which === "single" ? "" : "none";
  document.getElementById("compareView").style.display = which === "compare" ? "flex" : "none";
}

function unloadAllViewers() {
  // always unload first, a failed load can leave a container mounted
  try { NV().unload("#singleViewer"); } catch (_) {}
  try { NV().unload("#viewerLeft"); } catch (_) {}
  try { NV().unload("#viewerRight"); } catch (_) {}
  mainInstance = null;
  leftInstance = null;
  rightInstance = null;
}

async function loadMainDocument(source) {
  unloadAllViewers();
  showView("single");

  mainInstance = await loadViewer("#singleViewer", source);

  return mainInstance;
}

// before/after view: reference with the original annotations on the left, target with
// the transferred ones on the right
async function loadCompareView(refSource, targetSource) {
  unloadAllViewers();
  showView("compare");

  [leftInstance, rightInstance] = await Promise.all([
    loadViewer("#viewerLeft", refSource),
    loadViewer("#viewerRight", targetSource),
  ]);

  return { leftInstance, rightInstance };
}

// ---- file select modal ----

let refFile = null;
let targetFile = null;

function openFileSelectModal() {
  refFile = null;
  targetFile = null;
  updateDropZone("ref", null);
  updateDropZone("target", null);
  updateAnalyzeButton();
  document.getElementById("fileSelectModal").style.display = "flex";
}

function closeFileSelectModal() {
  document.getElementById("fileSelectModal").style.display = "none";
}

function updateDropZone(which, file) {
  const zoneId = which === "ref" ? "dropZoneRef" : "dropZoneTarget";
  const labelId = which === "ref" ? "refFilename" : "targetFilename";
  const zone = document.getElementById(zoneId);
  const label = document.getElementById(labelId);
  if (file) {
    zone.classList.add("has-file");
    label.textContent = file.name;
  } else {
    zone.classList.remove("has-file");
    label.textContent = "No file selected";
  }
}

function updateAnalyzeButton() {
  document.getElementById("analyzeBtn").disabled = !(refFile && targetFile);
}

// loads the two sample documents shipped in public/samples so anyone can test the
// matching in one click, without hunting for the files
async function loadSamples() {
  openFileSelectModal();
  try {
    const fetchAsFile = async (url, name) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("sample not found: " + url);
      return new File([await res.arrayBuffer()], name, { type: "application/pdf" });
    };
    refFile = await fetchAsFile("samples/proposal-v1-annotated.pdf", "proposal-v1-annotated.pdf");
    targetFile = await fetchAsFile("samples/proposal-v2.pdf", "proposal-v2.pdf");
    updateDropZone("ref", refFile);
    updateDropZone("target", targetFile);
    updateAnalyzeButton();
  } catch (err) {
    console.error("Loading samples failed:", err);
    showToast("Could not load the sample documents: " + err.message, true);
  }
}

function setupDropZone(zoneId, inputId, which) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);

  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (which === "ref") refFile = file; else targetFile = file;
    updateDropZone(which, file);
    updateAnalyzeButton();
  });

  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.toLowerCase().endsWith(".pdf")) return;
    if (which === "ref") refFile = file; else targetFile = file;
    updateDropZone(which, file);
    updateAnalyzeButton();
  });
}

// ---- analysis ----

function setProcessingMessage(msg) {
  document.getElementById("processingMessage").textContent = msg;
}

// small toast instead of alert() (alert blocks the whole page)
function showToast(message, isError = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
      "padding:12px 20px;border-radius:6px;color:#fff;font-size:14px;" +
      "box-shadow:0 4px 12px rgba(0,0,0,.25);z-index:10000;transition:opacity .3s;";
    document.body.appendChild(el);
  }
  el.style.backgroundColor = isError ? "#c0392b" : "#2d8a4e";
  el.textContent = message;
  el.style.opacity = "1";
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = "0"; }, 5000);
}

function showProcessing(visible) {
  document.getElementById("processingOverlay").style.display = visible ? "flex" : "none";
}

async function runAnalysis() {
  closeFileSelectModal();
  showProcessing(true);

  try {
    setProcessingMessage("Loading reference document…");
    const refBuffer = await refFile.arrayBuffer();
    hiddenRefInstance = await loadDocumentHidden("hiddenRefContainer", refBuffer);

    setProcessingMessage("Loading target document…");
    pendingTargetFile = targetFile;
    pendingRefFile = refFile;
    // fresh copy of the buffer, we need the original intact for when Draw is clicked
    hiddenTargetInstance = await loadDocumentHidden("hiddenTargetContainer", await targetFile.arrayBuffer());

    setProcessingMessage("Indexing document text…");
    const [refIndex, targetIndex] = await Promise.all([
      buildDocIndex(hiddenRefInstance),
      buildDocIndex(hiddenTargetInstance),
    ]);

    setProcessingMessage("Extracting annotations and anchor text…");
    const annotationData = await extractAnnotationData(
      hiddenRefInstance,
      refIndex,
      (done, total) => setProcessingMessage(`Extracting annotations… ${done} / ${total}`)
    );

    if (annotationData.length === 0) {
      showProcessing(false);
      showToast("No annotations found in the reference document.", true);
      return;
    }

    setProcessingMessage(`Matching ${annotationData.length} annotation(s) in target…`);
    lastMatchResults = await matchAllAnnotations(
      annotationData,
      hiddenTargetInstance,
      targetIndex,
      (done, total) => setProcessingMessage(`Matching annotations… ${done} / ${total}`)
    );

    showProcessing(false);
    showResultsModal(lastMatchResults);
  } catch (err) {
    showProcessing(false);
    console.error("Analysis failed:", err);
    showToast("Analysis failed: " + err.message, true);
  }
}

// ---- results modal ----

function showResultsModal(matchResults) {
  const matched = matchResults.filter((r) => r.matched).length;
  const total = matchResults.length;

  document.getElementById("resultsSubtitle").textContent =
    `Found ${total} annotation(s) in the reference document. ${matched} matched a location in the target.`;

  const tbody = document.getElementById("resultsBody");
  tbody.innerHTML = "";

  matchResults.forEach((result, index) => {
    const { annotationData, matched, chosenResult, reason } = result;
    const typeLabel = getAnnotationLabel(annotationData.annotType);
    const anchorText = annotationData.anchorText || "-";
    const refPage = annotationData.refPageIndex + 1;
    const targetPage = chosenResult ? chosenResult.pageIndex + 1 : "-";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><span class="badge badge-type">${typeLabel}</span></td>
      <td>${refPage}</td>
      <td class="anchor-text-cell" title="${escapeHtml(anchorText)}">${escapeHtml(anchorText)}</td>
      <td>${
        matched && result.usedPageFallback
          ? '<span class="badge badge-match" title="Placed by page position (no text anchor found)">Page match</span>'
          : matched
          ? '<span class="badge badge-match">Match</span>'
          : `<span class="badge badge-no-match" title="${escapeHtml(reason || "")}">No match</span>`
      }</td>
      <td>${targetPage}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("drawBtn").disabled = matched === 0;
  document.getElementById("resultsModal").style.display = "flex";
}

function closeResultsModal() {
  document.getElementById("resultsModal").style.display = "none";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- draw ----

async function handleDrawAnnotations() {
  if (!lastMatchResults || !pendingTargetFile || !pendingRefFile) return;
  closeResultsModal();
  showProcessing(true);
  setProcessingMessage("Loading before/after view…");

  try {
    const [refBuffer, targetBuffer] = await Promise.all([
      pendingRefFile.arrayBuffer(),
      pendingTargetFile.arrayBuffer(),
    ]);
    await loadCompareView(refBuffer, targetBuffer);

    setProcessingMessage("Writing annotations…");
    const count = await drawAnnotationsInTarget(lastMatchResults, rightInstance);

    // export and reload the result: this bakes the appearance streams in the PDF so
    // every annotation renders exactly like it will in the saved document (some
    // viewers don't display freshly created notes until they have their appearance)
    setProcessingMessage("Finalizing annotated document…");
    const finalBuffer = await rightInstance.exportPDF();
    try { NV().unload("#viewerRight"); } catch (_) {}
    rightInstance = await loadViewer("#viewerRight", finalBuffer);

    showProcessing(false);
    showToast(`Done! ${count} annotation(s) transferred to the document.`);
  } catch (err) {
    showProcessing(false);
    console.error("Draw failed:", err);
    showToast("Failed to draw annotations: " + err.message, true);
  }
}

// ---- init ----

window.addEventListener("DOMContentLoaded", async () => {
  setupDropZone("dropZoneRef", "refFileInput", "ref");
  setupDropZone("dropZoneTarget", "targetFileInput", "target");

  document.getElementById("matchAnnotationsBtn").addEventListener("click", openFileSelectModal);
  document.getElementById("loadSamplesBtn").addEventListener("click", loadSamples);
  document.getElementById("cancelFileSelect").addEventListener("click", closeFileSelectModal);
  document.getElementById("analyzeBtn").addEventListener("click", runAnalysis);
  document.getElementById("cancelResults").addEventListener("click", closeResultsModal);
  document.getElementById("drawBtn").addEventListener("click", handleDrawAnnotations);

  document.getElementById("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await loadMainDocument(buffer);
  });
});
