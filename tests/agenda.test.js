import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {Agenda, availability, passwordHash} from '../worker.js';

const origin = 'https://barbearia.example';
const futureMonday = (() => {const d = new Date(); d.setUTCDate(d.getUTCDate() + 8); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);})();
const nextDay = (date, n) => {const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);};
const weekly = [null, ...Array.from({length: 6}, () => ({start: '08:00', end: '20:00'}))];
const schedule = () => ({version: 1, weekly: structuredClone(weekly), blocks: []});
class MemoryStorage {
  data = new Map();
  async get(key) {return structuredClone(this.data.get(key));}
  async put(key, value) {this.data.set(key, structuredClone(value));}
}
async function setup() {
  const password = 'Teste-seguro-para-agenda-2026';
  const env = {INITIAL_ADMIN_SALT: 'salt-for-tests', INITIAL_ADMIN_HASH: await passwordHash(password, 'salt-for-tests')};
  const storage = new MemoryStorage();
  const state = {storage, queue: Promise.resolve(), blockConcurrencyWhile(fn) {const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next;}};
  let agenda = new Agenda(state, env);
  const call = async (path, body, cookie, extra = {}) => {
    const request = new Request(origin + path, body === undefined ? {headers: cookie ? {Cookie: cookie} : {}} : {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...extra}, body: JSON.stringify(body)});
    const response = await agenda.fetch(request);
    return {status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie')};
  };
  const login = () => call('/api/admin/login', {password});
  const restart = () => {agenda = new Agenda(state, env);};
  return {call, login, password, restart};
}

