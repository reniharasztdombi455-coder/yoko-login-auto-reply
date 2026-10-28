'use strict';

function clean(value='',max=2400){return String(value??'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\s+/g,' ').trim().slice(0,max);}
function normalizedName(value=''){
  let v=clean(value,180);
  try{v=v.normalize('NFKC');}catch{}
  return v.toLocaleLowerCase().replace(/\s+/g,' ').trim();
}
function normalizedPreview(value=''){
  let v=clean(value,1200);
  try{v=v.normalize('NFKC');}catch{}
  v=v.replace(/^(?:你|您|you|me|我|自分|あなた)\s*[:：]\s*/i,'');
  v=v.replace(/[.…]{2,}$/u,'').replace(/\s+/g,' ').trim().toLocaleLowerCase();
  return v;
}
function canonicalAvatarSource(value=''){
  const raw=clean(value,4000);if(!raw)return'';
  try{const u=new URL(raw);if(u.protocol!=='https:')return'';u.hash='';u.search='';return u.toString();}catch{return'';}
}
function trustedMetaAvatarUrl(value=''){
  try{const u=new URL(clean(value,4000));if(u.protocol!=='https:')return false;const h=String(u.hostname||'').toLowerCase();return h==='facebook.com'||h.endsWith('.facebook.com')||h==='fbcdn.net'||h.endsWith('.fbcdn.net')||h==='fbsbx.com'||h.endsWith('.fbsbx.com');}catch{return false;}
}
function previewAffinity(a='',b=''){
  const x=normalizedPreview(a),y=normalizedPreview(b);if(!x||!y)return 0;if(x===y)return 100;
  const shorter=x.length<=y.length?x:y,longer=x.length<=y.length?y:x;
  if(shorter.length>=8&&longer.includes(shorter))return 92;
  let common=0;const max=Math.min(x.length,y.length);while(common<max&&x[common]===y[common])common++;
  if(common>=16)return 88;if(common>=10&&common/Math.max(1,Math.min(x.length,y.length))>=.72)return 82;
  return 0;
}
function candidateIdentity(row={}){
  const name=normalizedName(row.name||row.displayName);const avatarSource=canonicalAvatarSource(row.avatarUrl||row.avatarSourceUrl);if(!name||!avatarSource)return'';
  return `${name}|${avatarSource}`;
}
function uniqueByAvatar(rows=[]){
  const map=new Map();for(const row of rows){const key=String(row?.avatarFile||row?.avatarSourceBase||row?.avatarUrl||'').trim();if(!key)continue;const old=map.get(key);if(!old||Number(row?.updatedAt||row?.capturedAt||0)>Number(old?.updatedAt||old?.capturedAt||0))map.set(key,row);}return [...map.values()];
}
function chooseMetaNativeAvatarCandidate(target={},candidates=[],allTargets=[]){
  const name=normalizedName(target.displayName||target.name);if(!name)return null;
  const pool=uniqueByAvatar((Array.isArray(candidates)?candidates:[]).filter(row=>normalizedName(row?.name||row?.displayName)===name&&String(row?.avatarLocalUrl||row?.avatarFile||'').trim()));
  if(!pool.length)return null;
  const scored=pool.map(row=>({row,score:previewAffinity(target.preview,row.preview)})).sort((a,b)=>b.score-a.score||Number(b.row?.updatedAt||b.row?.capturedAt||0)-Number(a.row?.updatedAt||a.row?.capturedAt||0));
  if(scored[0]?.score>=82&&(scored.length===1||scored[0].score>scored[1].score))return scored[0].row;
  if(pool.length===1){
    const sameNameTargets=(Array.isArray(allTargets)?allTargets:[]).filter(item=>String(item?.platform||'').toLowerCase()==='facebook'&&normalizedName(item?.displayName||item?.name)===name);
    // V1.27.93: when the exact normalized name exists exactly once in the full
    // Official API customer list AND exactly once in the captured Meta avatar
    // candidates, that pair is deterministic. Meta's native preview frequently
    // lags/normalizes differently from Conversations API, so forcing preview
    // equality here caused every visually obvious avatar to be rejected.
    // Duplicate names still require the strong preview path above; never guess.
    if(sameNameTargets.length===1)return pool[0];
  }
  return null;
}
module.exports={clean,normalizedName,normalizedPreview,canonicalAvatarSource,trustedMetaAvatarUrl,previewAffinity,candidateIdentity,chooseMetaNativeAvatarCandidate};
