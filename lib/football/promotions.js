'use strict';

// La Previa: promociones de texto e imágenes con rutas internas permitidas. El anuncio se
// conserva en el perfil vinculado de quien lo envió; no contiene URLs
// externas y no forma parte de la proyección pública del perfil.
const PROMOTION_FEE = 250;
const PRESHOW_WINDOW_MS = 30 * 60 * 1000;
const PROMOTION_ROTATION_MS = 15 * 1000;
const MAX_PROMOTION_TEXT = 140;
const MAX_PROMOTIONS_PER_PROFILE = 100;
const PROMOTION_STATUSES = new Set(['pending', 'approved', 'rejected']);
const VALID_TEXT_POSITIONS = new Set(['top', 'bottom', 'overlay', 'middle', 'badge', 'hidden']);
const VALID_TEXT_SIZES = new Set(['small', 'medium', 'large']);
const VALID_TEXT_ALIGNS = new Set(['left', 'center', 'right']);
const VALID_SCOPES = new Set(['single', 'all', 'count']);
const { MEDIA_NAME } = require('./promotion-media');

function normalizePromotionText(value, { required = true } = {}) {
  if (value === undefined || value === null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return required ? null : '';
  if (text.length > MAX_PROMOTION_TEXT || /[<>]/.test(text)) return null;
  if (required && text.length < 3) return null;
  return text;
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
  const status = PROMOTION_STATUSES.has(raw.status) ? raw.status : null;
  const createdAt = Number(raw.createdAt);
  const imageFile = typeof raw.imageFile === 'string' && MEDIA_NAME.test(raw.imageFile) ? raw.imageFile : null;
  const hasImage = Boolean(imageFile);

  const text = normalizePromotionText(raw.text, { required: !hasImage });
  const targetPath = normalizePromotionPath(raw.targetPath);
  if (!id || !matchId || text === null || !targetPath || !status || !Number.isFinite(createdAt) || createdAt <= 0) return null;

  const rawScope = typeof raw.scope === 'string' ? raw.scope.toLowerCase() : '';
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : (raw.isPermanent ? 'all' : 'single');
  const isPermanent = scope === 'all' || Boolean(raw.isPermanent);
  const matchesTotal = Number(raw.matchesTotal) > 0 ? Math.floor(Number(raw.matchesTotal)) : null;
  const matchesRemaining = Number(raw.matchesRemaining) >= 0
    ? Math.floor(Number(raw.matchesRemaining))
    : (scope === 'count' ? (matchesTotal || 1) : null);

  const textPosition = VALID_TEXT_POSITIONS.has(raw.textPosition)
    ? raw.textPosition
    : (text ? 'bottom' : 'hidden');
  const textSize = VALID_TEXT_SIZES.has(raw.textSize) ? raw.textSize : 'medium';
  const textAlign = VALID_TEXT_ALIGNS.has(raw.textAlign) ? raw.textAlign : 'left';
  const ctaText = typeof raw.ctaText === 'string' ? raw.ctaText.replace(/[<>]/g, '').trim().slice(0, 30) : null;
  const themeColor = typeof raw.themeColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw.themeColor) ? raw.themeColor : null;

  const reviewedAt = Number(raw.reviewedAt);
  return {
    id,
    matchId,
    scope,
    isPermanent,
    matchesTotal,
    matchesRemaining,
    text: text || '',
    textPosition,
    textSize,
    textAlign,
    ctaText: ctaText || null,
    themeColor: themeColor || null,
    targetPath,
    status,
    createdAt: Math.floor(createdAt),
    reviewedAt: Number.isFinite(reviewedAt) && reviewedAt > 0 ? Math.floor(reviewedAt) : null,
    reviewedBy: typeof raw.reviewedBy === 'string' ? raw.reviewedBy.slice(0, 80) : null,
    reviewReason: typeof raw.reviewReason === 'string' ? raw.reviewReason.trim().slice(0, 500) : null,
    imageFile,
    imageMime: raw.imageMime === 'image/png' || raw.imageMime === 'image/jpeg' ? raw.imageMime : null,
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
    .filter(item => {
      if (!item || item.status !== 'approved') return false;
      const hasImage = Boolean(item.imageFile);
      const text = normalizePromotionText(item.text, { required: !hasImage });
      const targetPath = normalizePromotionPath(item.targetPath);
      return text !== null && targetPath !== null;
    })
    .slice()
    .sort((a, b) => (Number(a.reviewedAt) || Number(a.createdAt) || 0) - (Number(b.reviewedAt) || Number(b.createdAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
  if (!approved.length) return null;
  const rotation = Math.floor(Number(now) / PROMOTION_ROTATION_MS);
  return approved[((rotation % approved.length) + approved.length) % approved.length];
}

function publicPromotion(promotion) {
  if (!promotion || promotion.status !== 'approved') return null;
  const hasImage = Boolean(promotion.imageFile);
  const text = normalizePromotionText(promotion.text, { required: !hasImage });
  const href = normalizePromotionPath(promotion.targetPath);
  if (text === null || !href) return null;
  const image = promotion.imageFile ? `/api/estadio/promotion-media/${encodeURIComponent(promotion.id)}` : null;
  const isPermanent = Boolean(promotion.isPermanent || promotion.scope === 'all');
  const label = isPermanent
    ? 'Patrocinador Oficial'
    : (promotion.scope === 'count' ? 'Campaña Destacada' : 'Promoción pagada');
  return {
    id: promotion.id,
    label,
    text: text || '',
    textPosition: promotion.textPosition || (text ? 'bottom' : 'hidden'),
    textSize: promotion.textSize || 'medium',
    textAlign: promotion.textAlign || 'left',
    ctaText: promotion.ctaText || 'Ver más',
    themeColor: promotion.themeColor || null,
    href,
    image,
    isPermanent,
    scope: promotion.scope || 'single',
    matchesRemaining: promotion.matchesRemaining != null ? promotion.matchesRemaining : null
  };
}

module.exports = {
  PROMOTION_FEE,
  PRESHOW_WINDOW_MS,
  PROMOTION_ROTATION_MS,
  MAX_PROMOTION_TEXT,
  MAX_PROMOTIONS_PER_PROFILE,
  VALID_TEXT_POSITIONS,
  VALID_TEXT_SIZES,
  VALID_TEXT_ALIGNS,
  VALID_SCOPES,
  normalizePromotionText,
  normalizePromotionPath,
  cleanPromotion,
  cleanPromotions,
  isPreshowWindow,
  selectRotatingPromotion,
  publicPromotion
};
