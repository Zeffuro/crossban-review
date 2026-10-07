'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let selected = new Set();
let activeId = null;
let channels = [];
let loadedAuth = null;
let pending = false;
let dialogAction = null;
let importSummary = null;
let renderedImportSummary = null;
let loadingChannels = false;

function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
}

function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !message;
}

async function request(path, body, method = 'POST') {
    const response = await fetch(path, {
        method: body === undefined ? 'GET' : method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || data.message || t('Request failed ({status}).', { status: response.status }));
        error.status = response.status;
        throw error;
    }
    return data;
}

async function perform(action, success) {
    if (pending || state?.busy) return;
    pending = true;
    updateControls();
    try {
        const result = await action();
        if (result?.reports) await applyState(result);
        if (success) notice(success);
        return result;
    } catch (error) {
        try { await applyState(await request('/api/state')); } catch {}
        notice(translateError(error.message), true);
    } finally {
        pending = false;
        updateControls();
    }
}

async function applyState(next) {
    state = next;
    if (next.importSummary) importSummary = next.importSummary;
    const valid = new Set(next.reports.filter(canSelect).map((report) => report.id));
    selected = new Set([...selected].filter((id) => valid.has(id)));
    if (!next.reports.some((report) => report.id === activeId)) activeId = next.reports[0]?.id || null;
    $('setup').hidden = next.configured;
    $('connection').textContent = next.auth ? t('Connected as {login}', { login: next.auth.login }) : t('Twitch disconnected');
    $('connect').hidden = !!next.auth;
    $('disconnect').hidden = !next.auth;
    $('reportCount').textContent = next.reports.length;
    if ((next.auth?.id || null) !== loadedAuth) {
        loadedAuth = next.auth?.id || null;
        channels = [];
        if (next.auth) {
            loadingChannels = true;
            updateControls();
            try { channels = (await request('/api/channels')).channels; }
            catch (error) { notice(t('Channel list: {error}', { error: translateError(error.message) }), true); }
            finally { loadingChannels = false; }
        }
        renderChannels();
    }
    renderQueue();
    renderDetail();
    renderHistory();
    renderImportSummary();
    updateControls();
}

function renderImportSummary() {
    const container = $('importSummary');
    container.hidden = !importSummary;
    container.replaceChildren();
    if (!importSummary) return;
    const summary = importSummary;
    container.append(element('strong', '', t('Latest export import coverage')));
    container.append(element('p', '', [countLabel(summary.files, '{count} JSON file', '{count} JSON files'), countLabel(summary.messages, '{count} message', '{count} messages'), countLabel(summary.reports, '{count} report', '{count} reports'), countLabel(summary.ignoredMessages, '{count} message ignored', '{count} messages ignored')].join(' · ')));
    container.append(element('p', '', t('Attachments: {attachments} found · {loaded} loaded · {failed} failed · {unassigned} unassigned', summary)));
    const issues = summary.issues || [];
    const summaryKey = JSON.stringify(summary);
    if (summaryKey !== renderedImportSummary && (issues.length || summary.failed || summary.unassigned)) $('advancedImport').open = true;
    renderedImportSummary = summaryKey;
    if (issues.length) {
        const details = element('details');
        details.append(element('summary', '', countLabel(issues.length, 'Review {count} import issue', 'Review {count} import issues')));
        details.append(element('pre', '', issues.map((issue) => `${issue.fileName || t('Unnamed file')}${issue.messageId ? t(' · message {id}', { id: issue.messageId }) : ''}: ${translateError(issue.reason)}`).join('\n')));
        container.append(details);
    } else if (summary.failed || summary.unassigned) {
        container.append(element('p', '', t('Some attachments were not imported. Check the export files and downloaded assets before approving reports.')));
    } else container.append(element('p', '', t('No import issues reported. Review every report and screenshot before approving.')));
}

function canSelect(report) {
    return !report.sourceWithdrawn && report.decision === 'approved' && report.lookup === 'exists' && !!report.resolved;
}

