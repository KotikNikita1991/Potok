import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canon, clone, createDoc, createTask, merge, normalize, stamp } from '../js/core/doc.js';
import { sampleDoc } from '../js/core/sample.js';
import { GistSync } from '../js/sync/gist.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

// Минимальная копия Gist API: хранит файлы, считает ревизии, поддерживает ETag.
function fakeGitHub({ scopes = 'gist' } = {}) {
  const gists = new Map();
  let revision = 0;
  let nextId = 1;
  const calls = [];
  const respond = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetchImpl = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(`${method} ${path}`);
    if (headers.Authorization !== 'Bearer good-token') return respond(401, {});
    if (path === '/user') return respond(200, { login: 'someone' }, { 'X-OAuth-Scopes': scopes });
    if (path.startsWith('/gists?')) {
      return respond(200, [...gists.values()].map((g) => ({ id: g.id, files: g.files })));
    }
    if (path === '/gists' && method === 'POST') {
      const { files } = JSON.parse(body);
      const id = `g${nextId++}`;
      revision += 1;
      gists.set(id, { id, files, etag: `"r${revision}"` });
      return respond(201, gists.get(id), { ETag: `"r${revision}"` });
    }
    const id = path.split('/')[2];
    const gist = gists.get(id);
    if (!gist) return respond(404, {});
    if (method === 'GET') {
      if (headers['If-None-Match'] === gist.etag) return respond(304, null, { ETag: gist.etag });
      return respond(200, gist, { ETag: gist.etag });
    }
    if (method === 'PATCH') {
      const { files } = JSON.parse(body);
      gist.files = files;
      revision += 1;
      gist.etag = `"r${revision}"`;
      return respond(200, gist, { ETag: gist.etag });
    }
    return respond(405, {});
  };
  return { fetchImpl, gists, calls };
}

let sharedClock = Date.now();

function device(github, doc) {
  const state = { doc };
  const store = {
    getDoc: () => state.doc,
    applyRemote: (next) => {
      state.doc = next;
    },
  };
  const sync = new GistSync({ store, fetchImpl: github.fetchImpl, storage: memoryStorage() });
  const edit = (fn) => {
    const draft = clone(state.doc);
    fn(draft);
    normalize(draft);
    sharedClock += 1000;
    stamp(state.doc, draft, sharedClock);
    state.doc = draft;
    sync.noteLocalChange();
    clearTimeout(sync.timer);
  };
  return { state, store, sync, edit };
}

function addTask(doc, title, now = Date.now()) {
  const task = createTask({ title, status: 'queue', dur: 60 }, now);
  doc.tasks[task.id] = task;
  doc.plan.order.push(task.id);
  return task;
}

test('слияние: у каждой задачи побеждает более свежая версия', () => {
  const base = createDoc();
  const task = addTask(base, 'Исходная');
  base.tasks[task.id].u = 100;

  const phone = clone(base);
  phone.tasks[task.id].title = 'С телефона';
  phone.tasks[task.id].u = 200;

  const laptop = clone(base);
  const other = addTask(laptop, 'С ноутбука');
  laptop.tasks[other.id].u = 150;

  const merged = merge(laptop, phone);
  assert.equal(merged.tasks[task.id].title, 'С телефона');
  assert.equal(merged.tasks[other.id].title, 'С ноутбука');
  assert.equal(merged.plan.order.length, 2, 'задача с другого устройства не теряется, даже если порядок старее');
});

test('слияние: удаление не воскресает', () => {
  const base = createDoc();
  const task = addTask(base, 'Лишняя');
  base.tasks[task.id].u = 100;
  const deleted = clone(base);
  deleted.tasks[task.id].deleted = true;
  deleted.tasks[task.id].u = 300;
  deleted.plan.order = [];
  deleted.plan.u = 300;
  const merged = merge(base, deleted, 1000);
  assert.equal(merged.tasks[task.id].deleted, true);
  assert.deepEqual(merged.plan.order, []);
});

test('слияние: при одинаковом времени устройства приходят к одному результату', () => {
  const base = createDoc();
  const task = addTask(base, 'Исходная');
  base.tasks[task.id].u = 100;
  const a = clone(base);
  a.tasks[task.id].title = 'Вариант А';
  const b = clone(base);
  b.tasks[task.id].title = 'Вариант Б';
  assert.equal(canon(merge(a, b, 1000)), canon(merge(b, a, 1000)));
});

test('отмена отмечает восстановленные данные как свежие', () => {
  const before = createDoc();
  const after = clone(before);
  const task = addTask(after, 'Новая');
  stamp(before, after, 500);
  assert.equal(after.tasks[task.id].u, 500);

  const undone = clone(before);
  stamp(after, undone, 600);
  assert.equal(undone.tasks[task.id].deleted, true, 'отменённое добавление становится удалением');
  assert.equal(undone.tasks[task.id].u, 600);
  assert.equal(undone.plan.u, 600);
});

test('канонический вид не зависит от порядка ключей', () => {
  assert.equal(canon({ a: 1, b: { c: 2, d: 3 } }), canon({ b: { d: 3, c: 2 }, a: 1 }));
});

