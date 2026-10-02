'use strict';
const crypto=require('node:crypto');
const TTL_MS=15*60*1000;
function hashToken(token,pepper){return crypto.createHmac('sha256',Buffer.from(pepper,'base64')).update(`password-reset:${token}`).digest('hex');}
class MemoryPasswordResetStore{constructor(pepper){this.pepper=pepper;this.items=new Map();}async create(profileId,createdBy,reason,now=Date.now()){for(const item of this.items.values())if(item.profileId===profileId&&!item.consumedAt)item.consumedAt=now;const token=crypto.randomBytes(32).toString('base64url');const item={id:crypto.randomUUID(),profileId,createdBy,reason,tokenHash:hashToken(token,this.pepper),createdAt:now,expiresAt:now+TTL_MS,consumedAt:null};this.items.set(item.id,item);return{token,challenge:{...item,tokenHash:undefined}};}async consume(token,now=Date.now()){const hash=hashToken(token,this.pepper);const item=[...this.items.values()].find(value=>value.tokenHash===hash);if(!item||item.consumedAt||item.expiresAt<=now)return null;item.consumedAt=now;return{...item,tokenHash:undefined};}async close(){}}
module.exports={TTL_MS,hashToken,MemoryPasswordResetStore};
