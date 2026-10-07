'use strict';
let backupFileUrl = null;

function renderBrowserMode(next) {
    const browser = next.environment === 'browser';
    $('browserStorage').hidden = !browser;
    if (!browser) return;
    const eyebrow = document.querySelector('.eyebrow');
    eyebrow.dataset.i18n = 'BROWSER MODERATION WORKSPACE';
    eyebrow.textContent = t(eyebrow.dataset.i18n);
    const help = $('exportHelp');
    help.removeAttribute('data-i18n-html');
    help.dataset.i18n = 'Export the Discord channel as JSON with Download assets enabled. Choose the entire export folder, including screenshots. Repeated imports avoid duplicates.';
    help.textContent = t(help.dataset.i18n);
    $('workspaceMode').textContent = next.readOnly
        ? translateError(next.error || 'This workspace is open in another tab. Close that tab and reload here to make changes.')
        : t('One active tab · Login lasts until this page closes');
    $('backupDownload').disabled = pending || next.busy;
    $('backupRestore').disabled = pending || next.busy || next.readOnly;
}

$('exportFolder').addEventListener('change', () => {
    const files = [...$('exportFolder').files];
    $('exportFolder').value = '';
    if (files.length) perform(() => request('/api/import/export', { files }), t('Export folder import complete. Review the coverage summary and any import issues.'));
});

$('backupDownload').addEventListener('click', () => perform(async () => {
    const backup = await request('/api/backup');
    if (backupFileUrl) URL.revokeObjectURL(backupFileUrl);
    backupFileUrl = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = $('backupSave');
    link.href = backupFileUrl;
    link.download = `crossban-review-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.hidden = false;
    link.click();
}, t('Backup ready. If the download did not start, choose Save backup file. Store it privately; it contains reports and screenshots.')));

$('backupRestore').addEventListener('click', () => $('backupFile').click());
$('backupFile').addEventListener('change', () => {
    const file = $('backupFile').files[0];
    $('backupFile').value = '';
    if (!file) return;
    if (file.size > 216 * 1024 * 1024) { notice(t('Backup exceeds 216 MB.'), true); return; }
    if (!confirm(t('Restore this backup? It replaces reports and screenshots; existing action history is kept. Restored reports need a new lookup and review. Download your current backup first.'))) return;
    perform(async () => {
        let backup;
        try { backup = JSON.parse(await file.text()); }
        catch { throw new Error(t('Cannot read this backup JSON.')); }
        const result = await request('/api/backup/import', { backup });
        selected.clear();
        return result;
    }, t('Backup restored. Look up and review the accounts again before approving.'));
});

if (state) renderBrowserMode(state);
