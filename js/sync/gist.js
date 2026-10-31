// Синхронизация между устройствами через секретный Gist на GitHub.
// Данные — один JSON-файл. Устройства сливают версии по времени изменения каждой сущности.

import { canon, isValidDoc, merge, withoutSamples } from '../core/doc.js';

const API = 'https://api.github.com';
const FILE = 'potok.json';
const CONFIG_KEY = 'potok.sync';
const PUSH_DELAY = 2500;
const POLL_EVERY = 60000;
const TIMEOUT = 20000;

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function explain(response) {
  if (response.status === 401) return new SyncError('auth', 'GitHub не принял токен. Создайте новый и подключитесь заново.');
  if (response.status === 403 || response.status === 429) return new SyncError('limit', 'GitHub временно ограничил запросы. Повторим позже, данные сохранены на устройстве.');
  return new SyncError('http', `GitHub ответил ошибкой ${response.status}. Повторим позже, данные сохранены на устройстве.`);
}

export class GistSync {
  // store: { getDoc(), applyRemote(doc) }
  constructor({ store, fetchImpl, storage, onStatus }) {
    this.store = store;
    this.fetch = fetchImpl;
    this.storage = storage;
    this.onStatus = onStatus ?? (() => {});
    this.config = this.readConfig();
    this.etag = null;
    this.running = false;
    this.again = false;
    this.changes = 0;
    this.timer = null;
    this.status = { state: this.connected ? 'idle' : 'off', message: '', lastSync: this.config?.lastSync ?? null };
  }

  get connected() {
    return Boolean(this.config?.token && this.config?.gistId);
  }

  readConfig() {
    try {
      return JSON.parse(this.storage.getItem(CONFIG_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  saveConfig() {
    try {
      if (this.config) this.storage.setItem(CONFIG_KEY, JSON.stringify(this.config));
      else this.storage.removeItem(CONFIG_KEY);
    } catch {
      // без постоянного хранилища синхронизация проработает до закрытия приложения
    }
  }

  setStatus(state, message = '') {
    const lastSync = state === 'idle' ? Date.now() : this.status.lastSync;
    this.status = { state, message, lastSync };
    if (this.config && state === 'idle') {
      this.config.lastSync = lastSync;
      this.saveConfig();
    }
    this.onStatus(this.status);
  }

  async request(method, path, { token = this.config?.token, body, etag } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      return await this.fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async readFile(gist) {
    const file = gist.files?.[FILE];
    if (!file) return null;
    let text = file.content;
    if (file.truncated) {
      const raw = await this.fetch(file.raw_url, { cache: 'no-store' });
      text = await raw.text();
    }
    try {
      const doc = JSON.parse(text);
      return isValidDoc(doc) ? doc : null;
    } catch {
      return null;
    }
  }

  async findGist(token) {
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.request('GET', `/gists?per_page=100&page=${page}`, { token });
      if (!response.ok) throw explain(response);
      const gists = await response.json();
      const found = gists.find((gist) => gist.files?.[FILE]);
      if (found) return found.id;
      if (gists.length < 100) return null;
    }
    return null;
  }

  async createGist(token, doc) {
    const response = await this.request('POST', '/gists', {
      token,
      body: {
        description: 'Поток: данные планировщика',
        public: false,
        files: { [FILE]: { content: canon(doc) } },
      },
    });
    if (!response.ok) throw explain(response);
    const gist = await response.json();
    return gist.id;
  }

  // Первое подключение устройства: находит данные или создаёт для них новый Gist.
  async connect(rawToken) {
    const token = rawToken.trim();
    this.setStatus('busy');
    try {
      const me = await this.request('GET', '/user', { token });
      if (!me.ok) throw explain(me);
      const { login } = await me.json();
      const scopes = me.headers.get('X-OAuth-Scopes');
      if (scopes != null && scopes !== '' && !scopes.split(',').map((s) => s.trim()).includes('gist')) {
        throw new SyncError('auth', 'У токена нет разрешения gist. Создайте токен по ссылке выше, там оно уже выбрано.');
      }

      let local = this.store.getDoc();
      let gistId = await this.findGist(token);
      if (gistId) {
        const response = await this.request('GET', `/gists/${gistId}`, { token });
        if (!response.ok) throw explain(response);
        const remote = await this.readFile(await response.json());
        if (remote) {
          if (local.meta?.sample) {
            local = withoutSamples(local);
            local.meta.sample = Boolean(remote.meta?.sample);
          }
          this.store.applyRemote(merge(local, remote));
        }
      } else {
        gistId = await this.createGist(token, local);
      }

      this.config = { token, gistId, login, dirty: false, lastSync: null };
      this.saveConfig();
      this.etag = null;
      await this.syncNow();
      return { login, gistId };
    } catch (error) {
      this.setStatus('off', this.describe(error));
      throw error;
    }
  }

  disconnect() {
    clearTimeout(this.timer);
    this.config = null;
    this.etag = null;
    this.saveConfig();
    this.setStatus('off');
  }

  // Вызывается после каждого изменения на этом устройстве.
  noteLocalChange() {
    if (!this.connected) return;
    this.changes += 1;
    this.config.dirty = true;
    this.saveConfig();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), PUSH_DELAY);
  }

  describe(error) {
    if (error instanceof SyncError) return error.message;
    return 'Нет связи с GitHub. Данные сохранены на устройстве и уйдут, когда появится сеть.';
  }

  async syncNow() {
    if (!this.connected) return;
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.running = true;
    const changesAtStart = this.changes;
    this.setStatus('busy');
    try {
      let needPush = this.config.dirty;
      const response = await this.request('GET', `/gists/${this.config.gistId}`, { etag: this.etag });
      if (response.status === 404) {
        this.config.gistId = await this.createGist(this.config.token, this.store.getDoc());
        this.etag = null;
        needPush = false;
      } else if (response.status === 200) {
        this.etag = response.headers.get('ETag');
        const remote = await this.readFile(await response.json());
        const local = this.store.getDoc();
        const merged = remote ? merge(local, remote) : local;
        if (canon(merged) !== canon(local)) this.store.applyRemote(merged);
        needPush = !remote || canon(merged) !== canon(remote);
      } else if (response.status !== 304) {
        throw explain(response);
      }

      if (needPush) {
        const patched = await this.request('PATCH', `/gists/${this.config.gistId}`, {
          body: { files: { [FILE]: { content: canon(this.store.getDoc()) } } },
        });
        if (!patched.ok) throw explain(patched);
        this.etag = patched.headers.get('ETag');
      }

      if (this.changes === changesAtStart) this.config.dirty = false;
      else this.again = true;
      this.saveConfig();
      this.setStatus('idle');
    } catch (error) {
      const code = error instanceof SyncError ? 'error' : 'offline';
      this.setStatus(code, this.describe(error));
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.syncNow();
      }
    }
  }

  // Периодическая проверка и реакция на возвращение в приложение.
  start(win) {
    const onVisible = () => {
      if (win.document.visibilityState === 'visible') this.syncNow();
      else if (this.config?.dirty) this.syncNow();
    };
    win.document.addEventListener('visibilitychange', onVisible);
    win.addEventListener('online', () => this.syncNow());
    win.setInterval(() => {
      if (win.document.visibilityState === 'visible') this.syncNow();
    }, POLL_EVERY);
    this.syncNow();
  }
}

export { FILE as GIST_FILE, SyncError };