function updateControls() {
    const locked = pending || loadingChannels || !!state?.busy;
    for (const id of ['import', 'importExport', 'demo', 'connect', 'disconnect', 'resolve']) $(id).disabled = locked || !state || (id === 'connect' && !state?.configured);
    $('resolve').disabled ||= !state?.auth || !state.reports.length;
    $('channel').disabled = locked || !state?.auth;
    $('prepare').disabled = locked || !selected.size || !$('channel').value;
    $('prepare').classList.toggle('spinning', locked);
    $('selectedCount').textContent = t('{count} selected', { count: selected.size }) + (state?.busy ? t(' · Action in progress') : '');
    document.querySelectorAll('[data-mutation]').forEach((node) => { node.disabled = locked || node.dataset.blocked === 'true'; });
    document.querySelectorAll('.report input').forEach((node) => {
        node.disabled = locked || !canSelect(state.reports.find((report) => report.id === node.dataset.id));
    });
}

function renderChannels() {
    const previous = $('channel').value;
    $('channel').replaceChildren();
    const prompt = element('option', '', state.auth ? t('Choose a channel…') : t('Connect Twitch to choose a channel'));
    prompt.value = '';
    $('channel').append(prompt);
    for (const channel of channels) {
        const option = element('option', '', `${channel.displayName || channel.login} (@${channel.login})`);
        option.value = channel.id;
        $('channel').append(option);
    }
    if (channels.some((channel) => channel.id === previous)) $('channel').value = previous;
}

function renderQueue() {
    const focusedId = document.activeElement?.dataset.id;
    const query = $('filter').value.trim().toLowerCase();
    const decision = $('statusFilter').value;
    const reports = state.reports.filter((report) => (decision === 'all' || report.decision === decision)
        && `${report.login} ${report.reason} ${report.streamer}`.toLowerCase().includes(query));
    $('queue').replaceChildren();
    if (!reports.length) $('queue').append(element('div', 'empty', state.reports.length ? t('No reports match this filter.') : t('Your imported reports will appear here.')));
    for (const report of reports) {
        const row = element('div', `report${report.id === activeId ? ' active' : ''}`);
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.id = report.id;
        checkbox.setAttribute('aria-label', t('Select {login} for a permanent ban', { login: report.login }));
        checkbox.checked = selected.has(report.id);
        checkbox.disabled = !canSelect(report);
        checkbox.title = canSelect(report) ? t('Select reviewed account') : t('Approve this report and resolve the exact Twitch user first');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(report.id); else selected.delete(report.id);
            renderDetail();
            updateControls();
        });
        const open = element('button', 'report-open');
        open.type = 'button';
        const head = element('div', 'report-head');
        head.append(element('span', 'report-login', report.login || t('Login needs attention')));
        open.append(head, element('p', 'report-reason', report.reason || t('No reason parsed. Read the original report.')));
        const badges = element('div', 'badges');
        badges.append(element('span', `badge${report.decision === 'approved' ? ' good' : ''}`, t(report.decision)));
        badges.append(element('span', `badge${report.lookup === 'missing' ? ' warn' : ''}`, report.lookup === 'exists' ? t('Twitch account found') : report.lookup === 'missing' ? t('Unavailable on Twitch') : t('Lookup needed')));
        badges.append(element('span', 'badge', countLabel(report.evidence.length, '{count} screenshot', '{count} screenshots')));
        if (report.warnings.length) badges.append(element('span', 'badge warn', countLabel(report.warnings.length, '{count} parsing hint', '{count} parsing hints')));
        open.append(badges);
        open.addEventListener('click', () => { activeId = report.id; renderQueue(); renderDetail(); updateControls(); });
        row.append(checkbox, open);
        $('queue').append(row);
    }
    if (focusedId) [...$('queue').querySelectorAll('input')].find(node => node.dataset.id === focusedId && !node.disabled)?.focus({ preventScroll: true });
}

function mutationButton(label, action, className = 'quiet') {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.mutation = 'true';
    button.addEventListener('click', action);
    return button;
}

function detailField(title, content) {
    const wrapper = element('div', 'detail-field');
    wrapper.append(element('div', 'field-title', title), content);
    return wrapper;
}

