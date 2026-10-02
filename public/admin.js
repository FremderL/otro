(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const sections = ['#admin-loading','#admin-error','#mfa-enroll','#mfa-verify','#recovery-codes','#admin-dashboard'];
  let csrfToken = null;
  let selectedUser = null;
  let selectedReport = null;

  function show(selector) { sections.forEach(id => $(id)?.classList.toggle('hidden', id !== selector)); }
  function status(message = '') { $('#status').textContent = message; }
  async function request(path, options = {}) {
    try {
      const response = await fetch(path, {
        credentials: 'same-origin', ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}), ...(options.headers || {}) }
      });
      return { status: response.status, ...(await response.json().catch(() => ({}))) };
    } catch (_) { return { status: 0, error: 'No se pudo contactar al servidor.' }; }
  }
  async function loadDashboard() {
    const response = await request('/api/admin/v1/me');
    if (!response.ok) {
      if (response.code === 'recent_auth_required' || response.code === 'mfa_required') return show('#mfa-verify');
      show('#admin-error'); $('#admin-error-copy').textContent = response.error || 'No tienes acceso al panel.'; return;
    }
    $('#admin-welcome').textContent = `Hola, ${response.staff.name}`;
    $('#admin-role').textContent = `@${response.staff.username} · ${response.staff.role}`;
    show('#admin-dashboard');
    await loadReports();
  }
  async function bootstrap() {
    const session = await request('/api/auth/session');
    if (!session.ok) { show('#admin-error'); $('#admin-error-copy').textContent = 'Inicia sesión con una cuenta autorizada.'; return; }
    csrfToken = session.csrfToken;
    if (!session.auth?.staff) { show('#admin-error'); $('#admin-error-copy').textContent = 'Esta cuenta no pertenece al personal.'; return; }
    if (session.auth.mfaEnrollmentRequired) return show('#mfa-enroll');
    if (!session.auth.mfaVerified) return show('#mfa-verify');
    await loadDashboard();
  }
  async function loadReports(){const response=await request('/api/admin/v1/reports?status=open');if(!response.ok)return status(response.error||'No se cargaron los reportes.');$('#reports-list').innerHTML=response.reports.map(report=>`<div class="user-row"><div><b>${escapeHtml(report.category)}</b><br><small>${new Date(report.createdAt).toLocaleString()} · ${escapeHtml(report.priority)}</small></div><button data-report="${escapeHtml(report.id)}">Atender</button></div>`).join('')||'<p>No hay reportes abiertos.</p>';document.querySelectorAll('[data-report]').forEach(button=>button.addEventListener('click',()=>openReport(button.dataset.report)));}
  async function openReport(id){const response=await request(`/api/admin/v1/reports/${encodeURIComponent(id)}`);if(!response.ok)return status(response.error||'No se abrió el reporte.');selectedReport=response.report;$('#report-title').textContent=`${response.report.category} · ${response.report.status}`;$('#report-description').textContent=response.report.description;$('#report-status').value=response.report.status==='open'?'triaged':response.report.status;$('#report-priority').value=response.report.priority;$('#report-resolution').value=response.report.resolution||'';$('#report-evidence').textContent=response.evidence.length?JSON.stringify(response.evidence,null,2):'Sin evidencia adjunta';$('#report-detail').classList.remove('hidden');}
  $('#reports-refresh').addEventListener('click',loadReports);$('#report-close').addEventListener('click',()=>{$('#report-detail').classList.add('hidden');selectedReport=null;});$('#report-form').addEventListener('submit',async event=>{event.preventDefault();if(!selectedReport)return;const response=await request(`/api/admin/v1/reports/${encodeURIComponent(selectedReport.id)}`,{method:'PATCH',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({version:selectedReport.version,status:$('#report-status').value,priority:$('#report-priority').value,assignedTo:null,resolution:$('#report-resolution').value})});if(!response.ok)return status(response.error||'No se guardó el reporte.');selectedReport=response.report;status('Reporte actualizado.');await loadReports();$('#report-detail').classList.add('hidden');});
  function renderHistory(actions=[]){$('#moderation-history').innerHTML=actions.length?actions.map(action=>`<div class="history-row"><b>${String(action.type||'acción').toUpperCase()}</b> · ${new Date(Number(action.startsAt||action.starts_at)).toLocaleString()}<br><small>${escapeHtml(action.reason||'')}</small></div>`).join(''):'<p>Sin acciones anteriores.</p>';}
  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
  async function openUser(id){const response=await request(`/api/admin/v1/users/${encodeURIComponent(id)}`);if(!response.ok)return status(response.error||'No se pudo abrir la cuenta.');selectedUser=response.user;$('#detail-name').textContent=`${response.user.name} · @${response.user.username}`;$('#detail-meta').textContent=`${response.user.role} · ${response.user.status}${response.user.until?' hasta '+new Date(response.user.until).toLocaleString():''}`;renderHistory(response.actions);$('#user-detail').classList.remove('hidden');}
  $('#user-search-form').addEventListener('submit',async event=>{event.preventDefault();status('');const response=await request(`/api/admin/v1/users?query=${encodeURIComponent($('#user-search').value)}`);if(!response.ok)return status(response.error||'No se pudo buscar.');$('#user-results').innerHTML=response.users.map(user=>`<div class="user-row"><div><b>${escapeHtml(user.name)}</b><br><small>@${escapeHtml(user.username)} · ${escapeHtml(user.role)} · ${escapeHtml(user.status)}</small></div><button data-user="${escapeHtml(user.id)}">Abrir</button></div>`).join('')||'<p>Sin resultados.</p>';document.querySelectorAll('[data-user]').forEach(button=>button.addEventListener('click',()=>openUser(button.dataset.user)));});
  $('#detail-close').addEventListener('click',()=>{$('#user-detail').classList.add('hidden');selectedUser=null;});
  $('#moderation-action').addEventListener('change',()=>$('#duration-field').classList.toggle('hidden',$('#moderation-action').value!=='suspend'));
  $('#password-reset-form').addEventListener('submit',async event=>{event.preventDefault();if(!selectedUser)return;const confirmation=window.prompt(`Escribe @${selectedUser.username} para confirmar el restablecimiento:`);if(confirmation!==`@${selectedUser.username}`)return status('Acción cancelada.');const button=event.submitter;button.disabled=true;const response=await request(`/api/admin/v1/users/${encodeURIComponent(selectedUser.id)}/password-reset`,{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({reason:$('#password-reset-reason').value})});button.disabled=false;if(!response.ok){if(response.code==='recent_auth_required')show('#mfa-verify');return status(response.error||'No se generó el enlace.');}$('#password-reset-url').value=response.resetUrl;$('#password-reset-result').classList.remove('hidden');$('#password-reset-reason').value='';status('Enlace generado. Caduca en 15 minutos y funciona una sola vez.');});
  $('#moderation-form').addEventListener('submit',async event=>{event.preventDefault();if(!selectedUser)return;const action=$('#moderation-action').value;const confirmation=window.prompt(`Escribe @${selectedUser.username} para confirmar ${action}:`);if(confirmation!==`@${selectedUser.username}`)return status('Acción cancelada.');const button=event.submitter;button.disabled=true;const response=await request(`/api/admin/v1/users/${encodeURIComponent(selectedUser.id)}/${action}`,{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({reason:$('#moderation-reason').value,duration:$('#moderation-duration').value})});button.disabled=false;if(!response.ok){if(response.code==='recent_auth_required')show('#mfa-verify');return status(response.error||'No se aplicó la acción.');}status('Acción aplicada y sesiones revocadas.');$('#moderation-reason').value='';await openUser(selectedUser.id);});

  $('#mfa-start-form').addEventListener('submit', async event => {
    event.preventDefault(); status('');
    const button = event.submitter; button.disabled = true;
    const response = await request('/api/auth/mfa/enroll/start', { method:'POST', headers:{'X-CSRF-Token':csrfToken}, body:JSON.stringify({currentPassword:$('#mfa-password').value}) });
    button.disabled = false;
    if (!response.ok) return status(response.error || 'No se pudo iniciar el enrolamiento.');
    $('#mfa-qr').src = response.qrDataUrl; $('#mfa-manual').textContent = response.manualKey; $('#mfa-setup').classList.remove('hidden'); $('#mfa-confirm-code').focus();
  });
  $('#mfa-confirm-form').addEventListener('submit', async event => {
    event.preventDefault(); status(''); const button = event.submitter; button.disabled = true;
    const response = await request('/api/auth/mfa/enroll/confirm', { method:'POST', headers:{'X-CSRF-Token':csrfToken}, body:JSON.stringify({token:$('#mfa-confirm-code').value}) });
    button.disabled = false;
    if (!response.ok) return status(response.error || 'Código incorrecto.');
    $('#recovery-list').textContent = response.recoveryCodes.join('\n'); show('#recovery-codes');
  });
  $('#recovery-continue').addEventListener('click', loadDashboard);
  $('#mfa-verify-form').addEventListener('submit', async event => {
    event.preventDefault(); status(''); const button = event.submitter; button.disabled = true;
    const value = $('#mfa-code').value.trim();
    const payload = /^\d{6}$/.test(value) ? {token:value} : {recoveryCode:value};
    const response = await request('/api/auth/mfa/verify', { method:'POST', headers:{'X-CSRF-Token':csrfToken}, body:JSON.stringify(payload) });
    button.disabled = false;
    if (!response.ok) return status(response.error || 'Código incorrecto.');
    await loadDashboard();
  });
  bootstrap();
})();
