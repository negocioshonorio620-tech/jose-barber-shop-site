const ZONE = 'America/Sao_Paulo';
const STEP = 30;
const COOKIE = '__Host-jbs_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const enc = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async text => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const defaults = () => ({version: 1, weekly: [null, ...Array.from({length: 6}, () => ({start: '08:00', end: '20:00'}))], blocks: []});
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra}});
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function clock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(now).map(x => [x.type, x.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`};
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function minutes(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN; }
const timeText = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
function withinRange(date, now = new Date()) {
  return validDate(date) && date >= clock(now).date && new Date(`${date}T00:00:00Z`) - new Date(`${clock(now).date}T00:00:00Z`) <= 366 * 86400000;
}
export function availability(schedule, date, now = new Date()) {
  if (!withinRange(date, now)) fail('Escolha uma data de hoje até os próximos 12 meses.');
  const day = schedule.weekly[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const blocks = schedule.blocks.filter(b => b.date === date);
  const current = clock(now);
  const slots = [];
  if (day && !blocks.some(b => b.allDay)) {
    for (let start = minutes(day.start); start + STEP <= minutes(day.end); start += STEP) {
      if (date === current.date && timeText(start) <= current.time) continue;
      if (blocks.some(b => start < minutes(b.end) && start + STEP > minutes(b.start))) continue;
      slots.push(timeText(start));
    }
  }
  return {date, slots, step: STEP, timezone: ZONE, version: schedule.version, message: !day ? 'Fechado neste dia da semana.' : blocks.some(b => b.allDay) ? 'Sem atendimento nesta data.' : !slots.length ? 'Nenhum horário disponível nesta data.' : ''};
}
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000}, key, 256));
}
function equal(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i); return mismatch === 0; }
const sessionCookie = (token, age = SESSION_MS / 1000) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;

export class Agenda {
  constructor(state, env) { this.state = state; this.env = env; }
  fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      try { return await this.handle(request); }
      catch (error) { return json({error: error.status ? error.message : 'Não foi possível concluir. Tente novamente.'}, error.status || 500); }
    });
  }
  async load() {
    this.schedule ??= await this.state.storage.get('schedule') || defaults();
    this.auth ??= await this.state.storage.get('auth') || {salt: this.env.INITIAL_ADMIN_SALT, hash: this.env.INITIAL_ADMIN_HASH, changed: false};
    this.sessions ??= await this.state.storage.get('sessions') || [];
    this.attempts ??= await this.state.storage.get('attempts') || {};
  }
  async authenticated(request) {
    const cookie = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
    const token = cookie?.slice(COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const hash = await digest(token);
    return this.sessions.some(s => s.expires > Date.now() && equal(s.hash, hash));
  }
  async saveSchedule(next, expected) {
    if (expected !== this.schedule.version) fail('A agenda mudou em outro aparelho. Atualize a tela e tente novamente.', 409);
    next.version = this.schedule.version + 1;
    await this.state.storage.put('schedule', next);
    this.schedule = next;
    return json(next);
  }
  async addSession() {
    const token = random();
    this.sessions = this.sessions.filter(s => s.expires > Date.now()).slice(-19);
    this.sessions.push({hash: await digest(token), expires: Date.now() + SESSION_MS});
    await this.state.storage.put('sessions', this.sessions);
    return token;
  }
  async handle(request) {
    await this.load();
    const url = new URL(request.url), path = url.pathname;
    let body = {};
    if (request.method !== 'GET') {
      if (request.method !== 'POST') fail('Método não permitido.', 405);
      if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) fail('Origem da solicitação não permitida.', 403);
      const raw = await request.text();
      if (raw.length > 12000) fail('Solicitação muito grande.', 413);
      try { body = JSON.parse(raw); } catch { fail('Dados inválidos.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Dados inválidos.');
    }
    if (path === '/api/calendar' && request.method === 'GET') return json({weekly: this.schedule.weekly, step: STEP, timezone: ZONE, today: clock().date});
    if (path === '/api/availability' && request.method === 'GET') return json(availability(this.schedule, url.searchParams.get('date')));
    if (path === '/api/check' && request.method === 'POST') {
      if (!availability(this.schedule, body.date).slots.includes(body.time)) fail('Este horário não está mais disponível. Escolha outro horário.', 409);
      return json({available: true});
    }
    if (path === '/api/admin/login' && request.method === 'POST') {
      if (!this.auth.salt || !this.auth.hash) fail('Acesso à gestão ainda não configurado.', 503);
      const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
      const now = Date.now();
      this.attempts = Object.fromEntries(Object.entries(this.attempts).filter(([, v]) => v.until > now).slice(-255));
      const attempt = this.attempts[ip] || {count: 0, until: now + 15 * 60 * 1000};
      if (attempt.count >= 10) fail('Muitas tentativas. Aguarde 15 minutos para tentar novamente.', 429);
      if (typeof body.password !== 'string' || body.password.length > 128 || !equal(await passwordHash(body.password, this.auth.salt), this.auth.hash)) {
        attempt.count++; this.attempts[ip] = attempt;
        await this.state.storage.put('attempts', this.attempts);
        fail('Senha incorreta.', 401);
      }
      delete this.attempts[ip]; await this.state.storage.put('attempts', this.attempts);
      const token = await this.addSession();
      return json({ok: true, mustChangePassword: !this.auth.changed}, 200, {'Set-Cookie': sessionCookie(token)});
    }
    if (!path.startsWith('/api/admin/')) fail('Página não encontrada.', 404);
    if (!await this.authenticated(request)) fail('Entre com a senha de gestão para continuar.', 401);
    if (path === '/api/admin/state' && request.method === 'GET') return json({...this.schedule, mustChangePassword: !this.auth.changed});
    if (path === '/api/admin/logout' && request.method === 'POST') {
      const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const hash = await digest(token || '');
      this.sessions = this.sessions.filter(s => !equal(s.hash, hash) && s.expires > Date.now());
      await this.state.storage.put('sessions', this.sessions);
      return json({ok: true}, 200, {'Set-Cookie': sessionCookie('', 0)});
    }
    if (path === '/api/admin/password' && request.method === 'POST') {
      if (typeof body.current !== 'string' || body.current.length > 128 || !equal(await passwordHash(body.current, this.auth.salt), this.auth.hash)) fail('A senha atual está incorreta.', 403);
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail('Use uma nova senha de 12 a 128 caracteres.');
      if (body.password === body.current) fail('Escolha uma senha diferente da atual.');
      const salt = random();
      this.auth = {salt, hash: await passwordHash(body.password, salt), changed: true};
      await this.state.storage.put('auth', this.auth);
      this.sessions = [];
      const token = await this.addSession();
      return json({ok: true}, 200, {'Set-Cookie': sessionCookie(token)});
    }
    if (path === '/api/admin/weekly' && request.method === 'POST') {
      if (!Array.isArray(body.weekly) || body.weekly.length !== 7) fail('Informe os sete dias da semana.');
      const weekly = body.weekly.map(day => {
        if (day === null) return null;
        if (!day || typeof day !== 'object' || !Number.isFinite(minutes(day.start)) || !Number.isFinite(minutes(day.end)) || minutes(day.start) % STEP || minutes(day.end) % STEP || minutes(day.start) + STEP > minutes(day.end)) fail('Confira a abertura e o fechamento. Use intervalos de 30 minutos.');
        return {start: day.start, end: day.end};
      });
      return this.saveSchedule({...this.schedule, weekly}, body.version);
    }
    if (path === '/api/admin/block' && request.method === 'POST') {
      if (!withinRange(body.date)) fail('Escolha uma data de hoje até os próximos 12 meses.');
      if (typeof body.allDay !== 'boolean') fail('Escolha dia inteiro ou intervalo de horários.');
      if (!body.allDay && (!Number.isFinite(minutes(body.start)) || !Number.isFinite(minutes(body.end)) || minutes(body.start) >= minutes(body.end))) fail('O horário final deve ser depois do inicial.');
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 160)) fail('A observação deve ter até 160 caracteres.');
      const blocks = this.schedule.blocks.filter(b => b.date >= clock().date);
      if (blocks.length >= 1000) fail('Remova bloqueios antigos antes de adicionar novos.');
      blocks.push({id: crypto.randomUUID(), date: body.date, allDay: body.allDay, ...(body.allDay ? {} : {start: body.start, end: body.end}), note: (body.note || '').trim()});
      return this.saveSchedule({...this.schedule, blocks}, body.version);
    }
    if (path === '/api/admin/unblock' && request.method === 'POST') {
      if (typeof body.id !== 'string' || !this.schedule.blocks.some(b => b.id === body.id)) fail('Este bloqueio não existe mais. Atualize a agenda.', 409);
      return this.saveSchedule({...this.schedule, blocks: this.schedule.blocks.filter(b => b.id !== body.id)}, body.version);
    }
    fail('Página não encontrada.', 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!env.AGENDA) return json({error: 'Agenda temporariamente indisponível.'}, 503);
      return env.AGENDA.get(env.AGENDA.idFromName('jose-barber-shop')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