function renderDetail() {
    const report = state.reports.find((item) => item.id === activeId);
    $('detailEmpty').hidden = !!report;
    $('detail').hidden = !report;
    $('detail').replaceChildren();
    if (!report) return;
    const patch = (body) => perform(() => request(`/api/reports/${encodeURIComponent(report.id)}`, body, 'PATCH'));
    const loginRow = element('div', 'inline-field');
    const login = element('input');
    login.value = report.login;
    login.autocomplete = 'off';
    login.spellcheck = false;
    login.setAttribute('aria-label', t('Exact Twitch login'));
    loginRow.append(login, mutationButton(t('Save login'), () => patch({ login: login.value.trim() })));
    $('detail').append(detailField(t('Exact Twitch login'), loginRow));
    const lookup = element('div', 'lookup-card');
    if (report.resolved) {
        lookup.append(element('strong', '', `${report.resolved.displayName} (@${report.resolved.login})`));
        lookup.append(element('p', '', t('Twitch user ID: {id}', { id: report.resolved.id })));
        if (report.resolved.createdAt) lookup.append(element('p', '', t('Account created: {date}', { date: formatDate(report.resolved.createdAt) })));
    } else lookup.append(element('strong', '', report.lookup === 'missing' ? t('Unavailable on Twitch') : t('Exact account not checked yet')));
    if (report.lookup === 'missing') lookup.append(element('p', '', t('No account was returned for this exact login. Lookup cannot distinguish suspension, deletion, a rename, or a typo. Verify the name and evidence before deciding.')));
    if (/^[a-zA-Z0-9_]{1,25}$/.test(report.login)) {
        const twitchLink = element('a', 'button quiet', t('Open @{login} on Twitch', { login: report.login }));
        twitchLink.href = `https://www.twitch.tv/${encodeURIComponent(report.login)}`;
        twitchLink.target = '_blank';
        twitchLink.rel = 'noopener noreferrer';
        lookup.append(twitchLink);
    }
    lookup.append(mutationButton(t('Look up this login'), () => perform(() => request('/api/resolve', { ids: [report.id] }))));
    $('detail').append(lookup);
    $('detail').append(detailField(t('Reported reason'), element('p', '', report.reason || t('No reason parsed. Check the original text.'))));
    if (report.streamer) $('detail').append(detailField(t('Report context'), element('p', '', report.streamer)));
    for (const warning of report.warnings) $('detail').append(element('div', 'warning', translateError(warning)));
    if (!report.evidence.length) $('detail').append(element('div', 'warning', t('No screenshot attached. Attach proof and review it before approving.')));
    const sourceRow = element('div', 'inline-field');
    const source = element('input');
    source.type = 'url';
    source.value = report.sourceUrl || '';
    source.placeholder = t('https://… (optional source link)');
    source.setAttribute('aria-label', t('Original source message URL'));
    sourceRow.append(source, mutationButton(t('Save URL'), () => patch({ sourceUrl: source.value.trim() })));
    $('detail').append(detailField(t('Source message URL'), sourceRow));
    const evidence = element('div', 'evidence');
    for (const [index, path] of report.evidence.entries()) {
        if (typeof path !== 'string' || !/^\/evidence\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(path)) continue;
        const link = element('a');
        link.href = path;
        link.target = '_blank';
        link.rel = 'noopener';
        const image = element('img');
        image.src = path;
        image.alt = t('Attached evidence {index} for {login}', { index: index + 1, login: report.login });
        image.loading = 'lazy';
        link.append(image);
        evidence.append(link);
    }
    $('detail').append(detailField(t('Screenshot evidence'), evidence));
    const upload = element('div', 'upload');
    const file = element('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.multiple = true;
    file.id = 'evidenceUpload';
    file.hidden = true;
    const label = element('label', 'button quiet', t('Attach screenshots'));
    label.htmlFor = file.id;
    upload.append(label, file, element('p', '', t('PNG, JPEG or WebP · up to 8 MB each. You can also paste an image from the clipboard while this report is open.')));
    file.addEventListener('change', () => uploadFiles([...file.files], report.id));
    $('detail').append(upload);
    const raw = element('details');
    raw.append(element('summary', '', t('Original imported text')), element('pre', '', report.raw));
    $('detail').append(raw);
    const decisions = element('div', 'decision-actions');
    const select = mutationButton(t(selected.has(report.id) ? 'Deselect' : report.decision === 'approved' ? 'Select for ban' : 'Approve & select'), () => {
        if (selected.has(report.id)) {
            selected.delete(report.id); renderQueue(); renderDetail(); updateControls();
        } else if (canSelect(report)) {
            selected.add(report.id); renderQueue(); renderDetail(); updateControls();
        } else perform(async () => {
            await applyState(await request(`/api/reports/${encodeURIComponent(report.id)}`, { decision: 'approved' }, 'PATCH'));
            const current = state.reports.find(item => item.id === report.id);
            if (current && canSelect(current)) selected.add(report.id);
            renderQueue(); renderDetail(); updateControls();
        });
    }, '');
    select.dataset.blocked = String(report.sourceWithdrawn || report.lookup !== 'exists' || !report.resolved);
    decisions.append(select);
    decisions.append(mutationButton(t('Skip report'), () => patch({ decision: 'skipped' })));
    if (report.decision !== 'pending') decisions.append(mutationButton(t('Reset review'), () => patch({ decision: 'pending' })));
    $('detail').append(decisions);
    updateControls();
}

async function uploadFiles(files, reportId) {
    if (pending || state?.busy) return;
    await perform(async () => {
        let next;
        for (const file of files) {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('Use PNG, JPEG or WebP screenshots.'));
            if (file.size > 8 * 1024 * 1024) throw new Error(t('{name} exceeds 8 MB.', { name: file.name || t('Screenshot') }));
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(t('Could not read screenshot.')));
                reader.readAsDataURL(file);
            });
            next = await request(`/api/reports/${encodeURIComponent(reportId)}/evidence`, { dataUrl });
        }
        return next;
    }, t('Screenshot evidence attached.'));
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(uiLocale());
}

