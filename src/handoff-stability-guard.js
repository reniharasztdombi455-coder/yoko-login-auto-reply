'use strict';

function text(value, max = 1000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function targetKey(platform='', accountId='', identity='') {
  return [text(platform,40).toLowerCase(), text(accountId,160), text(identity,400)].join(':');
}

function isChatgptConversationUrl(value='') {
  try {
    const u = new URL(String(value || ''));
    if (u.hostname !== 'chatgpt.com' && !u.hostname.endsWith('.chatgpt.com')) return false;
    return /\/c\/[^/?#]+/i.test(u.pathname) || /\/g\/[^/]+\/c\/[^/?#]+/i.test(u.pathname) || /\/project\/[^/]+\/c\/[^/?#]+/i.test(u.pathname);
  } catch { return false; }
}

function conversationRef(value='') {
  try {
    const u = new URL(String(value || ''));
    const match = u.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
    return match ? `c/${match[1]}` : '';
  } catch { return ''; }
}

function sourceTargetKeyForTask(task={}) {
  const customer = task?.customer && typeof task.customer === 'object' ? task.customer : {};
  const platform = text(task?.sourcePlatform || customer?.sourcePlatform,40).toLowerCase();
  const accountId = text(task?.sourceAccountId || customer?.sourceAccountId,160);
  const identity = text(task?.sourceChatId || customer?.sourceChatId || task?.sourceHandle || customer?.sourceHandle || task?.sourceDisplayName || customer?.sourceDisplayName,400).replace(/^@+/, '');
  return targetKey(platform, accountId, identity);
}

function destinationTargetKeyForTask(task={}) {
  return targetKey('line', text(task?.boundLineAccountId,160), text(task?.boundLineChatId || task?.boundLineDisplayName,400));
}

function sourceBindingForTask(bindings={}, contacts={}, task={}) {
  const directKey=sourceTargetKeyForTask(task);
  const direct=bindings?.[directKey];
  if (direct && typeof direct==='object' && direct.url) return {key:directKey,row:direct};
  const customer=task?.customer && typeof task.customer==='object'?task.customer:{};
  const globalCustomerId=text(task?.globalCustomerId || customer?.globalCustomerId,160);
  const platform=text(task?.sourcePlatform || customer?.sourcePlatform,40).toLowerCase();
  const accountId=text(task?.sourceAccountId || customer?.sourceAccountId,160);
  const sourceChatId=text(task?.sourceChatId || customer?.sourceChatId,400);
  const sourceDisplayName=text(task?.sourceDisplayName || customer?.sourceDisplayName,240);
  const sourceContact=Object.values(contacts && typeof contacts==='object'?contacts:{}).find(row=>{
    if(!row||typeof row!=='object')return false;
    const rowGlobal=text(row?.globalCustomerId || row?.crossPlatform?.globalCustomerId,160);
    return (!globalCustomerId || rowGlobal===globalCustomerId) && text(row?.platform,40).toLowerCase()===platform && (!accountId || text(row?.accountId,160)===accountId);
  }) || null;
  if(sourceContact){
    const contactKey=targetKey(platform,text(sourceContact?.accountId || accountId,160),text(sourceContact?.chatId || sourceContact?.handle || sourceContact?.displayName,400));
    const row=bindings?.[contactKey];
    if(row&&typeof row==='object'&&row.url)return {key:contactKey,row};
  }
  for(const [key,row] of Object.entries(bindings && typeof bindings==='object'?bindings:{})){
    if(!row||typeof row!=='object'||!row.url)continue;
    if(text(row?.platform,40).toLowerCase()!==platform)continue;
    if(accountId && text(row?.accountId,160)!==accountId)continue;
    if(sourceChatId && text(row?.chatId,400)===sourceChatId)return {key,row};
    if(sourceDisplayName && text(row?.displayName,240)===sourceDisplayName)return {key,row};
  }
  return {key:directKey,row:null};
}

function contactForBoundTask(contacts={}, task={}) {
  const rows = Object.values(contacts && typeof contacts === 'object' ? contacts : {}).filter(row => row && typeof row === 'object');
  const taskId = text(task?.taskId,160);
  const globalCustomerId = text(task?.globalCustomerId || task?.customer?.globalCustomerId,160);
  const accountId = text(task?.boundLineAccountId,160);
  const chatId = text(task?.boundLineChatId,400);
  let best = null;
  let score = -1;
  for (const row of rows) {
    let s = 0;
    if (text(row?.platform,40).toLowerCase() === 'line') s += 1;
    if (accountId && text(row?.accountId,160) === accountId) s += 3;
    if (chatId && text(row?.chatId,400) === chatId) s += 5;
    if (taskId && text(row?._teamSync?.taskId,160) === taskId) s += 8;
    if (globalCustomerId && text(row?.globalCustomerId || row?.crossPlatform?.globalCustomerId,160) === globalCustomerId) s += 6;
    if (s > score) { score = s; best = row; }
  }
  return score >= 8 ? best : null;
}

function inspectHandoffIntegrity({ tasks=[], contacts={}, bindings={}, lineAccounts=[], deviceId='', continuityVersion='1.25.9' }={}) {
  const accountIds = new Set((Array.isArray(lineAccounts) ? lineAccounts : []).map(row => text(row?.id || row?.localAccountId,160)).filter(Boolean));
  const localDevice = text(deviceId,160);
  const rows = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !['bound','completed'].includes(text(task?.status,40))) continue;
    if (localDevice && text(task?.assignedDeviceId,160) && text(task?.assignedDeviceId,160) !== localDevice) continue;
    const contact = contactForBoundTask(contacts, task);
    const taskId = text(task?.taskId,160);
    const globalCustomerId = text(task?.globalCustomerId || task?.customer?.globalCustomerId,160);
    const accountId = text(task?.boundLineAccountId,160);
    const chatId = text(task?.boundLineChatId,400);
    const sourceResolved = sourceBindingForTask(bindings, contacts, task);
    const sourceKey = sourceResolved.key || sourceTargetKeyForTask(task);
    const destinationKey = destinationTargetKeyForTask(task);
    const sourceBinding = sourceResolved.row;
    const destinationBinding = bindings?.[destinationKey] && typeof bindings[destinationKey] === 'object' ? bindings[destinationKey] : null;
    const sourceHasGpt = !!(sourceBinding?.url && isChatgptConversationUrl(sourceBinding.url));
    const destinationHasGpt = !!(destinationBinding?.url && isChatgptConversationUrl(destinationBinding.url));
    const exactGptConversation = !sourceHasGpt || (destinationHasGpt && String(sourceBinding.url) === String(destinationBinding.url));
    const checks = {
      lineAccountPresent: !accountId ? false : (accountIds.size ? accountIds.has(accountId) : true),
      lineChatBound: !!(accountId && (chatId || text(task?.boundLineDisplayName,200))),
      crmPresent: !!contact,
      crmGlobalMatch: !!contact && (!globalCustomerId || text(contact?.globalCustomerId || contact?.crossPlatform?.globalCustomerId,160) === globalCustomerId),
      crmTaskMatch: !!contact && (!taskId || text(contact?._teamSync?.taskId,160) === taskId),
      localCommitVerified: !!contact && text(contact?._teamSync?.localCommitState,60) === 'verified',
      gptDestinationPresent: sourceHasGpt ? destinationHasGpt : true,
      gptConversationExact: exactGptConversation,
      gptContinuityMarked: sourceHasGpt ? (!!contact && text(contact?._teamSync?.gptContinuityVersion,40) === text(continuityVersion,40)) : true
    };
    const issues = Object.entries(checks).filter(([,ok]) => !ok).map(([key]) => key);
    rows.push({
      taskId, globalCustomerId, status:text(task?.status,40), accountId, chatId,
      sourceTargetKey:sourceKey, destinationTargetKey:destinationKey,
      sourceConversation:conversationRef(sourceBinding?.url), destinationConversation:conversationRef(destinationBinding?.url),
      sourceHasGpt, destinationHasGpt, checks, issues, ok:issues.length===0
    });
  }
  const failed = rows.filter(row => !row.ok);
  const issueCounts = {};
  for (const row of failed) for (const code of row.issues) issueCounts[code] = Number(issueCounts[code] || 0) + 1;
  return {
    version:'1.25.11', at:new Date().toISOString(), ok:failed.length===0,
    counts:{ boundTasks:rows.length, healthy:rows.length-failed.length, unhealthy:failed.length },
    issueCounts, rows
  };
}

module.exports = {
  text, targetKey, isChatgptConversationUrl, conversationRef,
  sourceTargetKeyForTask, destinationTargetKeyForTask, sourceBindingForTask, contactForBoundTask,
  inspectHandoffIntegrity
};