test('первое подключение создаёт секретный Gist с текущими данными', async () => {
  const github = fakeGitHub();
  const a = device(github, createDoc());
  a.edit((doc) => addTask(doc, 'Первая'));
  const result = await a.sync.connect('  good-token  ');
  assert.equal(result.login, 'someone');
  assert.equal(github.gists.size, 1);
  const stored = JSON.parse([...github.gists.values()][0].files['potok.json'].content);
  assert.equal(Object.values(stored.tasks)[0].title, 'Первая');
  assert.equal(a.sync.status.state, 'idle');
});

test('неверный токен даёт понятную ошибку и не сохраняется', async () => {
  const github = fakeGitHub();
  const a = device(github, createDoc());
  await assert.rejects(() => a.sync.connect('bad-token'), /не принял токен/);
  assert.equal(a.sync.connected, false);
  assert.match(a.sync.status.message, /токен/);
});

test('токен без разрешения gist отклоняется сразу', async () => {
  const github = fakeGitHub({ scopes: 'repo, read:org' });
  const a = device(github, createDoc());
  await assert.rejects(() => a.sync.connect('good-token'), /разрешения gist/);
  assert.equal(a.sync.connected, false);
});

test('второе устройство находит данные, а его примеры не смешиваются с настоящими', async () => {
  const github = fakeGitHub();
  const laptop = device(github, createDoc());
  laptop.edit((doc) => addTask(doc, 'Настоящая'));
  await laptop.sync.connect('good-token');

  const phone = device(github, sampleDoc(Date.now()));
  await phone.sync.connect('good-token');
  const titles = Object.values(phone.state.doc.tasks).map((t) => t.title);
  assert.deepEqual(titles, ['Настоящая']);
  assert.equal(phone.state.doc.meta.sample, false);
  assert.equal(github.gists.size, 1, 'второй Gist не создаётся');
});

test('изменения доходят с одного устройства на другое и обратно', async () => {
  const github = fakeGitHub();
  const laptop = device(github, createDoc());
  await laptop.sync.connect('good-token');
  const phone = device(github, createDoc());
  await phone.sync.connect('good-token');

  laptop.edit((doc) => addTask(doc, 'С ноутбука'));
  await laptop.sync.syncNow();
  await phone.sync.syncNow();
  assert.deepEqual(Object.values(phone.state.doc.tasks).map((t) => t.title), ['С ноутбука']);

  phone.edit((doc) => {
    Object.values(doc.tasks)[0].title = 'Поправлено на телефоне';
  });
  await phone.sync.syncNow();
  await laptop.sync.syncNow();
  assert.deepEqual(Object.values(laptop.state.doc.tasks).map((t) => t.title), ['Поправлено на телефоне']);
});

test('устройства не перезаписывают файл по кругу, если изменений нет', async () => {
  const github = fakeGitHub();
  const laptop = device(github, createDoc());
  await laptop.sync.connect('good-token');
  const phone = device(github, createDoc());
  await phone.sync.connect('good-token');
  laptop.edit((doc) => addTask(doc, 'Задача'));
  await laptop.sync.syncNow();

  for (let i = 0; i < 3; i += 1) {
    await phone.sync.syncNow();
    await laptop.sync.syncNow();
  }
  github.calls.length = 0;
  for (let i = 0; i < 3; i += 1) {
    await phone.sync.syncNow();
    await laptop.sync.syncNow();
  }
  assert.equal(github.calls.filter((c) => c.startsWith('PATCH')).length, 0, github.calls.join('\n'));
});

test('нет сети: данные остаются помечены как неотправленные и уходят позже', async () => {
  const github = fakeGitHub();
  let online = true;
  const flaky = async (...args) => {
    if (!online) throw new TypeError('Failed to fetch');
    return github.fetchImpl(...args);
  };
  const storage = memoryStorage();
  const state = { doc: createDoc() };
  const sync = new GistSync({
    store: { getDoc: () => state.doc, applyRemote: (d) => { state.doc = d; } },
    fetchImpl: flaky,
    storage,
  });
  await sync.connect('good-token');

  online = false;
  const draft = clone(state.doc);
  addTask(draft, 'Офлайн');
  stamp(state.doc, draft, Date.now());
  state.doc = draft;
  sync.noteLocalChange();
  clearTimeout(sync.timer);
  await sync.syncNow();
  assert.equal(sync.status.state, 'offline');
  assert.equal(sync.config.dirty, true);

  online = true;
  await sync.syncNow();
  assert.equal(sync.status.state, 'idle');
  assert.equal(sync.config.dirty, false);
  const stored = JSON.parse([...github.gists.values()][0].files['potok.json'].content);
  assert.equal(Object.values(stored.tasks)[0].title, 'Офлайн');
});

test('если Gist удалён, данные создаются заново', async () => {
  const github = fakeGitHub();
  const a = device(github, createDoc());
  a.edit((doc) => addTask(doc, 'Задача'));
  await a.sync.connect('good-token');
  github.gists.clear();
  await a.sync.syncNow();
  assert.equal(github.gists.size, 1);
  assert.equal(a.sync.status.state, 'idle');
});