function renderHistory() {
    $('history').replaceChildren();
    if (!state.history.length) $('history').append(element('p', 'muted', t('No actions recorded yet.')));
    for (const entry of [...state.history].reverse()) {
        const row = element('div', 'history-row');
        const description = element('div');
        description.append(element('strong', '', `${entry.action === 'unban' ? t('Unban') : t('Permanent ban')} · ${entry.login} → ${entry.channelLogin}`));
        description.append(element('p', '', `${formatDate(entry.at)} · ${translateError(entry.message) || t(entry.status)}`));
        const meta = element('div', 'history-meta');
        meta.append(element('span', `badge${entry.status === 'success' ? ' good' : ['failed', 'uncertain'].includes(entry.status) ? ' warn' : ''}`, t(entry.status).replaceAll('_', ' ')));
        if (entry.action === 'ban' && entry.status === 'success') {
            meta.append(mutationButton(t('Unban…'), () => openUnban(entry)));
        }
        if (entry.status === 'uncertain') meta.append(mutationButton(t('Resolve uncertainty…'), () => openReconcile(entry)));
        row.append(description, meta);
        $('history').append(row);
    }
}

function resetDialog() {
    $('confirmForm').reset();
    $('planItems').replaceChildren();
    $('reviewed').closest('label').hidden = false;
    $('reviewed').required = true;
    $('reviewed').closest('label').lastChild.textContent = ' ' + t('I have reviewed the reasons and screenshots for every selected account.');
    $('confirmation').value = '';
    $('confirmAction').disabled = false;
    $('planExpiry').textContent = '';
}

function openReconcile(entry) {
    resetDialog();
    dialogAction = { type: 'reconcile', entry };
    $('confirmTitle').textContent = t('Verify {login} on Twitch', { login: entry.login });
    $('confirmDescription').textContent = t('First check the actual ban state in Twitch for {login} in {channel}. This records your verification and sends no moderation action.', { login: entry.login, channel: entry.channelLogin });
    const outcome = element('select');
    outcome.id = 'reconcileOutcome';
    outcome.setAttribute('aria-label', t('Verified ban state'));
    const prompt = element('option', '', t('Choose the state you checked on Twitch…'));
    prompt.value = '';
    outcome.append(prompt);
    const outcomes = entry.action === 'unban'
        ? [['success', t('Ban is gone / unban succeeded')], ['failed', t('Still banned / unban failed')]]
        : [['success', t('Ban exists / ban succeeded')], ['failed', t('No ban / ban failed')]];
    for (const [value, text] of outcomes) {
        const option = element('option', '', t(text));
        option.value = value;
        outcome.append(option);
    }
    outcome.required = true;
    $('planItems').append(outcome);
    $('reviewed').closest('label').lastChild.textContent = ' ' + t('I checked the current ban state directly on Twitch.');
    $('confirmationLabel').textContent = t('Type the channel login: {channel}', { channel: entry.channelLogin });
    $('confirmAction').textContent = t('Record verified state');
    $('confirmDialog').showModal();
}

function openUnban(entry) {
    resetDialog();
    dialogAction = { type: 'unban', entry };
    $('confirmTitle').textContent = t('Unban {login}', { login: entry.login });
    $('confirmDescription').textContent = t('Remove the ban for {login} in {channel}. This is a separate moderation action.', { login: entry.login, channel: entry.channelLogin });
    $('reviewed').closest('label').hidden = true;
    $('reviewed').required = false;
    $('confirmationLabel').textContent = t('Type the channel login: {channel}', { channel: entry.channelLogin });
    $('confirmAction').textContent = t('Confirm unban');
    $('confirmDialog').showModal();
}

