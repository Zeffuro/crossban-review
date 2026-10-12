'use strict';

let evidenceView = null;
let splitView = null;
let evidenceGeneration = 0;
let imageScale = 1;
let selectingArea = false;
let imageGesture = null;
let cropArea = null;

function evidenceUrl(path) { return state.environment === 'browser' ? state.evidenceUrls?.[path] : path; }

function renderEvidence(report) {
    const container = element('div');
    const grid = element('div', 'evidence');
    const selectedImages = new Set();
    const split = mutationButton(t('Move selected screenshots to a new report…'), () => openSplitReport(report, [...selectedImages]));
    split.disabled = true;
    split.dataset.blocked = 'true';
    for (const [index, path] of report.evidence.entries()) {
        if (!/^\/evidence\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(path)) continue;
        const url = evidenceUrl(path);
        if (!url) continue;
        const card = element('div', 'evidence-card');
        const preview = element('button', 'image-preview');
        preview.type = 'button';
        preview.setAttribute('aria-label', t('Zoom screenshot {index}', { index: index + 1 }));
        const image = element('img');
        image.src = url;
        image.alt = t('Attached evidence {index} for {login}', { index: index + 1, login: report.login });
        image.loading = 'lazy';
        preview.append(image);
        preview.addEventListener('click', () => openEvidenceViewer(report.id, path));
        const move = element('label', 'check-line');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.mutation = 'true';
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedImages.add(path); else selectedImages.delete(path);
            split.dataset.blocked = String(!selectedImages.size);
            updateControls();
        });
        move.append(checkbox, element('span', '', t('Move screenshot {index}', { index: index + 1 })));
        card.append(preview, move);
        grid.append(card);
    }
    container.append(grid);
    if (grid.childElementCount) container.append(element('p', 'muted', t('Click an image to zoom or read text. Check screenshots below to split them into a different report.')), split);
    if (report.splitFrom) container.append(element('p', 'muted', t('This report was split from another report. Importing the same export keeps the screenshots separate.')));
    return container;
}

function currentEvidenceReport() { return state?.reports.find(report => report.id === evidenceView?.reportId); }

function openEvidenceViewer(reportId, path) {
    stopImageOcr();
    const report = state.reports.find(item => item.id === reportId);
    if (!report?.evidence.includes(path) || !evidenceUrl(path)) return;
    evidenceView = { reportId, path, generation: ++evidenceGeneration };
    selectingArea = false;
    clearImageArea();
    $('ocrResult').hidden = true;
    $('ocrCandidates').replaceChildren();
    $('ocrText').value = '';
    $('ocrStatus').textContent = '';
    $('viewerImage').alt = t('Screenshot evidence');
    $('viewerImage').onload = fitEvidenceImage;
    $('viewerImage').src = evidenceUrl(path);
    if (!$('evidenceDialog').open) $('evidenceDialog').showModal();
    const index = report.evidence.indexOf(path);
    $('imageNumber').textContent = t('Image {index} of {count}', { index: index + 1, count: report.evidence.length });
    $('previousEvidence').disabled = index <= 0;
    $('nextEvidence').disabled = index >= report.evidence.length - 1;
    if ($('viewerImage').complete && $('viewerImage').naturalWidth) fitEvidenceImage();
}

function setImageScale(scale) {
    const image = $('viewerImage');
    imageScale = Math.max(0.05, Math.min(4, scale));
    image.width = Math.max(1, Math.round(image.naturalWidth * imageScale));
    $('imageZoom').value = String(Math.round(imageScale * 100));
    $('zoomPercent').value = `${Math.round(imageScale * 100)}%`;
    renderImageArea();
}

function fitEvidenceImage() {
    const image = $('viewerImage');
    const viewport = $('imageViewport');
    if (!image.naturalWidth) return;
    setImageScale(Math.min(1, (viewport.clientWidth - 24) / image.naturalWidth, (viewport.clientHeight - 24) / image.naturalHeight));
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
}

function clearImageArea() {
    invalidateImageOcr();
    cropArea = null;
    imageGesture = null;
    $('ocrCrop').hidden = true;
    $('clearOcrArea').disabled = true;
    $('selectOcrArea').setAttribute('aria-pressed', String(selectingArea));
    $('imageViewport').classList.toggle('selecting-area', selectingArea);
}

function renderImageArea() {
    const overlay = $('ocrCrop');
    overlay.hidden = !cropArea;
    if (!cropArea) return;
    overlay.style.left = `${cropArea.x * imageScale}px`;
    overlay.style.top = `${cropArea.y * imageScale}px`;
    overlay.style.width = `${cropArea.width * imageScale}px`;
    overlay.style.height = `${cropArea.height * imageScale}px`;
}

