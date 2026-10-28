const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');

function createEvent() {
  const listeners = new Set();
  return {
    addListener(fn) {
      if (typeof fn === 'function') listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    hasListener(fn) {
      return listeners.has(fn);
    },
    hasListeners() {
      return listeners.size > 0;
    },
    _emit(...args) {
      for (const fn of [...listeners]) {
        try { fn(...args); } catch (error) { console.error('[Yoko downloads.onChanged]', error); }
      }
    }
  };
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function installChromeDownloadsCompat() {
  try {
    const chromeObject = (window.chrome = window.chrome || {});
    const existing = chromeObject.downloads && typeof chromeObject.downloads === 'object'
      ? chromeObject.downloads
      : {};

    // Electron does not officially implement chrome.downloads for loaded
    // extensions. Keep any native pieces that happen to exist, but replace the
    // core API when it is missing so LINE 3.7.2 can finish media/file saves.
    const downloads = existing;
    const onChanged = downloads.onChanged && typeof downloads.onChanged.addListener === 'function'
      ? downloads.onChanged
      : createEvent();
    downloads.onChanged = onChanged;

    const jobs = new Map();
    let nextId = 700000;

    const emitChanged = delta => {
      try {
        if (typeof onChanged._emit === 'function') onChanged._emit(delta);
      } catch {}
    };

    const finishInterrupted = (id, reason, filename = '') => {
      const job = jobs.get(id);
      if (job) {
        job.state = 'interrupted';
        job.error = String(reason || 'USER_CANCELED');
      }
      emitChanged({
        id,
        state: { current: 'interrupted' },
        error: { current: String(reason || 'USER_CANCELED') },
        ...(filename ? { filename: { current: filename } } : {})
      });
    };

    const performDownload = async (id, options) => {
      const url = String(options?.url || '').trim();
      const suggestedName = String(options?.filename || '').trim() || `LINE_${Date.now()}`;
      const saveAs = Boolean(options?.saveAs);
      const job = jobs.get(id);
      if (!job) return;

      let chosenPath = '';
      try {
        const result = await ipcRenderer.invoke('line-download-choose-path', {
          filename: suggestedName,
          saveAs
        });
        chosenPath = String(result?.path || '');
        if (!result?.ok || !chosenPath) {
          finishInterrupted(id, result?.canceled ? 'USER_CANCELED' : (result?.error || 'FILE_FAILED'));
          return;
        }
        job.path = chosenPath;
        emitChanged({ id, filename: { current: chosenPath }, state: { current: 'in_progress' } });

        const response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          signal: job.controller.signal
        });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);

        const contentLength = safeNumber(response.headers.get('content-length'));
        let received = 0;
        const stream = fs.createWriteStream(chosenPath, { flags: 'w' });
        job.stream = stream;

        const waitDrain = () => new Promise((resolve, reject) => {
          const onDrain = () => { cleanup(); resolve(); };
          const onError = error => { cleanup(); reject(error); };
          const cleanup = () => {
            stream.off('drain', onDrain);
            stream.off('error', onError);
          };
          stream.once('drain', onDrain);
          stream.once('error', onError);
        });

        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader();
          job.reader = reader;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (job.controller.signal.aborted) throw new Error('USER_CANCELED');
            const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            if (!stream.write(buffer)) await waitDrain();
            received += buffer.length;
            emitChanged({
              id,
              bytesReceived: { current: received, previous: Math.max(0, received - buffer.length) },
              ...(contentLength ? { totalBytes: { current: contentLength } } : {})
            });
          }
        } else {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          received = buffer.length;
          stream.write(buffer);
        }

        await new Promise((resolve, reject) => {
          stream.once('error', reject);
          stream.end(resolve);
        });

        job.state = 'complete';
        job.received = received;
        emitChanged({
          id,
          state: { current: 'complete' },
          filename: { current: chosenPath },
          bytesReceived: { current: received },
          totalBytes: { current: contentLength || received },
          endTime: { current: new Date().toISOString() }
        });
      } catch (error) {
        try { job.stream?.destroy(); } catch {}
        if (chosenPath) {
          try { fs.unlinkSync(chosenPath); } catch {}
        }
        finishInterrupted(
          id,
          job.controller.signal.aborted ? 'USER_CANCELED' : String(error?.message || error || 'NETWORK_FAILED'),
          chosenPath
        );
      }
    };

    // Always provide our own download implementation. Electron's extension API
    // documentation does not list chrome.downloads as supported, and a partial
    // namespace can otherwise leave LINE stuck at 100% without writing a file.
    downloads.download = (options = {}, callback) => {
      const id = nextId++;
      jobs.set(id, {
        id,
        state: 'in_progress',
        path: '',
        error: '',
        controller: new AbortController(),
        stream: null,
        reader: null
      });

      // Resolve the id first, matching Chrome. LINE attaches its onChanged
      // listener immediately after await downloads.download(...), so starting
      // asynchronously prevents a fast cancellation/completion event being lost.
      setTimeout(() => performDownload(id, options), 0);
      if (typeof callback === 'function') queueMicrotask(() => callback(id));
      return Promise.resolve(id);
    };

    downloads.cancel = (id, callback) => {
      const job = jobs.get(Number(id));
      if (job && job.state === 'in_progress') {
        try { job.controller.abort(); } catch {}
        try { job.reader?.cancel(); } catch {}
        try { job.stream?.destroy(); } catch {}
      }
      if (typeof callback === 'function') queueMicrotask(callback);
      return Promise.resolve();
    };

    downloads.open = (id, callback) => {
      const job = jobs.get(Number(id));
      const p = String(job?.path || '');
      const promise = p
        ? ipcRenderer.invoke('line-download-open-path', p).catch(() => undefined)
        : Promise.resolve();
      if (typeof callback === 'function') promise.finally(() => callback());
      return promise;
    };

    downloads.show = downloads.open;
    downloads.showDefaultFolder = () => ipcRenderer.invoke('line-download-open-folder').catch(() => undefined);

    downloads.search = (query = {}, callback) => {
      const items = [...jobs.values()]
        .filter(job => query?.id == null || Number(query.id) === job.id)
        .map(job => ({
          id: job.id,
          filename: job.path || '',
          state: job.state || 'in_progress',
          error: job.error || undefined,
          bytesReceived: safeNumber(job.received),
          totalBytes: 0,
          exists: Boolean(job.path && fs.existsSync(job.path))
        }));
      if (typeof callback === 'function') queueMicrotask(() => callback(items));
      return Promise.resolve(items);
    };

    try {
      Object.defineProperty(chromeObject, 'downloads', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: downloads
      });
    } catch {
      try { chromeObject.downloads = downloads; } catch {}
    }
  } catch (error) {
    console.error('[Yoko chrome.downloads compat failed]', error);
  }
}

module.exports = { installChromeDownloadsCompat };
