'use strict';
const crypto=require('node:crypto');
function createAction(input){const reason=String(input.reason||'').trim();if(reason.length<10||reason.length>500)throw new Error('Motivo inválido');return{id:input.id||crypto.randomUUID(),targetProfileId:String(input.targetProfileId),actorProfileId:String(input.actorProfileId),reportId:input.reportId||null,type:input.type,reason,startsAt:input.startsAt||Date.now(),endsAt:input.endsAt||null,metadata:input.metadata||{}};}
class MemoryModerationStore{constructor(){this.actions=[];}async append(input){const action=createAction(input);this.actions.push(action);return{...action};}async forProfile(id){return this.actions.filter(a=>a.targetProfileId===id).map(a=>({...a}));}}
module.exports={createAction,MemoryModerationStore};
