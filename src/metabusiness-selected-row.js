'use strict';
const { metaBusinessCanonicalChatId, metaBusinessPlausibleCustomerName } = require('./metabusiness-inbox-acquisition');

function clean(value,max=500){return String(value??'').replace(/\u0000/g,'').replace(/\s+/g,' ').trim().slice(0,max)}
function ensureSelectedMetaBusinessRow(rows=[],selected=null){
  const out=Array.isArray(rows)?rows.filter(Boolean).slice():[];
  if(!selected||typeof selected!=='object')return out;
  const name=clean(selected.name||selected.displayName,180);
  if(!name||!metaBusinessPlausibleCustomerName(name))return out;
  const nameKey=name.toLocaleLowerCase();
  const canonical=metaBusinessCanonicalChatId(selected.chatId||selected.url||'');
  const exists=out.some(row=>{
    const rn=clean(row?.name||row?.displayName,180).toLocaleLowerCase();
    const rc=metaBusinessCanonicalChatId(row?.chatId||row?.href||'');
    return (!!nameKey&&rn===nameKey)||(!!canonical&&rc===canonical);
  });
  if(exists)return out;
  // No visual rank is invented. Appending means a header-only fallback keeps the
  // customer present without claiming it is at the native top. If preload found
  // the actual active row geometry, that row already exists and this path is not used.
  out.push({
    chatId:clean(selected.chatId,500)||`name:${name}`,
    name,
    handle:clean(selected.handle,180).replace(/^@/,''),
    avatarUrl:clean(selected.avatarUrl,2600),
    preview:'',timeText:'',lastDirection:'',unreadCount:0,
    href:clean(selected.url,1800),
    nativeSnapshotRank:out.length,
    selectedIdentityFallback:true
  });
  return out;
}
module.exports={ensureSelectedMetaBusinessRow};
