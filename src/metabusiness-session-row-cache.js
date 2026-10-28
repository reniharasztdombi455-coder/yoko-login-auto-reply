'use strict';

const { metaBusinessPlausibleCustomerName } = require('./metabusiness-inbox-acquisition');
const { stableRowKey, rankForRow } = require('./metabusiness-stable-mirror');

function clean(value,max=1800){return String(value??'').replace(/\u0000/g,'').replace(/\s+/g,' ').trim().slice(0,max)}

function mergeSessionRow(oldRow={}, nextRow={}) {
  return {
    ...oldRow,
    ...nextRow,
    name:clean(nextRow.name || nextRow.displayName || oldRow.name || oldRow.displayName,180),
    displayName:clean(nextRow.displayName || nextRow.name || oldRow.displayName || oldRow.name,180),
    preview:clean(nextRow.preview || nextRow.lastMessage || oldRow.preview || oldRow.lastMessage,900),
    lastMessage:clean(nextRow.lastMessage || nextRow.preview || oldRow.lastMessage || oldRow.preview,900),
    avatarUrl:clean(nextRow.avatarUrl || oldRow.avatarUrl,2600),
    chatId:clean(nextRow.chatId || oldRow.chatId,500),
    href:clean(nextRow.href || oldRow.href,1800),
    timeText:clean(nextRow.timeText || oldRow.timeText,100),
    lastDirection:clean(nextRow.lastDirection || oldRow.lastDirection,20),
    unreadCount:Math.max(0,Number(nextRow.unreadCount ?? oldRow.unreadCount ?? 0)||0),
    sessionSeenAt:Date.now()
  };
}

function updateMetaBusinessSessionRows(previous=null, rows=[], stableState={}) {
  const cache = previous instanceof Map ? new Map(previous) : new Map();
  for (const row of Array.isArray(rows)?rows:[]) {
    const name=clean(row?.name || row?.displayName,180);
    if (!metaBusinessPlausibleCustomerName(name)) continue;
    const key=stableRowKey(row);
    if (!key) continue;
    cache.set(key,mergeSessionRow(cache.get(key)||{},row));
  }
  // Keep only identities still owned by the stable session order.  This bounds
  // memory and prevents ancient aliases from leaking into the visual mirror.
  const allowed=new Set(Array.isArray(stableState?.order)?stableState.order:[]);
  if (allowed.size) for (const key of cache.keys()) if (!allowed.has(key)) cache.delete(key);
  while (cache.size>1000) cache.delete(cache.keys().next().value);
  return cache;
}

function metaBusinessSessionRowsInStableOrder(cache=null, stableState={}) {
  const rows=[];
  if (!(cache instanceof Map)) return rows;
  for (const row of cache.values()) {
    const rank=rankForRow(stableState,row);
    rows.push({...row,nativeStableRank:rank});
  }
  rows.sort((a,b)=>{
    const ar=rankForRow(stableState,a), br=rankForRow(stableState,b);
    if(ar!==null||br!==null){if(ar===null)return 1;if(br===null)return -1;if(ar!==br)return ar-br;}
    return clean(a.name||a.displayName,180).localeCompare(clean(b.name||b.displayName,180),'zh-CN',{numeric:true});
  });
  return rows;
}

module.exports={updateMetaBusinessSessionRows,metaBusinessSessionRowsInStableOrder};
