'use strict';

let deviceLogin = null;
let deviceTimer = null;

function stopDeviceLogin() {
    clearTimeout(deviceTimer);
    deviceTimer = null;
    deviceLogin = null;
    $('deviceLogin').hidden = true;
}

function renderDeviceLogin() {
    if (!deviceLogin) return;
    $('deviceLogin').hidden = false;
    $('deviceUserCode').textContent = deviceLogin.userCode;
    $('deviceLink').href = deviceLogin.url;
    $('deviceExpiry').textContent = t('Login code expires: {date}. Waiting for Twitch authorization…', {
        date: new Date(deviceLogin.expiresAt).toLocaleString(uiLocale()),
    });
}

function startDeviceLogin(login) {
    stopDeviceLogin();
    const url = new URL(login.url);
    if (url.protocol !== 'https:' || !['www.twitch.tv', 'twitch.tv'].includes(url.hostname) || url.pathname !== '/activate' || url.username || url.password || url.port) {
        throw new Error(t('Unexpected Twitch authorization URL.'));
    }
    deviceLogin = { ...login, url: url.href };
    renderDeviceLogin();
    scheduleDevicePoll();
}

function scheduleDevicePoll() {
    if (deviceLogin) deviceTimer = setTimeout(pollDeviceLogin, Math.max(5, deviceLogin.interval) * 1000);
}

async function pollDeviceLogin() {
    const login = deviceLogin;
    if (!login) return;
    if (Date.now() >= login.expiresAt) { stopDeviceLogin(); notice(t('Twitch login expired or was replaced. Start again.'), true); return; }
    if (pending || state?.busy || loadingChannels) { scheduleDevicePoll(); return; }
    try {
        const result = await request('/api/auth/poll', { loginId: login.id });
        if (deviceLogin !== login) return;
        if (result.pending) { scheduleDevicePoll(); return; }
        stopDeviceLogin();
        await applyState(result);
        notice(t('Twitch connected.'));
    } catch (error) {
        if (deviceLogin !== login) return;
        if (error.status === 409) { scheduleDevicePoll(); return; }
        stopDeviceLogin();
        notice(translateError(error.message), true);
    }
}

$('cancelLogin').addEventListener('click', () => perform(async () => {
    const result = await request('/api/auth/cancel', {});
    stopDeviceLogin();
    return result;
}, t('Login cancelled.')));
document.addEventListener('ui-language-change', renderDeviceLogin);
