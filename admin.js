const $ = id => document.getElementById(id);
const days = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
let state;
let saving = false;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); if (text) $('message').scrollIntoView({behavior: 'smooth', block: 'nearest'}); }
function showLogin() { $('dashboard').hidden = true; $('loginSection').hidden = false; state = undefined; }
async function api(path, body) {
  const response = await fetch(`/api/admin/${path}`, {credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== 'login') showLogin(); const error = new Error(data.error || 'Não foi possível salvar.'); error.status = response.status; throw error; }
  return data;
}
function localToday() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function renderBlocks() {
  const list = $('blocksList'); list.replaceChildren();
  const blocks = state.blocks.filter(b => b.date >= localToday()).sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
  if (!blocks.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Nenhum bloqueio futuro. O atendimento segue o horário semanal.'; list.append(p); return; }
  for (const block of blocks) {
    const item = document.createElement('article'); item.className = 'blocked-item';
    const date = document.createElement('strong'); date.textContent = new Date(`${block.date}T12:00:00`).toLocaleDateString('pt-BR', {weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'});
    const period = document.createElement('span'); period.textContent = block.allDay ? 'Dia inteiro bloqueado' : `${block.start}–${block.end} bloqueado`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remover bloqueio'; remove.setAttribute('aria-label', `Remover bloqueio de ${date.textContent}, ${period.textContent}`);
    remove.addEventListener('click', () => save(remove, async () => { state = await api('unblock', {id: block.id, version: state.version}); renderBlocks(); message('Bloqueio removido. Os horários voltam a seguir a agenda.'); }));
    item.append(date, period);
    if (block.note) { const note = document.createElement('p'); note.textContent = block.note; item.append(note); }
    item.append(remove); list.append(item);
  }
}
function renderWeekly() {
  const rows = $('weeklyRows'); rows.replaceChildren();
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const row = document.createElement('div'); row.className = 'weekly-row';
    const label = document.createElement('label'); label.className = 'day-toggle';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.id = `open${day}`; toggle.checked = Boolean(state.weekly[day]);
    label.append(toggle, document.createTextNode(days[day])); row.append(label);
    for (const [field, title, fallback] of [['start', 'Abertura', '08:00'], ['end', 'Fechamento', '20:00']]) {
      const wrap = document.createElement('div'), timeLabel = document.createElement('label'), time = document.createElement('input');
      timeLabel.textContent = title; timeLabel.className = 'time-label'; timeLabel.htmlFor = `${field}${day}`;
      time.id = `${field}${day}`; time.type = 'time'; time.step = '1800'; time.required = true; time.value = state.weekly[day]?.[field] || fallback; time.disabled = !toggle.checked; time.setAttribute('aria-label', `${title} de ${days[day]}`);
      toggle.addEventListener('change', () => { time.disabled = !toggle.checked; });
      wrap.append(timeLabel, time); row.append(wrap);
    }
    rows.append(row);
  }
}
async function load() {
  const next = await api('state'); state = next;
  $('loginSection').hidden = true; $('dashboard').hidden = false;
  $('initialPasswordNotice').hidden = !next.mustChangePassword;
  renderBlocks(); renderWeekly();
}
async function save(button, action) {
  if (saving) return;
  saving = true; button.disabled = true; message('');
  try { await action(); }
  catch (error) {
    if (error.status === 409) { try { await load(); } catch {} }
    message(error.message, true);
  } finally { saving = false; button.disabled = false; }
}
$('loginForm').addEventListener('submit', event => { event.preventDefault(); save(event.submitter, async () => { await api('login', {password: $('password').value}); $('password').value = ''; await load(); message('Acesso liberado. Sua agenda está atualizada.'); }); });
$('blockType').addEventListener('change', () => { const range = $('blockType').value === 'range'; $('rangeFields').hidden = !range; $('blockStart').required = range; $('blockEnd').required = range; });
$('blockForm').addEventListener('submit', event => {
  event.preventDefault(); save(event.submitter, async () => {
    state = await api('block', {version: state.version, date: $('blockDate').value, allDay: $('blockType').value === 'day', start: $('blockStart').value, end: $('blockEnd').value, note: $('blockNote').value});
    renderBlocks(); $('blockNote').value = ''; message('Bloqueio salvo. Esse período já está indisponível no site.');
  });
});
$('weeklyForm').addEventListener('submit', event => {
  event.preventDefault(); save(event.submitter, async () => {
    const weekly = days.map((_, day) => $(`open${day}`).checked ? {start: $(`start${day}`).value, end: $(`end${day}`).value} : null);
    state = await api('weekly', {version: state.version, weekly}); renderWeekly(); message('Horário semanal salvo e atualizado no site.');
  });
});
$('passwordForm').addEventListener('submit', event => {
  event.preventDefault();
  if ($('newPassword').value !== $('confirmPassword').value) { message('As duas novas senhas precisam ser iguais.', true); return; }
  save(event.submitter, async () => { await api('password', {current: $('currentPassword').value, password: $('newPassword').value}); $('passwordForm').reset(); $('initialPasswordNotice').hidden = true; message('Senha atualizada. Use a nova senha nos outros aparelhos.'); });
});
$('reload').addEventListener('click', event => save(event.currentTarget, async () => { await load(); message('Agenda atualizada.'); }));
$('logout').addEventListener('click', event => save(event.currentTarget, async () => { await api('logout', {}); showLogin(); message('Você saiu da agenda.'); }));
$('blockDate').min = localToday();
const max = new Date(`${localToday()}T12:00:00Z`); max.setUTCDate(max.getUTCDate() + 366); $('blockDate').max = max.toISOString().slice(0, 10);
load().catch(error => { if (error.status !== 401) message('Não foi possível consultar a agenda. Atualize a página para tentar novamente.', true); });
