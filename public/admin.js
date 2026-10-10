(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const sections = ['#admin-loading','#admin-error','#mfa-enroll','#mfa-verify','#recovery-codes','#admin-dashboard'];
  let csrfToken = null;
  let currentStaff = null;
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
    currentStaff = response.staff;
    $('#admin-welcome').textContent = `Hola, ${response.staff.name}`;
    $('#admin-role').textContent = `@${response.staff.username} · ${response.staff.role}`;
    $('#moderation-action option[value="ban"]').hidden = response.staff.role !== 'admin';
    show('#admin-dashboard');
    $('#football-promotion-panel').classList.toggle('hidden', response.staff.role !== 'admin');
    await loadReports();
    if (response.staff.role === 'admin') await loadFootballPromotions();
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
  async function loadFootballPromotions(){const list=$('#football-promotions-list');const response=await request('/admin/estadio/promotions');if(!response.ok){list.textContent=response.error||'La bandeja de La Previa no está disponible.';return;}const promotions=response.promotions||[];list.innerHTML=promotions.map(promotion=>{const match=promotion.match;const kickoff=match?.scheduledKickoffAt?new Date(match.scheduledKickoffAt).toLocaleString():'sin kickoff disponible';const disabled=promotion.canApprove?'':'disabled';return `<article class="user-row promotion-row"><div class="promotion-copy"><b>@${escapeHtml(promotion.username||'cuenta')} · ${escapeHtml(promotion.profileName||'')}</b><small>Partido ${escapeHtml(promotion.matchId)} · ${escapeHtml(kickoff)} · ${new Date(promotion.createdAt).toLocaleString()}</small><p>${escapeHtml(promotion.text)}</p><small>Enlace: <code>${escapeHtml(promotion.targetPath)}</code></small>${promotion.unavailableReason?`<small class="promotion-unavailable">${escapeHtml(promotion.unavailableReason)}</small>`:''}</div><div class="promotion-actions"><button class="button" type="button" data-promotion-review="approve" data-profile-id="${escapeHtml(promotion.profileId)}" data-promotion-id="${escapeHtml(promotion.id)}" ${disabled}>Aprobar · cobrar 250</button><button class="button danger" type="button" data-promotion-review="reject" data-profile-id="${escapeHtml(promotion.profileId)}" data-promotion-id="${escapeHtml(promotion.id)}">Rechazar</button></div></article>`;}).join('')||'<p>No hay promociones pendientes.</p>';list.querySelectorAll('[data-promotion-review]').forEach(button=>button.addEventListener('click',()=>reviewFootballPromotion(button)));}
  async function reviewFootballPromotion(button){const decision=button.dataset.promotionReview;const profileId=button.dataset.profileId;const promotionId=button.dataset.promotionId;let reason='';if(decision==='approve'){if(!window.confirm('¿Aprobar esta promoción y descontar 250 fichas de la cuenta?'))return;}else{reason=window.prompt('Motivo del rechazo (10–500 caracteres):')||'';if(reason.trim().length<10||reason.trim().length>500)return status('El motivo del rechazo debe tener entre 10 y 500 caracteres.');}button.disabled=true;const response=await request(`/admin/estadio/promotions/${encodeURIComponent(profileId)}/${encodeURIComponent(promotionId)}/review`,{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({decision,reason})});if(!response.ok){button.disabled=false;if(response.code==='recent_auth_required')show('#mfa-verify');status(response.error||'No se pudo revisar la promoción.');return;}status(decision==='approve'?'Promoción aprobada y cobro de 250 fichas aplicado.':'Promoción rechazada; no se cobraron fichas.');await loadFootballPromotions();}
  $('#football-promotions-refresh').addEventListener('click',loadFootballPromotions);
  async function openUser(id){
const response=await request(`/api/admin/v1/users/${encodeURIComponent(id)}`);if(!response.ok)return status(response.error||'No se pudo abrir la cuenta.');selectedUser=response.user;const user=response.user;const canActOnUser=user.role!=='admin'&&(currentStaff?.role==='admin'||(currentStaff?.role==='moderator'&&user.role==='user'));$('#detail-name').textContent=`${user.name} · @${user.username}`;$('#detail-meta').textContent=`${user.role} · ${user.status}${user.until?' hasta '+new Date(user.until).toLocaleString():''}`;renderHistory(response.actions);$('#moderation-form').classList.toggle('hidden',!canActOnUser);$('#unban-panel').classList.toggle('hidden',!(currentStaff?.role==='admin'&&canActOnUser&&user.status!=='active'));$('#role-form').classList.toggle('hidden',!(currentStaff?.role==='admin'&&canActOnUser));$('#role-submit').textContent=user.role==='moderator'?'Quitar rol de moderador':'Promover a moderador';$('#user-detail').classList.remove('hidden');}
  $('#user-search-form').addEventListener('submit',async event=>{event.preventDefault();status('');const response=await request(`/api/admin/v1/users?query=${encodeURIComponent($('#user-search').value)}`);if(!response.ok)return status(response.error||'No se pudo buscar.');$('#user-results').innerHTML=response.users.map(user=>`<div class="user-row"><div><b>${escapeHtml(user.name)}</b><br><small>@${escapeHtml(user.username)} · ${escapeHtml(user.role)} · ${escapeHtml(user.status)}</small></div><button data-user="${escapeHtml(user.id)}">Abrir</button></div>`).join('')||'<p>Sin resultados.</p>';document.querySelectorAll('[data-user]').forEach(button=>button.addEventListener('click',()=>openUser(button.dataset.user)));});
  $('#detail-close').addEventListener('click',()=>{$('#user-detail').classList.add('hidden');selectedUser=null;});
  $('#moderation-action').addEventListener('change',()=>$('#duration-field').classList.toggle('hidden',$('#moderation-action').value!=='suspend'));
  $('#password-reset-form').addEventListener('submit',async event=>{event.preventDefault();if(!selectedUser)return;const confirmation=window.prompt(`Escribe @${selectedUser.username} para confirmar el restablecimiento:`);if(confirmation!==`@${selectedUser.username}`)return status('Acción cancelada.');const button=event.submitter;button.disabled=true;const response=await request(`/api/admin/v1/users/${encodeURIComponent(selectedUser.id)}/password-reset`,{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({reason:$('#password-reset-reason').value})});button.disabled=false;if(!response.ok){if(response.code==='recent_auth_required')show('#mfa-verify');return status(response.error||'No se generó el enlace.');}$('#password-reset-url').value=response.resetUrl;$('#password-reset-result').classList.remove('hidden');$('#password-reset-reason').value='';status('Enlace generado. Caduca en 15 minutos y funciona una sola vez.');});
  async function applyModerationAction(action, button){if(!selectedUser)return;const reasonField=$('#moderation-reason');if(!reasonField.reportValidity())return;const actionName=action==='unban'?'desbanear / reactivar':action==='ban'?'banear permanentemente':'suspender';const confirmation=window.prompt(`Escribe @${selectedUser.username} para confirmar ${actionName}:`);if(confirmation!==`@${selectedUser.username}`)return status('Acción cancelada.');const userId=selectedUser.id;button.disabled=true;const response=await request(`/api/admin/v1/users/${encodeURIComponent(userId)}/${action}`,{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({reason:reasonField.value,duration:$('#moderation-duration').value})});button.disabled=false;if(!response.ok){if(response.code==='recent_auth_required')show('#mfa-verify');return status(response.error||'No se aplicó la acción.');}status(action==='unban'?'Cuenta reactivada y sesiones revocadas.':'Acción aplicada y sesiones revocadas.');reasonField.value='';await openUser(userId);}
  $('#moderation-form').addEventListener('submit',event=>{event.preventDefault();applyModerationAction($('#moderation-action').value,event.submitter);});
  $('#unban-user').addEventListener('click',event=>applyModerationAction('unban',event.currentTarget));
  $('#role-form').addEventListener('submit',async event=>{event.preventDefault();if(!selectedUser||currentStaff?.role!=='admin')return;const reasonField=$('#role-reason');if(!reasonField.reportValidity())return;const nextRole=selectedUser.role==='moderator'?'user':'moderator';const actionName=nextRole==='moderator'?'promover a moderador':'retirar los permisos de moderación';const confirmation=window.prompt(`Escribe @${selectedUser.username} para confirmar ${actionName}:`);if(confirmation!==`@${selectedUser.username}`)return status('Acción cancelada.');const userId=selectedUser.id;const button=event.submitter;button.disabled=true;const response=await request(`/api/admin/v1/users/${encodeURIComponent(userId)}/role`,{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({role:nextRole,reason:reasonField.value})});button.disabled=false;if(!response.ok){if(response.code==='recent_auth_required')show('#mfa-verify');return status(response.error||'No se cambió el rol.');}reasonField.value='';status(response.target?.mfaRequired?'Rol actualizado y sesiones revocadas. Se exigirá MFA al próximo acceso.':'Rol actualizado y sesiones revocadas.');await openUser(userId);});

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