function openReview() {
    resetDialog();
    const channel = channels.find((item) => item.id === $('channel').value);
    if (!channel || !selected.size) return;
    const reports = state.reports.filter((item) => selected.has(item.id));
    dialogAction = { type: 'ban', ids: reports.map((report) => report.id), channel, plan: null };
    $('confirmTitle').textContent = countLabel(reports.length, 'Review {count} permanent ban', 'Review {count} permanent bans');
    $('confirmDescription').textContent = t('Target channel: {channel}. Check every account below. Approval does not automatically select an account.', { channel: channel.login });
    for (const report of reports) {
        const item = element('div', 'plan-item', `${report.login} · Twitch ID ${report.resolved.id}`);
        item.append(element('p', '', report.reason || t('No parsed reason')), element('p', 'plan-evidence', countLabel(report.evidence.length, '{count} screenshot attached', '{count} screenshots attached')));
        $('planItems').append(item);
    }
    $('confirmationLabel').textContent = t('Type “{channel} {count}” to confirm channel and count', { channel: channel.login, count: reports.length });
    $('confirmAction').textContent = t('Prepare reviewed bans');
    $('confirmDialog').showModal();
}

$('confirmForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = dialogAction;
    if (!action || pending || state.busy) return;
    const expected = action.type === 'ban' ? `${action.channel.login} ${action.plan?.items.length ?? action.ids.length}` : action.entry.channelLogin;
    if ($('confirmation').value !== expected) {
        $('confirmation').setCustomValidity(t('Type exactly: {expected}', { expected }));
        $('confirmation').reportValidity();
        return;
    }
    $('confirmAction').disabled = true;
    await perform(async () => {
        if (action.type === 'unban') {
            const result = await request('/api/unban', { historyId: action.entry.id, confirmation: action.entry.channelLogin });
            $('confirmDialog').close();
            return result;
        }
        if (action.type === 'reconcile') {
            const result = await request('/api/reconcile', { historyId: action.entry.id, outcome: $('reconcileOutcome').value, reviewed: $('reviewed').checked });
            $('confirmDialog').close();
            return result;
        }
        if (!$('reviewed').checked) throw new Error(t('Review every reason and screenshot first.'));
        if (!action.plan) {
            action.plan = await request('/api/prepare', { ids: action.ids, channelId: action.channel.id, reviewed: true });
            if (action.plan.channelLogin !== action.channel.login) throw new Error(t('The target channel changed. Close this review and start again.'));
            $('planItems').replaceChildren();
            for (const item of action.plan.items) {
                const row = element('div', 'plan-item', `${item.login} · Twitch ID ${item.userId}`);
                row.append(element('p', '', item.reason));
                $('planItems').append(row);
            }
            for (const item of action.plan.skipped || []) $('planItems').append(element('div', 'warning', t('Skipped {login}: {reason}', { login: item.login, reason: translateError(item.reason) })));
            $('confirmTitle').textContent = countLabel(action.plan.items.length, 'Confirm {count} permanent ban', 'Confirm {count} permanent bans');
            $('confirmationLabel').textContent = t('Type “{channel} {count}” to confirm channel and count', { channel: action.channel.login, count: action.plan.items.length });
            $('confirmation').value = '';
            $('reviewed').checked = false;
            $('confirmAction').textContent = t('Confirm permanent bans');
            $('planExpiry').textContent = t('Prepared plan expires: {date}. Close and prepare again if it expires.', { date: formatDate(action.plan.expiresAt) });
            return;
        }
        if (new Date(action.plan.expiresAt).getTime() <= Date.now()) throw new Error(t('This plan expired. Close this review and prepare the accounts again.'));
        $('confirmDialog').close();
        notice(t('Permanent ban batch in progress. Results will appear in action history.'));
        const poll = setInterval(() => request('/api/state').then(applyState).catch(() => {}), 1500);
        try {
            const result = await request('/api/execute', { planId: action.plan.planId, confirmation: action.plan.channelLogin });
            selected.clear();
            return result;
        } finally { clearInterval(poll); }
    });
    $('confirmAction').disabled = false;
});