test('segunda a sábado das 08 às 20; domingo fechado; último horário 19:30', () => {
  for (let i = 0; i < 6; i++) {
    const data = availability(schedule(), nextDay(futureMonday, i));
    assert.equal(data.slots.length, 24);
    assert.equal(data.slots[0], '08:00');
    assert.equal(data.slots.at(-1), '19:30');
    assert.ok(!data.slots.includes('20:00'));
  }
  assert.deepEqual(availability(schedule(), nextDay(futureMonday, 6)).slots, []);
});
test('horários passados usam o fuso de Brasília, não o UTC', () => {
  const now = new Date(`${futureMonday}T13:15:00Z`); // 10h15 em Brasília
  assert.equal(availability(schedule(), futureMonday, now).slots[0], '10:30');
});
test('bloqueio parcial remove todo atendimento que sobrepõe o compromisso', () => {
  const s = schedule(); s.blocks.push({date: futureMonday, allDay: false, start: '09:10', end: '10:10'});
  const {slots} = availability(s, futureMonday);
  assert.ok(slots.includes('08:30'));
  for (const time of ['09:00', '09:30', '10:00']) assert.ok(!slots.includes(time));
  assert.ok(slots.includes('10:30'));
});
test('API pública não revela notas internas e impede alterações sem sessão', async () => {
  const {call} = await setup();
  assert.equal((await call('/api/admin/state')).status, 401);
  assert.equal((await call('/api/admin/block', {date: futureMonday, allDay: true, version: 1})).status, 401);
  assert.equal((await call('/api/calendar')).status, 200);
  assert.equal((await call('/api/check', {date: futureMonday, time: '08:00'})).status, 200);
});
test('login, bloquear dia, persistir em outro aparelho, rejeitar pedido e desbloquear', async () => {
  const {call, login, restart} = await setup();
  assert.equal((await call('/api/admin/login', {password: 'errada'})).status, 401);
  const first = await login(), second = await login();
  assert.match(first.cookie, /HttpOnly; Secure; SameSite=Strict/);
  const c1 = first.cookie.split(';')[0], c2 = second.cookie.split(';')[0];
  const blocked = await call('/api/admin/block', {date: futureMonday, allDay: true, note: 'Compromisso privado', version: 1}, c1);
  assert.equal(blocked.status, 200);
  restart();
  const shared = await call('/api/admin/state', undefined, c2);
  assert.equal(shared.data.blocks[0].note, 'Compromisso privado');
  const publicData = await call(`/api/availability?date=${futureMonday}`);
  assert.deepEqual(publicData.data.slots, []);
  assert.ok(!JSON.stringify(publicData.data).includes('Compromisso privado'));
  assert.equal((await call('/api/check', {date: futureMonday, time: '08:00'})).status, 409);
  const restored = await call('/api/admin/unblock', {id: blocked.data.blocks[0].id, version: 2}, c2);
  assert.equal(restored.status, 200);
  assert.equal((await call(`/api/availability?date=${futureMonday}`)).data.slots.length, 24);
});
test('bloqueio por intervalo e edição semanal são compartilhados e validados', async () => {
  const {call, login} = await setup(); const cookie = (await login()).cookie.split(';')[0];
  const blocked = await call('/api/admin/block', {date: futureMonday, allDay: false, start: '14:00', end: '16:00', version: 1}, cookie);
  assert.equal(blocked.status, 200);
  const data = await call(`/api/availability?date=${futureMonday}`);
  assert.ok(data.data.slots.includes('13:30')); assert.ok(!data.data.slots.includes('15:30')); assert.ok(data.data.slots.includes('16:00'));
  const changed = structuredClone(weekly); changed[1] = {start: '10:00', end: '18:00'};
  assert.equal((await call('/api/admin/weekly', {weekly: changed, version: 2}, cookie)).status, 200);
  assert.equal((await call(`/api/availability?date=${futureMonday}`)).data.slots[0], '10:00');
  changed[1].end = '09:00';
  assert.equal((await call('/api/admin/weekly', {weekly: changed, version: 3}, cookie)).status, 400);
  assert.equal((await call('/api/admin/block', {date: '2027-02-30', allDay: true, version: 3}, cookie)).status, 400);
  assert.equal((await call('/api/admin/block', {date: futureMonday, allDay: false, start: '18:00', end: '09:00', version: 3}, cookie)).status, 400);
});
test('uma tela antiga não sobrescreve alterações do outro responsável', async () => {
  const {call, login} = await setup(); const cookie = (await login()).cookie.split(';')[0];
  const responses = await Promise.all([call('/api/admin/block', {date: futureMonday, allDay: true, version: 1}, cookie), call('/api/admin/block', {date: nextDay(futureMonday, 1), allDay: true, version: 1}, cookie)]);
  assert.deepEqual(responses.map(r => r.status), [200, 409]);
  assert.equal((await call('/api/admin/state', undefined, cookie)).data.blocks.length, 1);
});
test('troca de senha persiste e revoga sessões antigas e senha inicial', async () => {
  const {call, login, password, restart} = await setup(); const first = (await login()).cookie.split(';')[0], second = (await login()).cookie.split(';')[0];
  const changed = await call('/api/admin/password', {current: password, password: 'Outra-senha-longa-segura'}, first);
  assert.equal(changed.status, 200); restart();
  assert.equal((await call('/api/admin/state', undefined, first)).status, 401);
  assert.equal((await call('/api/admin/state', undefined, second)).status, 401);
  assert.equal((await login()).status, 401);
  assert.equal((await call('/api/admin/login', {password: 'Outra-senha-longa-segura'})).status, 200);
  assert.equal((await call('/api/admin/state', undefined, changed.cookie.split(';')[0])).data.mustChangePassword, false);
});
test('proteção de origem, limitação de tentativas e saída da sessão', async () => {
  const {call, login} = await setup();
  assert.equal((await call('/api/admin/login', {password: 'qualquer'}, undefined, {Origin: 'https://outro.example'})).status, 403);
  const cookie = (await login()).cookie.split(';')[0];
  assert.equal((await call('/api/admin/logout', {}, cookie)).status, 200);
  assert.equal((await call('/api/admin/state', undefined, cookie)).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/admin/login', {password: 'errada'})).status, 401);
  assert.equal((await login()).status, 429);
});
test('Worker encaminha a API para armazenamento e mantém as páginas estáticas', async () => {
  const paths = []; const env = {AGENDA: {idFromName: n => n, get: () => ({fetch: async req => {paths.push(new URL(req.url).pathname); return new Response('api');}})}, ASSETS: {fetch: async () => new Response('html')}};
  assert.equal(await (await worker.fetch(new Request(origin + '/api/calendar'), env)).text(), 'api');
  assert.equal(await (await worker.fetch(new Request(origin + '/'), env)).text(), 'html');
  assert.deepEqual(paths, ['/api/calendar']);
});
test('código do servidor e configuração não são publicados como arquivos estáticos', () => {
  const ignored = readFileSync(new URL('../.assetsignore', import.meta.url), 'utf8');
  for (const file of ['/worker.js', '/wrangler.jsonc', '/tests', '/.dev.vars']) assert.ok(ignored.includes(file));
  assert.ok(!readFileSync(new URL('../admin.js', import.meta.url), 'utf8').includes('INITIAL_ADMIN_HASH'));
});
