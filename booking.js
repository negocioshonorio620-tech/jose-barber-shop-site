const dateField = document.getElementById('date');
const timeField = document.getElementById('time');
const form = document.getElementById('bookingForm');
const submit = form.querySelector('button[type="submit"]');
const status = document.getElementById('availabilityStatus');
let currentRequest = 0;
let busy = false;
const days = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const order = [1, 2, 3, 4, 5, 6, 0];
async function api(path, options = {}) {
  const response = await fetch(path, {cache: 'no-store', ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível consultar a agenda.');
  return data;
}
function resetTime(label) { timeField.replaceChildren(new Option(label, '')); timeField.disabled = true; submit.disabled = true; }
async function loadSlots() {
  const id = ++currentRequest;
  resetTime('Consultando horários…');
  status.textContent = '';
  if (!dateField.value) { resetTime('Escolha uma data primeiro'); return; }
  try {
    const data = await api(`/api/availability?date=${encodeURIComponent(dateField.value)}`);
    if (id !== currentRequest) return;
    resetTime(data.slots.length ? 'Escolha o horário' : 'Sem horários disponíveis');
    for (const time of data.slots) timeField.add(new Option(time, time));
    timeField.disabled = !data.slots.length;
    status.textContent = data.message || 'Horários de Brasília. A solicitação será confirmada pela barbearia.';
  } catch (error) {
    if (id !== currentRequest) return;
    resetTime('Agenda indisponível');
    status.textContent = `${error.message} Tente atualizar os horários ou fale pelo WhatsApp.`;
  }
}
async function loadCalendar() {
  try {
    const calendar = await api('/api/calendar');
    dateField.min = calendar.today;
    const max = new Date(`${calendar.today}T12:00:00Z`); max.setUTCDate(max.getUTCDate() + 366);
    dateField.max = max.toISOString().slice(0, 10);
    const rows = document.getElementById('weeklyHours');
    rows.replaceChildren();
    for (const day of order) {
      const row = document.createElement('div'), label = document.createElement('span'), hours = document.createElement('strong');
      label.textContent = days[day];
      hours.textContent = calendar.weekly[day] ? `${calendar.weekly[day].start}–${calendar.weekly[day].end}` : 'Fechado';
      row.append(label, hours); rows.append(row);
    }
  } catch { status.textContent = 'Não foi possível atualizar a agenda. Tente novamente ou fale pelo WhatsApp.'; }
}
document.getElementById('year').textContent = new Date().getFullYear();
dateField.addEventListener('change', loadSlots);
timeField.addEventListener('change', () => { submit.disabled = !timeField.value || busy; });
document.getElementById('refreshAvailability').addEventListener('click', async () => { await loadCalendar(); await loadSlots(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && dateField.value && !busy) { loadCalendar(); loadSlots(); } });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !timeField.value || !form.reportValidity()) return;
  busy = true; submit.disabled = true;
  const data = new FormData(form);
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  try {
    await api('/api/check', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({date: data.get('date'), time: data.get('time')})});
    const date = new Date(`${data.get('date')}T12:00:00`).toLocaleDateString('pt-BR');
    const message = ['Olá, José Barber Shop! Quero pedir um horário:', `Nome: ${data.get('name')}`, `Serviço: ${data.get('service')}`, `Data preferida: ${date}`, `Horário preferido: ${data.get('time')}`, data.get('phone') ? `Meu telefone: ${data.get('phone')}` : null, 'Pode confirmar a disponibilidade, por favor?'].filter(Boolean).join('\n');
    const link = `https://wa.me/5561994498081?text=${encodeURIComponent(message)}`;
    if (popup) popup.location.href = link; else window.location.assign(link);
    status.textContent = 'Envie a mensagem no WhatsApp e aguarde a confirmação da barbearia.';
  } catch (error) {
    popup?.close();
    await loadSlots();
    status.textContent = error.message;
  } finally { busy = false; submit.disabled = !timeField.value; }
});
resetTime('Escolha uma data primeiro');
loadCalendar();