function imagePoint(event) {
    const bounds = $('viewerImage').getBoundingClientRect();
    return { x: Math.max(0, Math.min($('viewerImage').naturalWidth, (event.clientX - bounds.left) / imageScale)),
        y: Math.max(0, Math.min($('viewerImage').naturalHeight, (event.clientY - bounds.top) / imageScale)) };
}

function stopImageOcr() {
    window.CrossbanOcr?.cancel();
    $('readOcr').disabled = false;
    $('cancelOcr').hidden = true;
}

function invalidateImageOcr() {
    evidenceGeneration++;
    stopImageOcr();
    $('ocrResult').hidden = true;
    $('ocrCandidates').replaceChildren();
    $('ocrText').value = '';
    $('ocrStatus').textContent = '';
}

function closeEvidenceViewer() {
    evidenceView = null;
    evidenceGeneration++;
    stopImageOcr();
    if ($('evidenceDialog').open) $('evidenceDialog').close();
}

async function readImageText() {
    const view = evidenceView;
    const image = $('viewerImage');
    if (!view || !currentEvidenceReport()?.evidence.includes(view.path) || !image.complete || !image.naturalWidth) return;
    view.generation = ++evidenceGeneration;
    const generation = view.generation;
    $('readOcr').disabled = true;
    $('cancelOcr').hidden = false;
    $('ocrResult').hidden = true;
    $('ocrStatus').textContent = t('Loading OCR…');
    try {
        const area = cropArea || { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
        const scale = Math.min(2, Math.sqrt(4_000_000 / (area.width * area.height)), 4096 / area.width, 4096 / area.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(area.width * scale));
        canvas.height = Math.max(1, Math.floor(area.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('OCR_UNAVAILABLE');
        context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
        const result = await window.CrossbanOcr.recognize(canvas, event => {
            if (evidenceView === view && generation === evidenceGeneration) $('ocrStatus').textContent = event.status === 'recognizing text'
                ? t('Reading text… {percent}%', { percent: Math.round(event.progress * 100) }) : t('Loading OCR…');
        });
        if (evidenceView !== view || generation !== evidenceGeneration) return;
        $('ocrText').value = result.text;
        $('ocrCandidates').replaceChildren();
        for (const candidate of result.candidates) {
            const card = element('div', 'ocr-candidate');
            card.append(element('code', '', candidate.login), element('span', 'badge', t(candidate.kind === 'sender' ? 'Possible chat sender' : candidate.kind === 'mention' ? 'Mentioned account' : 'Other text')));
            card.append(mutationButton(t('Use as draft'), () => {
                const input = $('reportLogin');
                if (evidenceView !== view || generation !== evidenceGeneration || activeId !== view.reportId || !input) return;
                input.value = candidate.login;
                closeEvidenceViewer();
                input.focus();
                notice(t('Username filled in as a draft. Compare the screenshot, then Save login and look up the exact account.'));
            }), mutationButton(t('Copy name'), () => copyImageText(candidate.login)));
            $('ocrCandidates').append(card);
        }
        if (!result.candidates.length) $('ocrCandidates').append(element('p', 'muted', t('No clear username candidates found. Check the recognized text or type the name manually.')));
        $('ocrResult').hidden = false;
        fitEvidenceImage();
        $('ocrStatus').textContent = t('OCR finished. Suggestions still need your review.');
        updateControls();
    } catch (error) {
        if (evidenceView !== view || generation !== evidenceGeneration) return;
        $('ocrStatus').textContent = t(error.message === 'OCR_CANCELLED' ? 'OCR cancelled.' : 'OCR could not run. Check your connection for the first download, or read the image manually.');
    } finally {
        if (evidenceView === view && generation === evidenceGeneration) {
            $('readOcr').disabled = false;
            $('cancelOcr').hidden = true;
        }
    }
}

async function copyImageText(text) {
    const generation = evidenceGeneration;
    try {
        await navigator.clipboard.writeText(text);
        if (generation === evidenceGeneration) $('ocrStatus').textContent = t('Copied.');
    } catch {
        if (generation !== evidenceGeneration) return;
        $('ocrText').closest('details').open = true;
        $('ocrText').focus();
        const index = $('ocrText').value.indexOf(text);
        if (index >= 0) $('ocrText').setSelectionRange(index, index + text.length); else $('ocrText').select();
        $('ocrStatus').textContent = t('Select the text and copy it manually.');
    }
}

function openSplitReport(report, paths) {
    if (pending || state?.busy || state?.readOnly || !paths.length) return;
    splitView = { reportId: report.id, paths };
    $('splitForm').reset();
    $('splitCount').textContent = countLabel(paths.length, '{count} screenshot will move.', '{count} screenshots will move.');
    $('splitError').hidden = true;
    $('splitDialog').showModal();
    $('splitLogin').focus();
}

$('splitForm').addEventListener('submit', async event => {
    event.preventDefault();
    const split = splitView;
    if (!split || pending || state?.busy || state?.readOnly) return;
    const before = new Set(state.reports.map(report => report.id));
    $('confirmSplit').disabled = true;
    $('cancelSplit').disabled = true;
    $('splitError').hidden = true;
    pending = true;
    updateControls();
    try {
        const next = await request(`/api/reports/${encodeURIComponent(split.reportId)}/split`, {
            evidence: split.paths, login: $('splitLogin').value.trim(), reason: $('splitReason').value.trim(),
        });
        const child = next.reports.find(report => !before.has(report.id));
        if (child) activeId = child.id;
        await applyState(next);
        $('splitDialog').close();
        notice(t('Screenshots moved. Check the new account and review both reports before approving.'));
    } catch (error) {
        try { await applyState(await request('/api/state')); } catch {}
        $('splitError').textContent = translateError(error.message);
        $('splitError').hidden = false;
    } finally {
        pending = false;
        $('confirmSplit').disabled = !!state?.busy || !!state?.readOnly;
        $('cancelSplit').disabled = false;
        updateControls();
    }
});
$('cancelSplit').addEventListener('click', () => { if (!pending) $('splitDialog').close(); });
$('splitDialog').addEventListener('cancel', event => { if (pending) event.preventDefault(); });
$('splitDialog').addEventListener('close', () => { splitView = null; });
$('closeEvidence').addEventListener('click', closeEvidenceViewer);
$('evidenceDialog').addEventListener('close', closeEvidenceViewer);
$('imageZoom').addEventListener('input', event => setImageScale(Number(event.target.value) / 100));
$('fitEvidence').addEventListener('click', fitEvidenceImage);
for (const [id, direction] of [['previousEvidence', -1], ['nextEvidence', 1]]) $(id).addEventListener('click', () => {
    const report = currentEvidenceReport();
    const path = report?.evidence[report.evidence.indexOf(evidenceView.path) + direction];
    if (path) openEvidenceViewer(report.id, path);
});
$('selectOcrArea').addEventListener('click', () => { selectingArea = !selectingArea; clearImageArea(); });
$('clearOcrArea').addEventListener('click', clearImageArea);
$('readOcr').addEventListener('click', readImageText);
$('cancelOcr').addEventListener('click', () => { evidenceGeneration++; stopImageOcr(); $('ocrStatus').textContent = t('OCR cancelled.'); });
$('copyOcrText').addEventListener('click', () => copyImageText($('ocrText').value));
$('imageViewport').addEventListener('pointerdown', event => {
    if (event.button !== 0 || !evidenceView) return;
    if (selectingArea) invalidateImageOcr();
    imageGesture = { id: event.pointerId, start: imagePoint(event), x: event.clientX, y: event.clientY,
        left: $('imageViewport').scrollLeft, top: $('imageViewport').scrollTop };
    $('imageViewport').setPointerCapture(event.pointerId);
    event.preventDefault();
});
$('imageViewport').addEventListener('pointermove', event => {
    if (!imageGesture || event.pointerId !== imageGesture.id) return;
    if (selectingArea) {
        const point = imagePoint(event);
        cropArea = { x: Math.min(point.x, imageGesture.start.x), y: Math.min(point.y, imageGesture.start.y),
            width: Math.abs(point.x - imageGesture.start.x), height: Math.abs(point.y - imageGesture.start.y) };
        renderImageArea();
    } else {
        $('imageViewport').scrollLeft = imageGesture.left + imageGesture.x - event.clientX;
        $('imageViewport').scrollTop = imageGesture.top + imageGesture.y - event.clientY;
    }
});
function endImageGesture(event) {
    if (!imageGesture || event.pointerId !== imageGesture.id) return;
    imageGesture = null;
    if (cropArea && (cropArea.width < 4 || cropArea.height < 4)) cropArea = null;
    $('clearOcrArea').disabled = !cropArea;
    renderImageArea();
}
$('imageViewport').addEventListener('pointerup', endImageGesture);
$('imageViewport').addEventListener('pointercancel', endImageGesture);
document.addEventListener('ui-language-change', () => {
    if (evidenceView) {
        const report = currentEvidenceReport();
        if (report) $('imageNumber').textContent = t('Image {index} of {count}', { index: report.evidence.indexOf(evidenceView.path) + 1, count: report.evidence.length });
        $('ocrStatus').textContent = translateError($('ocrStatus').textContent);
        $('ocrCandidates').querySelectorAll('button, .badge').forEach(node => { node.textContent = translateError(node.textContent); });
    }
    if (splitView) $('splitCount').textContent = countLabel(splitView.paths.length, '{count} screenshot will move.', '{count} screenshots will move.');
});
