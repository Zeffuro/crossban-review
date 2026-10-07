'use strict';

function updateBrowserLink() {
    document.getElementById('browserLink').href = `./app/?lang=${document.documentElement.lang}`;
}
document.addEventListener('DOMContentLoaded', updateBrowserLink);
document.addEventListener('ui-language-change', updateBrowserLink);
