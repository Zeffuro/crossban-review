(() => {
    'use strict';
    const SCRIPT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    const INTEGRITY = 'sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM';
    const WORKER = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js';
    const CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0';
    const LANGUAGE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int';
    const MAX_PIXELS = 4_000_000;
    const MAX_EDGE = 4096;
    const MAX_TEXT = 100_000;
    const TIMEOUT = 90_000;
    const ignored = new Set(['automod', 'twitch', 'moderator', 'username', 'login', 'system', 'chat']);
    let active = null;
    let library = null;
    let loading = null;

    function error(code) { return Object.assign(new Error(code), { code }); }

    function extractCandidates(text) {
        const candidates = [];
        const seen = new Set();
        const add = (login, kind) => {
            if (!/^[A-Za-z0-9_]{1,25}$/.test(login) || ignored.has(login.toLowerCase())) return;
            const key = `${kind}:${login.toLowerCase()}`;
            if (!seen.has(key) && candidates.length < 100) {
                seen.add(key);
                candidates.push({ login, kind });
            }
        };
        const lines = String(text).slice(0, MAX_TEXT).split(/\r?\n/);
        const nonempty = lines.map(line => line.trim()).filter(Boolean);
        if (nonempty.length === 1) {
            const cropped = nonempty[0].match(/^([A-Za-z0-9_]{1,25})$/)
                || nonempty[0].match(/^(?:\|\s*)?([A-Za-z0-9_]{1,25}):$/);
            if (cropped) add(cropped[1], 'other');
        }
        for (const line of lines) {
            const sender = line.match(/^\s*\[?(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\]?\s+([^\s:]+):(?:\s|$)/);
            if (sender) add(sender[1], 'sender');
            const labelled = line.match(/^\s*(?:username|login)\s*:\s*([^\s]+)\s*$/i);
            if (labelled) add(labelled[1], 'other');
            // Consume the entire token before validation; a Unicode suffix must not become an ASCII guess.
            for (const mention of line.matchAll(/(?:^|[\s(])@([^\s,;:!?()[\]{}"'<>]+)/g)) {
                add(mention[1].replace(/\.$/, ''), 'mention');
            }
        }
        return candidates;
    }

    function loadLibrary() {
        if (library) return Promise.resolve(library);
        if (loading) return loading;
        loading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const timer = setTimeout(() => finish(error('OCR_UNAVAILABLE')), TIMEOUT);
            const finish = (failure) => {
                clearTimeout(timer);
                script.onload = script.onerror = null;
                if (failure) { script.remove(); reject(failure); }
                else { library = window.Tesseract; resolve(library); }
            };
            script.src = SCRIPT;
            script.integrity = INTEGRITY;
            script.crossOrigin = 'anonymous';
            script.referrerPolicy = 'no-referrer';
            script.onload = () => finish(typeof window.Tesseract?.createWorker === 'function' ? null : error('OCR_UNAVAILABLE'));
            script.onerror = () => finish(error('OCR_UNAVAILABLE'));
            document.head.append(script);
        }).finally(() => { loading = null; });
        return loading;
    }

    function release(job) {
        clearTimeout(job.timer);
        // Upstream exposes terminate only after initialization; keep the native handle for startup failures.
        for (const { worker, url } of job.nativeWorkers.splice(0)) {
            worker.terminate();
            if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
        }
        if (job.worker) {
            Promise.resolve(job.worker.terminate()).catch(() => {});
            job.worker = null;
        }
        if (job.canvas) { job.canvas.width = job.canvas.height = 0; job.canvas = null; }
        if (active === job) active = null;
    }

    function stop(job, code) {
        if (job.stopped) return;
        job.stopped = true;
        job.reject(error(code));
        release(job);
    }

    function cancel() { if (active) stop(active, 'OCR_CANCELLED'); }

    function boundedCanvas(input) {
        const isImage = typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement;
        const isCanvas = typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement;
        if (!isImage && !isCanvas) throw error('OCR_UNAVAILABLE');
        const width = isImage ? input.naturalWidth : input.width;
        const height = isImage ? input.naturalHeight : input.height;
        if (!width || !height || !Number.isFinite(width * height)) throw error('OCR_UNAVAILABLE');
        if (width * height > MAX_PIXELS || width > MAX_EDGE || height > MAX_EDGE) throw error('OCR_TOO_LARGE');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw error('OCR_UNAVAILABLE');
        context.drawImage(input, 0, 0);
        return canvas;
    }

    async function recognize(input, onProgress) {
        if (active) throw error('OCR_BUSY');
        let canvas;
        try { canvas = boundedCanvas(input); }
        catch (failure) { throw failure?.code ? failure : error('OCR_UNAVAILABLE'); }
        const job = { canvas, nativeWorkers: [], worker: null, stopped: false, reject: null, timer: null };
        const interrupted = new Promise((_, reject) => { job.reject = reject; });
        active = job;
        job.timer = setTimeout(() => stop(job, 'OCR_UNAVAILABLE'), TIMEOUT);
        const run = async () => {
            const engine = await loadLibrary();
            if (job.stopped) throw error('OCR_CANCELLED');
            const NativeWorker = window.Worker;
            let creation;
            try {
                // createWorker spawns synchronously before returning its initialization promise.
                window.Worker = new Proxy(NativeWorker, {
                    construct(target, args) {
                        const worker = Reflect.construct(target, args);
                        job.nativeWorkers.push({ worker, url: args[0] });
                        worker.addEventListener('error', () => stop(job, 'OCR_UNAVAILABLE'));
                        return worker;
                    },
                });
                creation = engine.createWorker('eng', 1, {
                    workerPath: WORKER, corePath: CORE, langPath: LANGUAGE, workerBlobURL: true,
                    cacheMethod: 'none',
                    errorHandler: () => stop(job, 'OCR_UNAVAILABLE'),
                    logger: (event) => {
                        if (!job.stopped && typeof onProgress === 'function') {
                            const progress = Math.max(0, Math.min(1, Number(event.progress) || 0));
                            try { onProgress({ status: event.status, progress }); } catch { /* UI progress is optional. */ }
                        }
                    },
                });
            } finally { window.Worker = NativeWorker; }
            const worker = await creation;
            if (job.stopped) { await worker.terminate(); throw error('OCR_CANCELLED'); }
            job.worker = worker;
            const result = await worker.recognize(job.canvas, {}, { text: true });
            if (job.stopped) throw error('OCR_CANCELLED');
            const text = String(result.data.text || '').slice(0, MAX_TEXT);
            return { text, candidates: extractCandidates(text) };
        };
        try { return await Promise.race([run(), interrupted]); }
        catch (failure) {
            if (failure?.code) throw failure;
            throw error('OCR_UNAVAILABLE');
        } finally { release(job); }
    }

    window.CrossbanOcr = Object.freeze({ recognize, cancel, extractCandidates });
})();
