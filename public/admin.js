(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const sections = ['#admin-loading', '#admin-error', '#mfa-enroll', '#mfa-verify', '#recovery-codes', '#admin-dashboard'];
  let csrfToken = null;
  let currentStaff = null;
  let selectedUser = null;
  let selectedReport = null;
  let activeTab = 'all';
  let cachedMatches = [];
  let cachedTeams = {};

  function show(selector) {
    sections.forEach(id => $(id)?.classList.toggle('hidden', id !== selector));
  }

  function status(message = '', type = null) {
    const el = $('#status');
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.className = 'status';
      return;
    }
    let resolvedType = type;
    if (!resolvedType) {
      const lower = String(message).toLowerCase();
      if (
        lower.includes('éxito') || lower.includes('actualizado') || lower.includes('aprobada') ||
        lower.includes('reactivada') || lower.includes('generado') || lower.includes('guardado') ||
        lower.includes('guardó') || lower.includes('reprogramado')
      ) {
        resolvedType = 'success';
      } else if (
        lower.includes('error') || lower.includes('falló') || lower.includes('cancelada') ||
        lower.includes('no se') || lower.includes('incorrecto') || lower.includes('rechazad') ||
        lower.includes('debe tener') || lower.includes('posterior') || lower.includes('selecciona')
      ) {
        resolvedType = 'error';
      } else {
        resolvedType = 'info';
      }
    }
    el.className = `status ${resolvedType}`;
    el.textContent = message;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > (window.innerHeight || 800)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (_) { /* sin soporte de scroll */ }
  }

  async function request(path, options = {}) {
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}),
          ...(options.headers || {})
        }
      });
      return { status: response.status, ...(await response.json().catch(() => ({}))) };
    } catch (_) {
      return { status: 0, error: 'No se pudo contactar al servidor.' };
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function applyTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    const isAdmin = currentStaff?.role === 'admin';
    const reportsPanel = $('#reports-panel');
    const reportDetail = $('#report-detail');
    const promoPanel = $('#football-promotion-panel');
    const matchesPanel = $('#football-matches-panel');
    const usersCard = $('.users-card');
    const userDetail = $('#user-detail');
    const auditGrid = $('.audit-grid');

    if (tab === 'all') {
      reportsPanel?.classList.remove('hidden');
      if (isAdmin) {
        promoPanel?.classList.remove('hidden');
        matchesPanel?.classList.remove('hidden');
      } else {
        promoPanel?.classList.add('hidden');
        matchesPanel?.classList.add('hidden');
      }
      auditGrid?.classList.remove('hidden');
      usersCard?.classList.remove('hidden');
    } else if (tab === 'reports') {
      reportsPanel?.classList.remove('hidden');
      promoPanel?.classList.add('hidden');
      matchesPanel?.classList.add('hidden');
      auditGrid?.classList.add('hidden');
      usersCard?.classList.add('hidden');
      userDetail?.classList.add('hidden');
    } else if (tab === 'estadio') {
      reportsPanel?.classList.add('hidden');
      reportDetail?.classList.add('hidden');
      if (isAdmin) {
        promoPanel?.classList.remove('hidden');
        matchesPanel?.classList.remove('hidden');
      }
      auditGrid?.classList.add('hidden');
      usersCard?.classList.add('hidden');
      userDetail?.classList.add('hidden');
    } else if (tab === 'users') {
      reportsPanel?.classList.add('hidden');
      reportDetail?.classList.add('hidden');
      promoPanel?.classList.add('hidden');
      matchesPanel?.classList.add('hidden');
      auditGrid?.classList.add('hidden');
      usersCard?.classList.remove('hidden');
    }
  }

  async function loadDashboard() {
    const response = await request('/api/admin/v1/me');
    if (!response.ok) {
      if (response.code === 'recent_auth_required' || response.code === 'mfa_required') return show('#mfa-verify');
      show('#admin-error');
      $('#admin-error-copy').textContent = response.error || 'No tienes acceso al panel.';
      return;
    }
    currentStaff = response.staff;
    $('#admin-welcome').textContent = `Hola, ${response.staff.name}`;
    $('#admin-role').textContent = `@${response.staff.username} · ${response.staff.role}`;
    const staffBadge = $('#staff-role-badge');
    if (staffBadge) {
      staffBadge.textContent = response.staff.role === 'admin' ? 'Administrador' : 'Moderador';
      staffBadge.className = `badge ${response.staff.role === 'admin' ? 'badge-danger' : 'badge-gold'}`;
    }
    $('#moderation-action option[value="ban"]').hidden = response.staff.role !== 'admin';
    show('#admin-dashboard');

    applyTab(activeTab);

    await loadReports();
    if (response.staff.role === 'admin') {
      await loadFootballPromotions();
      await loadFootballMatches();
    }
  }

  async function bootstrap() {
    const session = await request('/api/auth/session');
    if (!session.ok) {
      show('#admin-error');
      $('#admin-error-copy').textContent = 'Inicia sesión con una cuenta autorizada.';
      return;
    }
    csrfToken = session.csrfToken;
    if (!session.auth?.staff) {
      show('#admin-error');
      $('#admin-error-copy').textContent = 'Esta cuenta no pertenece al personal.';
      return;
    }
    if (session.auth.mfaEnrollmentRequired) return show('#mfa-enroll');
    if (!session.auth.mfaVerified) return show('#mfa-verify');
    await loadDashboard();
  }

  // --- Reportes ---
  async function loadReports() {
    const response = await request('/api/admin/v1/reports?status=open');
    if (!response.ok) return status(response.error || 'No se cargaron los reportes.', 'error');
    const reports = response.reports || [];
    const list = $('#reports-list');
    if (!list) return;
    if (!reports.length) {
      list.innerHTML = '<p class="empty-state">No hay reportes abiertos pendientes de atención.</p>';
      return;
    }
    list.innerHTML = reports.map(report => {
      const priorityClass = report.priority === 'urgent' ? 'badge-danger' :
                            report.priority === 'high' ? 'badge-warning' :
                            report.priority === 'normal' ? 'badge-gold' : 'badge-muted';
      return `<div class="user-row report-row">
        <div>
          <div class="report-row-header">
            <b>${escapeHtml(report.category)}</b>
            <span class="badge ${priorityClass}">${escapeHtml(report.priority)}</span>
          </div>
          <small>${new Date(report.createdAt).toLocaleString()} · ID: <code>${escapeHtml(report.id)}</code></small>
        </div>
        <button class="text-button" data-report="${escapeHtml(report.id)}">Atender</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-report]').forEach(button =>
      button.addEventListener('click', () => openReport(button.dataset.report))
    );
  }

  async function openReport(id) {
    const response = await request(`/api/admin/v1/reports/${encodeURIComponent(id)}`);
    if (!response.ok) return status(response.error || 'No se abrió el reporte.', 'error');
    selectedReport = response.report;
    $('#report-title').textContent = `${response.report.category} · ${response.report.status}`;
    $('#report-description').textContent = response.report.description;
    $('#report-status').value = response.report.status === 'open' ? 'triaged' : response.report.status;
    $('#report-priority').value = response.report.priority;
    $('#report-resolution').value = response.report.resolution || '';
    $('#report-evidence').textContent = response.evidence.length ? JSON.stringify(response.evidence, null, 2) : 'Sin evidencia adjunta';
    $('#report-detail').classList.remove('hidden');
  }

  $('#reports-refresh').addEventListener('click', loadReports);
  $('#report-close').addEventListener('click', () => {
    $('#report-detail').classList.add('hidden');
    selectedReport = null;
  });

  $('#report-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedReport) return;
    const response = await request(`/api/admin/v1/reports/${encodeURIComponent(selectedReport.id)}`, {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        version: selectedReport.version,
        status: $('#report-status').value,
        priority: $('#report-priority').value,
        assignedTo: null,
        resolution: $('#report-resolution').value
      })
    });
    if (!response.ok) return status(response.error || 'No se guardó el reporte.', 'error');
    selectedReport = response.report;
    status('Reporte actualizado con éxito.', 'success');
    await loadReports();
    $('#report-detail').classList.add('hidden');
  });

  // --- Promociones de Estadio ---
  async function loadFootballPromotions() {
    const list = $('#football-promotions-list');
    if (!cachedMatches.length) await loadFootballMatches();
    fillPromoCreateMatches();
    if (!list) return;
    const response = await request('/admin/estadio/promotions');
    if (!response.ok) {
      list.textContent = response.error || 'La bandeja de La Previa no está disponible.';
      return;
    }
    const promotions = response.promotions || [];
    if (!promotions.length) {
      list.innerHTML = '<p class="empty-state">No hay promociones pendientes de revisión.</p>';
      return;
    }
    list.innerHTML = promotions.map(promotion => {
      const match = promotion.match;
      const kickoff = match?.scheduledKickoffAt ? new Date(match.scheduledKickoffAt).toLocaleString() : 'sin kickoff disponible';
      const disabled = promotion.canApprove ? '' : 'disabled';
      const homeName = cachedTeams[match?.homeId]?.name || match?.homeId || 'Local';
      const awayName = cachedTeams[match?.awayId]?.name || match?.awayId || 'Visitante';
      const matchLabel = match ? `${homeName} vs ${awayName}` : promotion.matchId;

      return `<article class="user-row promotion-row">
        <div class="promotion-copy">
          <div class="promotion-header">
            <b>@${escapeHtml(promotion.username || 'cuenta')} <span class="profile-name">(${escapeHtml(promotion.profileName || '')})</span></b>
            <span class="badge ${promotion.canApprove ? 'badge-mint' : 'badge-danger'}">${promotion.canApprove ? 'Listo para aprobación' : 'No disponible'}</span>
          </div>
          <small class="promotion-meta">Partido: <strong>${escapeHtml(matchLabel)}</strong> (<code>${escapeHtml(promotion.matchId)}</code>) · Kickoff: ${escapeHtml(kickoff)} · Solicitado: ${new Date(promotion.createdAt).toLocaleString()}</small>
          <div class="promotion-bubble">
            <p>${escapeHtml(promotion.text)}</p>
          </div>
          ${promotion.imageUrl ? `<figure class="promotion-media"><img src="${escapeHtml(promotion.imageUrl)}" alt="Creatividad enviada por @${escapeHtml(promotion.username || 'cuenta')} (vista previa de revisión)" loading="lazy" /><figcaption>Vista previa de revisión · se borra al rechazar o al iniciar el partido</figcaption></figure>` : ''}
          <small class="promotion-target">Ruta interna vinculada: <code>${escapeHtml(promotion.targetPath)}</code></small>
          ${promotion.unavailableReason ? `<small class="promotion-unavailable">⚠ ${escapeHtml(promotion.unavailableReason)}</small>` : ''}
        </div>
        <div class="promotion-actions">
          <button class="button" type="button" data-promotion-review="approve" data-profile-id="${escapeHtml(promotion.profileId)}" data-promotion-id="${escapeHtml(promotion.id)}" ${disabled}>Aprobar · cobrar 250</button>
          <button class="button danger" type="button" data-promotion-review="reject" data-profile-id="${escapeHtml(promotion.profileId)}" data-promotion-id="${escapeHtml(promotion.id)}">Rechazar</button>
        </div>
      </article>`;
    }).join('');
    list.querySelectorAll('[data-promotion-review]').forEach(button =>
      button.addEventListener('click', () => reviewFootballPromotion(button))
    );
  }

  async function reviewFootballPromotion(button) {
    const decision = button.dataset.promotionReview;
    const profileId = button.dataset.profileId;
    const promotionId = button.dataset.promotionId;
    let reason = '';
    if (decision === 'approve') {
      if (!window.confirm('¿Aprobar esta promoción y descontar 250 fichas de la cuenta vinculada?')) return;
    } else {
      reason = window.prompt('Motivo del rechazo (10–500 caracteres):') || '';
      if (reason.trim().length < 10 || reason.trim().length > 500) {
        return status('El motivo del rechazo debe tener entre 10 y 500 caracteres.', 'error');
      }
    }
    button.disabled = true;
    const response = await request(`/admin/estadio/promotions/${encodeURIComponent(profileId)}/${encodeURIComponent(promotionId)}/review`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ decision, reason })
    });
    if (!response.ok) {
      button.disabled = false;
      if (response.code === 'recent_auth_required') show('#mfa-verify');
      return status(response.error || 'No se pudo revisar la promoción.', 'error');
    }
    status(decision === 'approve' ? 'Promoción aprobada y cobro de 250 fichas aplicado.' : 'Promoción rechazada; no se cobraron fichas.', 'success');
    await loadFootballPromotions();
  }

  $('#football-promotions-refresh').addEventListener('click', loadFootballPromotions);

  // --- Campaña directa (administración) ---
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  function fillPromoCreateMatches() {
    const select = $('#promo-create-match');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Elige un partido</option>' + cachedMatches.map(match => {
      const kickoff = match.scheduledKickoffAt ? new Date(match.scheduledKickoffAt).toLocaleString() : '';
      const label = `${cachedTeams[match.homeId]?.name || match.homeId} vs ${cachedTeams[match.awayId]?.name || match.awayId} · ${kickoff}`;
      return `<option value="${escapeHtml(match.id)}">${escapeHtml(label)}</option>`;
    }).join('');
    select.value = current;
  }
  $('#promo-create-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const message = $('#promo-create-message');
    const setMessage = (text, type = '') => { message.textContent = text; message.dataset.type = type; };
    if (!cachedMatches.length) await loadFootballMatches();
    fillPromoCreateMatches();
    const file = $('#promo-create-image').files[0];
    if (file && (file.size > 350 * 1024 || !/^image\/(png|jpeg)$/.test(file.type))) {
      return setMessage('La imagen debe ser PNG o JPEG de máximo 350 KB.', 'error');
    }
    const payload = {
      profileId: $('#promo-create-profile').value.trim(),
      matchId: $('#promo-create-match').value,
      text: $('#promo-create-text').value,
      targetPath: $('#promo-create-target').value
    };
    if (file) payload.image = await readFileAsDataUrl(file);
    setMessage('Publicando…');
    const response = await request('/admin/estadio/promotions/create', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      if (response.code === 'recent_auth_required') show('#mfa-verify');
      return setMessage(response.error || 'No se pudo publicar la campaña.', 'error');
    }
    event.target.reset();
    setMessage('Campaña publicada: aparece en La Previa dentro de la ventana T−30 del partido.', 'success');
    await loadFootballPromotions();
  });

  // --- Calendario de Partidos y Reprogramación ---
  function renderFootballMatches() {
    const list = $('#football-matches-list');
    if (!list) return;

    if (!cachedMatches.length) {
      list.innerHTML = '<p class="empty-state">No hay partidos programados pendientes de jugar.</p>';
      const countEl = $('#football-matches-count');
      if (countEl) countEl.textContent = '0 partidos';
      return;
    }

    const searchInput = $('#football-matches-search');
    const query = (searchInput?.value || '').trim().toLowerCase();
    const jornadaSelect = $('#football-matches-jornada-filter');
    const jornadaVal = jornadaSelect?.value || '';

    const filtered = cachedMatches.filter(match => {
      if (jornadaVal && String(match.jornada) !== jornadaVal) return false;
      if (query) {
        const home = cachedTeams[match.homeId];
        const away = cachedTeams[match.awayId];
        const terms = [
          match.id, match.homeId, match.awayId,
          home?.name, away?.name, home?.short, away?.short,
          `j${match.jornada}`, `jornada ${match.jornada}`, match.block
        ].filter(Boolean).join(' ').toLowerCase();
        if (!terms.includes(query)) return false;
      }
      return true;
    });

    const countEl = $('#football-matches-count');
    if (countEl) {
      countEl.textContent = `Mostrando ${filtered.length} de ${cachedMatches.length} partidos`;
    }

    if (!filtered.length) {
      list.innerHTML = '<p class="empty-state">No se encontraron partidos que coincidan con la búsqueda.</p>';
      return;
    }

    const pad = n => String(n).padStart(2, '0');

    list.innerHTML = filtered.map(match => {
      const kickoffDate = match.scheduledKickoffAt ? new Date(match.scheduledKickoffAt) : null;
      const kickoff = kickoffDate ? kickoffDate.toLocaleString('es-ES', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      }) : 'sin kickoff';

      const d = kickoffDate || new Date();
      const localIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

      const home = cachedTeams[match.homeId] || { name: match.homeId, short: match.homeId, colors: { primary: '#52e0ae' } };
      const away = cachedTeams[match.awayId] || { name: match.awayId, short: match.awayId, colors: { primary: '#e5bd72' } };

      const diffMs = (match.scheduledKickoffAt || 0) - Date.now();
      let timeBadge = '';
      if (diffMs <= 0) {
        timeBadge = '<span class="badge badge-danger">Kickoff inminente</span>';
      } else if (diffMs <= 30 * 60 * 1000) {
        const mins = Math.max(1, Math.ceil(diffMs / 60000));
        timeBadge = `<span class="badge badge-preshow">En La Previa (T-${mins}m)</span>`;
      } else if (diffMs < 3600 * 1000) {
        const mins = Math.ceil(diffMs / 60000);
        timeBadge = `<span class="badge badge-mint">En ${mins} min</span>`;
      } else if (diffMs < 24 * 3600 * 1000) {
        const hours = Math.round(diffMs / 3600000);
        timeBadge = `<span class="badge badge-muted">En ~${hours} h</span>`;
      } else {
        const days = Math.round(diffMs / (24 * 3600 * 1000));
        timeBadge = `<span class="badge badge-muted">En ~${days} d</span>`;
      }

      return `<article class="user-row match-card" data-match-id="${escapeHtml(match.id)}">
        <div class="match-info">
          <div class="match-header-line">
            <span class="badge badge-gold">Jornada ${escapeHtml(String(match.jornada || ''))}</span>
            <span class="badge badge-muted">${escapeHtml(String(match.block || ''))}${match.featured ? ' ★ Estelar' : ''}</span>
            ${timeBadge}
          </div>
          <div class="match-teams-display">
            <div class="team-unit">
              <span class="crest-dot" style="background:${escapeHtml(home.colors?.primary || '#52e0ae')};" title="${escapeHtml(home.name)}"></span>
              <strong class="team-title">${escapeHtml(home.name)}</strong>
              <small class="team-short">${escapeHtml(home.short || '')}</small>
            </div>
            <span class="teams-separator">vs</span>
            <div class="team-unit">
              <span class="crest-dot" style="background:${escapeHtml(away.colors?.primary || '#e5bd72')};" title="${escapeHtml(away.name)}"></span>
              <strong class="team-title">${escapeHtml(away.name)}</strong>
              <small class="team-short">${escapeHtml(away.short || '')}</small>
            </div>
          </div>
          <div class="match-meta-details">
            <span>ID: <code>${escapeHtml(match.id)}</code></span>
            <span>·</span>
            <span>Kickoff actual: <strong>${escapeHtml(kickoff)}</strong></span>
          </div>
        </div>
        <div class="match-actions-col">
          <label class="reschedule-box">
            <span class="reschedule-title">Nuevo kickoff:</span>
            <input type="datetime-local" class="reschedule-input" value="${escapeHtml(localIso)}" />
          </label>
          <button class="button reschedule-btn" type="button" data-action="reschedule" data-match-id="${escapeHtml(match.id)}">Reprogramar</button>
        </div>
      </article>`;
    }).join('');

    list.querySelectorAll('[data-action="reschedule"]').forEach(btn =>
      btn.addEventListener('click', () => rescheduleFootballMatch(btn))
    );
  }

  async function loadFootballMatches() {
    const list = $('#football-matches-list');
    if (!list) return;
    const response = await request('/admin/estadio/matches');
    if (!response.ok) {
      list.textContent = response.error || 'El calendario de partidos no está disponible.';
      return;
    }
    cachedTeams = response.teams || {};
    cachedMatches = (response.matches || [])
      .filter(m => m.status === 'scheduled')
      .sort((a, b) => (a.scheduledKickoffAt || 0) - (b.scheduledKickoffAt || 0));

    const jornadaSelect = $('#football-matches-jornada-filter');
    if (jornadaSelect) {
      const currentSelected = jornadaSelect.value;
      const jornadas = [...new Set(cachedMatches.map(m => m.jornada).filter(Boolean))].sort((a, b) => a - b);
      jornadaSelect.innerHTML = '<option value="">Todas las jornadas</option>' +
        jornadas.map(j => `<option value="${escapeHtml(String(j))}">Jornada ${escapeHtml(String(j))}</option>`).join('');
      jornadaSelect.value = currentSelected;
    }

    renderFootballMatches();
  }

  async function rescheduleFootballMatch(button) {
    const matchId = button.dataset.matchId;
    const row = button.closest('article');
    const input = row?.querySelector('.reschedule-input');
    const val = input?.value;
    if (!val) return status('Selecciona una nueva fecha y hora para el kickoff.', 'error');
    const timestamp = new Date(val).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      return status('La nueva hora de kickoff debe ser posterior a la actual.', 'error');
    }
    const formattedDate = new Date(timestamp).toLocaleString();
    if (!window.confirm(`¿Reprogramar el partido ${matchId} para el ${formattedDate}?`)) return;

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Guardando…';

    const response = await request(`/admin/estadio/matches/${encodeURIComponent(matchId)}/reschedule`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ kickoffAt: timestamp })
    });

    button.disabled = false;
    button.textContent = originalText;

    if (!response.ok) {
      if (response.code === 'recent_auth_required') show('#mfa-verify');
      return status(response.error || 'No se pudo reprogramar el partido.', 'error');
    }
    status('Partido reprogramado con éxito.', 'success');
    await loadFootballMatches();
  }

  $('#football-matches-refresh').addEventListener('click', loadFootballMatches);
  $('#football-matches-search')?.addEventListener('input', renderFootballMatches);
  $('#football-matches-jornada-filter')?.addEventListener('change', renderFootballMatches);

  // --- Moderación de Usuarios ---
  function renderHistory(actions = []) {
    $('#moderation-history').innerHTML = actions.length ? actions.map(action =>
      `<div class="history-row"><b>${String(action.type || 'acción').toUpperCase()}</b> · ${new Date(Number(action.startsAt || action.starts_at)).toLocaleString()}<br><small>${escapeHtml(action.reason || '')}</small></div>`
    ).join('') : '<p class="empty-state">Sin acciones de moderación anteriores.</p>';
  }

  async function openUser(id) {
    const response = await request(`/api/admin/v1/users/${encodeURIComponent(id)}`);
    if (!response.ok) return status(response.error || 'No se pudo abrir la cuenta.', 'error');
    selectedUser = response.user;
    const user = response.user;
    const canActOnUser = user.role !== 'admin' && (currentStaff?.role === 'admin' || (currentStaff?.role === 'moderator' && user.role === 'user'));
    $('#detail-name').textContent = `${user.name} · @${user.username}`;
    $('#detail-meta').textContent = `${user.role} · ${user.status}${user.until ? ' hasta ' + new Date(user.until).toLocaleString() : ''}`;
    renderHistory(response.actions);
    $('#moderation-form').classList.toggle('hidden', !canActOnUser);
    $('#unban-panel').classList.toggle('hidden', !(currentStaff?.role === 'admin' && canActOnUser && user.status !== 'active'));
    $('#role-form').classList.toggle('hidden', !(currentStaff?.role === 'admin' && canActOnUser));
    $('#role-select').value = user.role === 'admin' ? 'moderator' : user.role;
    $('#user-detail').classList.remove('hidden');
  }

  $('#user-search-form').addEventListener('submit', async event => {
    event.preventDefault();
    status('');
    const query = $('#user-search').value;
    const response = await request(`/api/admin/v1/users?query=${encodeURIComponent(query)}`);
    if (!response.ok) return status(response.error || 'No se pudo buscar.', 'error');
    const users = response.users || [];
    const resultsContainer = $('#user-results');
    if (!users.length) {
      resultsContainer.innerHTML = '<p class="empty-state">Sin resultados para la búsqueda.</p>';
      return;
    }
    resultsContainer.innerHTML = users.map(user => {
      const roleBadge = user.role === 'admin' ? 'badge-danger' :
                        user.role === 'moderator' ? 'badge-gold' :
                        user.role === 'sponsor' ? 'badge-mint' : 'badge-muted';
      const statusBadge = user.status === 'active' ? 'badge-mint' :
                          user.status === 'suspended' ? 'badge-warning' : 'badge-danger';
      return `<div class="user-row">
        <div>
          <div class="user-row-header">
            <b>${escapeHtml(user.name)}</b>
            <span class="badge ${roleBadge}">${escapeHtml(user.role)}</span>
            <span class="badge ${statusBadge}">${escapeHtml(user.status)}</span>
          </div>
          <small>@${escapeHtml(user.username)}</small>
        </div>
        <button class="text-button" data-user="${escapeHtml(user.id)}">Abrir</button>
      </div>`;
    }).join('');
    resultsContainer.querySelectorAll('[data-user]').forEach(button =>
      button.addEventListener('click', () => openUser(button.dataset.user))
    );
  });

  $('#detail-close').addEventListener('click', () => {
    $('#user-detail').classList.add('hidden');
    selectedUser = null;
  });

  $('#moderation-action').addEventListener('change', () =>
    $('#duration-field').classList.toggle('hidden', $('#moderation-action').value !== 'suspend')
  );

  $('#password-reset-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedUser) return;
    const confirmation = window.prompt(`Escribe @${selectedUser.username} para confirmar el restablecimiento:`);
    if (confirmation !== `@${selectedUser.username}`) return status('Acción cancelada.', 'info');
    const button = event.submitter;
    button.disabled = true;
    const response = await request(`/api/admin/v1/users/${encodeURIComponent(selectedUser.id)}/password-reset`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ reason: $('#password-reset-reason').value })
    });
    button.disabled = false;
    if (!response.ok) {
      if (response.code === 'recent_auth_required') show('#mfa-verify');
      return status(response.error || 'No se generó el enlace.', 'error');
    }
    $('#password-reset-url').value = response.resetUrl;
    $('#password-reset-result').classList.remove('hidden');
    $('#password-reset-reason').value = '';
    status('Enlace generado con éxito. Caduca en 15 minutos y funciona una sola vez.', 'success');
  });

  async function applyModerationAction(action, button) {
    if (!selectedUser) return;
    const reasonField = $('#moderation-reason');
    if (!reasonField.reportValidity()) return;
    const actionName = action === 'unban' ? 'desbanear / reactivar' : action === 'ban' ? 'banear permanentemente' : 'suspender';
    const confirmation = window.prompt(`Escribe @${selectedUser.username} para confirmar ${actionName}:`);
    if (confirmation !== `@${selectedUser.username}`) return status('Acción cancelada.', 'info');
    const userId = selectedUser.id;
    button.disabled = true;
    const response = await request(`/api/admin/v1/users/${encodeURIComponent(userId)}/${action}`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ reason: reasonField.value, duration: $('#moderation-duration').value })
    });
    button.disabled = false;
    if (!response.ok) {
      if (response.code === 'recent_auth_required') show('#mfa-verify');
      return status(response.error || 'No se aplicó la acción.', 'error');
    }
    status(action === 'unban' ? 'Cuenta reactivada y sesiones revocadas.' : 'Acción aplicada y sesiones revocadas.', 'success');
    reasonField.value = '';
    await openUser(userId);
  }

  $('#moderation-form').addEventListener('submit', event => {
    event.preventDefault();
    applyModerationAction($('#moderation-action').value, event.submitter);
  });

  $('#unban-user').addEventListener('click', event =>
    applyModerationAction('unban', event.currentTarget)
  );

  $('#role-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedUser || currentStaff?.role !== 'admin') return;
    const reasonField = $('#role-reason');
    if (!reasonField.reportValidity()) return;
    const nextRole = $('#role-select').value;
    if (nextRole === selectedUser.role) return status('La cuenta ya tiene ese rol.', 'info');
    const roleNames = { user: 'usuario', sponsor: 'patrocinador', moderator: 'moderador' };
    const actionName = `cambiar el rol a ${roleNames[nextRole] || nextRole}`;
    const confirmation = window.prompt(`Escribe @${selectedUser.username} para confirmar ${actionName}:`);
    if (confirmation !== `@${selectedUser.username}`) return status('Acción cancelada.', 'info');
    const userId = selectedUser.id;
    const button = event.submitter;
    button.disabled = true;
    const response = await request(`/api/admin/v1/users/${encodeURIComponent(userId)}/role`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ role: nextRole, reason: reasonField.value })
    });
    button.disabled = false;
    if (!response.ok) {
      if (response.code === 'recent_auth_required') show('#mfa-verify');
      return status(response.error || 'No se cambió el rol.', 'error');
    }
    reasonField.value = '';
    status(response.target?.mfaRequired ? 'Rol actualizado y sesiones revocadas. Se exigirá MFA al próximo acceso.' : 'Rol actualizado y sesiones revocadas.', 'success');
    await openUser(userId);
  });

  // --- MFA Enrolamiento y Verificación ---
  $('#mfa-start-form').addEventListener('submit', async event => {
    event.preventDefault();
    status('');
    const button = event.submitter;
    button.disabled = true;
    const response = await request('/api/auth/mfa/enroll/start', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ currentPassword: $('#mfa-password').value })
    });
    button.disabled = false;
    if (!response.ok) return status(response.error || 'No se pudo iniciar el enrolamiento.', 'error');
    $('#mfa-qr').src = response.qrDataUrl;
    $('#mfa-manual').textContent = response.manualKey;
    $('#mfa-setup').classList.remove('hidden');
    $('#mfa-confirm-code').focus();
  });

  $('#mfa-confirm-form').addEventListener('submit', async event => {
    event.preventDefault();
    status('');
    const button = event.submitter;
    button.disabled = true;
    const response = await request('/api/auth/mfa/enroll/confirm', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ token: $('#mfa-confirm-code').value })
    });
    button.disabled = false;
    if (!response.ok) return status(response.error || 'Código incorrecto.', 'error');
    $('#recovery-list').textContent = response.recoveryCodes.join('\n');
    show('#recovery-codes');
  });

  $('#recovery-continue').addEventListener('click', loadDashboard);

  $('#mfa-verify-form').addEventListener('submit', async event => {
    event.preventDefault();
    status('');
    const button = event.submitter;
    button.disabled = true;
    const value = $('#mfa-code').value.trim();
    const payload = /^\d{6}$/.test(value) ? { token: value } : { recoveryCode: value };
    const response = await request('/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(payload)
    });
    button.disabled = false;
    if (!response.ok) return status(response.error || 'Código incorrecto.', 'error');
    await loadDashboard();
  });

  // Pestañas
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', () => applyTab(btn.dataset.tab));
  });

  bootstrap();
})();
