'use strict';

// La Previa: promociones de texto con rutas internas permitidas. El anuncio se
// conserva en el perfil vinculado de quien lo envió; no contiene medios ni URLs
// externas y no forma parte de la proyección pública del perfil.
const PROMOTION_FEE = 250;
const PRESHOW_WINDOW_MS = 30 * 60 * 1000;
const PROMOTION_ROTATION_MS = 15 * 1000;
const MAX_PROMOTION_TEXT = 140;
const MAX_PROMOTIONS_PER_PROFILE = 100;
const PROMOTION_STATUSES = new Set(['pending', 'approved', 'rejected']);

function normalizePromotionText(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 3 && text.length <= MAX_PROMOTION_TEXT && !/[<>]/.test(text) ? text : null;
}

function normalizePromotionPath(value) {
  if (typeof value !== 'string') return null;
  const target = value.trim();
  if (target === '/' || target === '/estadio' || target === '/terminos') return target;
  const room = target.match(/^\/room\/([a-z0-9]{5})$/i);
  return room ? `/room/${room[1].toUpperCase()}` : null;
}

function cleanPromotion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').slice(0, 80);
  const matchId = String(raw.matchId || '').slice(0, 80);
  const text = normalizePromotionText(raw.text);
  const targetPath = normalizePromotionPath(raw.targetPath);
  const status = PROMOTION_STATUSES.has(raw.status) ? raw.status : null;
  const createdAt = Number(raw.createdAt);
  if (!id || !matchId || !text || !targetPath || !status || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  const reviewedAt = Number(raw.reviewedAt);
  return {
    id,
    matchId,
    text,
    targetPath,
    status,
    createdAt: Math.floor(createdAt),
    reviewedAt: Number.isFinite(reviewedAt) && reviewedAt > 0 ? Math.floor(reviewedAt) : null,
    reviewedBy: typeof raw.reviewedBy === 'string' ? raw.reviewedBy.slice(0, 80) : null,
    reviewReason: typeof raw.reviewReason === 'string' ? raw.reviewReason.trim().slice(0, 500) : null,
    chargedAmount: status === 'approved'
      ? Math.max(0, Math.floor(Number(raw.chargedAmount) || 0))
      : 0
  };
}

function cleanPromotions(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const item of raw) {
    const promotion = cleanPromotion(item);
    if (promotion) byId.set(promotion.id, promotion);
  }
  const all = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  // El perfil conserva un historial acotado. Las campañas que podrían mostrarse
  // son de la ventana T−30, por lo que las 100 más recientes cubren los envíos
  // actuales sin permitir que un perfil crezca sin límite.
  return all.slice(-MAX_PROMOTIONS_PER_PROFILE);
}

function isPreshowWindow(match, now = Date.now()) {
  if (!match || match.status !== 'scheduled') return false;
  const kickoff = Number(match.scheduledKickoffAt);
  if (!Number.isFinite(kickoff)) return false;
  const remaining = kickoff - Number(now);
  return remaining > 0 && remaining <= PRESHOW_WINDOW_MS;
}

function selectRotatingPromotion(promotions, now = Date.now()) {
  const approved = (Array.isArray(promotions) ? promotions : [])
    .filter(item => item && item.status === 'approved' && normalizePromotionText(item.text) && normalizePromotionPath(item.targetPath))
    .slice()
    .sort((a, b) => (Number(a.reviewedAt) || Number(a.createdAt) || 0) - (Number(b.reviewedAt) || Number(b.createdAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
  if (!approved.length) return null;
  const rotation = Math.floor(Number(now) / PROMOTION_ROTATION_MS);
  return approved[((rotation % approved.length) + approved.length) % approved.length];
}

function publicPromotion(promotion) {
  if (!promotion || promotion.status !== 'approved') return null;
  const text = normalizePromotionText(promotion.text);
  const href = normalizePromotionPath(promotion.targetPath);
  if (!text || !href) return null;
  return { id: promotion.id, label: 'Promoción pagada', text, href };
}

module.exports = {
  PROMOTION_FEE,
  PRESHOW_WINDOW_MS,
  PROMOTION_ROTATION_MS,
  MAX_PROMOTION_TEXT,
  MAX_PROMOTIONS_PER_PROFILE,
  normalizePromotionText,
  normalizePromotionPath,
  cleanPromotion,
  cleanPromotions,
  isPreshowWindow,
  selectRotatingPromotion,
  publicPromotion
};