$('confirmation').addEventListener('input', () => $('confirmation').setCustomValidity(''));
$('cancelDialog').addEventListener('click', () => $('confirmDialog').close());
$('prepare').addEventListener('click', openReview);
$('filter').addEventListener('input', () => { if (state) { renderQueue(); updateControls(); } });
$('statusFilter').addEventListener('change', () => { if (state) { renderQueue(); updateControls(); } });
$('channel').addEventListener('change', updateControls);
$('import').addEventListener('click', () => {
    if (!$('importText').value.trim()) { notice(t('Paste report text or Twitch usernames first.'), true); return; }
    perform(() => request('/api/import', { text: $('importText').value }), t('Reports imported. Check the parsing hints and exact Twitch accounts.'));
});
$('importExport').addEventListener('click', () => perform(() => request('/api/import/export', {}), t('Export folder import complete. Review the coverage summary and any import issues.')));
$('textFile').addEventListener('change', async () => {
    const file = $('textFile').files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { notice(t('Text files must be smaller than 2 MB.'), true); return; }
    try { $('importText').value = await file.text(); notice(t('Text loaded. Choose Import reports to add it to the queue.')); }
    catch { notice(t('Could not read text file.'), true); }
    $('textFile').value = '';
});
$('demo').addEventListener('click', () => {
    $('importText').value = `Streamer: demonstration_channel\nUsername: synthetic_example_482\nReason: ${t('Synthetic demonstration report — replace with your own report.')}\n\nStreamer: demonstration_channel\nUsername: synthetic_example_739\nReason: ${t('Second synthetic report for testing the review workflow.')}`;
    notice(t('Synthetic example inserted. This is demonstration text, not a real moderation report.'));
});
$('resolve').addEventListener('click', () => perform(() => request('/api/resolve', {}), t('Exact Twitch user lookup complete. Review each account before approving.')));
$('connect').addEventListener('click', () => perform(async () => {
    const result = await request('/api/auth/start', {});
    if (result.mode === 'device') { startDeviceLogin(result.login); return; }
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.hostname !== 'id.twitch.tv') throw new Error(t('Unexpected Twitch authorization URL.'));
    window.location.assign(url.href);
}));
$('disconnect').addEventListener('click', () => perform(async () => {
    const result = await request('/api/auth/disconnect', {});
    stopDeviceLogin();
    return result;
}, t('Twitch disconnected.')));
$('refresh').addEventListener('click', async () => {
    try { await applyState(await request('/api/state')); notice(t('Workspace refreshed.')); }
    catch (error) { notice(translateError(error.message), true); }
});
document.addEventListener('ui-language-change', () => {
    $('notice').textContent = translateError($('notice').textContent);
    if (state) {
        const detailInputs = [...$('detail').querySelectorAll('input')].filter(node => node.type !== 'file').map(node => node.value);
        renderChannels(); renderQueue(); renderDetail(); renderHistory(); renderImportSummary(); updateControls();
        [...$('detail').querySelectorAll('input')].filter(node => node.type !== 'file').forEach((node, index) => { node.value = detailInputs[index] ?? node.value; });
        $('connection').textContent = state.auth ? t('Connected as {login}', { login: state.auth.login }) : t('Twitch disconnected');
    }
    if ($('confirmDialog').open) {
        for (const id of ['confirmTitle', 'confirmDescription', 'confirmationLabel', 'confirmAction', 'planExpiry']) $(id).textContent = translateError($(id).textContent);
        if (dialogAction.plan) $('planExpiry').textContent = t('Prepared plan expires: {date}. Close and prepare again if it expires.', { date: formatDate(dialogAction.plan.expiresAt) });
        $('reviewed').closest('label').lastChild.textContent = ' ' + t(dialogAction.type === 'reconcile' ? 'I checked the current ban state directly on Twitch.' : 'I have reviewed the reasons and screenshots for every selected account.');
        $('planItems').querySelectorAll('.plan-evidence, option').forEach(node => { node.textContent = translateError(node.textContent); });
        const outcome = $('reconcileOutcome');
        if (outcome) outcome.setAttribute('aria-label', t('Verified ban state'));
    }
});

document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length || !activeId || $('confirmDialog').open) return;
    event.preventDefault();
    uploadFiles(files, activeId);
});
updateControls();
request('/api/state').then(applyState).catch((error) => notice(t('Could not load workspace: {error}', { error: translateError(error.message) }), true));
setInterval(() => {
    if (state?.busy && !pending) request('/api/state').then(applyState).catch(() => {});
}, 3000);
