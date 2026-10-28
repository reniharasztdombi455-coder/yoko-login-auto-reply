'use strict';

const { lineIdentityAliases, lineIdentityMatches } = require('./team-sync-core');

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}
function logical(value='') {
  return text(value,180).toLowerCase().replace(/^@+/, '').replace(/[·•・\s]+/g,'').trim();
}
function pickLineAccountIdForTask({ requestedAccountId='', activeAccountId='', targetLineLogicalKey='', targetLineAccountName='', endpoints=[] }={}) {
  const requested=text(requestedAccountId,128);
  if (requested) return requested;
  const targetValues=[targetLineLogicalKey,targetLineAccountName];
  const matches=(Array.isArray(endpoints)?endpoints:[]).filter(ep => lineIdentityMatches(targetValues,[ep?.logicalKey,ep?.mappedName,ep?.displayName,ep?.localAccountId]));
  if (matches.length===1 && text(matches[0]?.localAccountId,128)) return text(matches[0].localAccountId,128);
  return text(activeAccountId,128);
}
function describeLineAccountIdentity({ task={}, endpoint={}, accountId='', activeAccountId='' }={}) {
  const targetAliases=lineIdentityAliases([task?.targetLineLogicalKey,task?.targetLineAccountName]);
  const endpointAliases=lineIdentityAliases([endpoint?.logicalKey,endpoint?.mappedName,endpoint?.displayName,endpoint?.localAccountId]);
  return {
    matches:lineIdentityMatches([task?.targetLineLogicalKey,task?.targetLineAccountName],[endpoint?.logicalKey,endpoint?.mappedName,endpoint?.displayName,endpoint?.localAccountId]),
    targetAliases, endpointAliases, accountId:text(accountId,128), activeAccountId:text(activeAccountId,128),
    targetLabel:text(task?.targetLineAccountName||task?.targetLineLogicalKey,220),
    mappedName:text(endpoint?.mappedName||endpoint?.displayName,180)
  };
}
function resolveLineChatIdentity({ bridge={}, hint=null, noChatHint=null, now=Date.now(), hintMaxAgeMs=20000 }={}) {
  const noChatFresh=!!noChatHint && now-Number(noChatHint.at||0) <= Math.min(7000, hintMaxAgeMs);
  if (noChatFresh) return { ok:false, chatId:'', displayName:'', source:'no-chat-hint', bridgeChatId:text(bridge?.chatId,256) };
  const bridgeChatId=text(bridge?.chatId,256);
  const bridgeName=text(bridge?.displayName || bridge?.visibleDisplayName || bridge?.routeDisplayName,160);
  const hintFresh=!!hint && now-Number(hint.at||0) <= hintMaxAgeMs && text(hint?.chatId,256);
  if (hintFresh) {
    const hintId=text(hint.chatId,256);
    const hintName=text(hint.displayName,160);
    if (!bridgeChatId || bridgeChatId!==hintId) {
      return { ok:true, chatId:hintId, displayName:hintName || bridgeName, source:'selection-hint', bridgeChatId, bridgeDisplayName:bridgeName };
    }
  }
  if (bridgeChatId || bridgeName) return { ok:true, chatId:bridgeChatId, displayName:bridgeName, source:'bridge', bridgeChatId, bridgeDisplayName:bridgeName };
  return { ok:false, chatId:'', displayName:'', source:'none', bridgeChatId:'', bridgeDisplayName:'' };
}
function inheritChatgptState({ bindings={}, customerReplySettings={}, sourceTargetKey='', destinationTargetKey='' }={}) {
  const src=text(sourceTargetKey,800); const dst=text(destinationTargetKey,800);
  if (!src || !dst || src===dst) return { bindingInherited:false, replySettingInherited:false };
  let bindingInherited=false, replySettingInherited=false;
  if (!bindings[dst] && bindings[src] && typeof bindings[src]==='object') {
    bindings[dst]={ ...bindings[src], inheritedFromTargetKey:src, inheritedAt:new Date().toISOString() };
    bindingInherited=true;
  }
  if (!customerReplySettings[dst] && customerReplySettings[src] && typeof customerReplySettings[src]==='object') {
    customerReplySettings[dst]={ ...customerReplySettings[src], inheritedFromTargetKey:src, updatedAt:Date.now() };
    replySettingInherited=true;
  }
  return { bindingInherited, replySettingInherited };
}


function synchronizeHandoffChatgptState({ bindings={}, customerReplySettings={}, sourceTargetKey='', destinationTargetKey='', sourceBinding=null, taskId='', nowIso='' }={}) {
  const src=text(sourceTargetKey,800); const dst=text(destinationTargetKey,800);
  if (!src || !dst || src===dst) return { sourceBindingFound:false, bindingInherited:false, bindingReplacedExisting:false, bindingAlreadySame:false, replySettingInherited:false, destinationBindingExisting:false };
  const rawSource=(sourceBinding && typeof sourceBinding==='object') ? sourceBinding : ((bindings[src] && typeof bindings[src]==='object') ? bindings[src] : null);
  const srcUrl=text(rawSource?.url,2400);
  const destinationBefore=(bindings[dst] && typeof bindings[dst]==='object') ? bindings[dst] : null;
  const destinationUrlBefore=text(destinationBefore?.url,2400);
  const stamp=text(nowIso,80) || new Date().toISOString();
  let bindingInherited=false, bindingReplacedExisting=false, bindingAlreadySame=false, replySettingInherited=false;
  if (rawSource && srcUrl) {
    const { targetKey:_targetKey, inherited:_inherited, ...sourceBase } = rawSource;
    if (!destinationBefore) {
      bindings[dst]={ ...sourceBase, inheritedFromTargetKey:src, inheritedAt:stamp, handoffTaskId:text(taskId,120), handoffSyncedAt:stamp };
      bindingInherited=true;
    } else if (destinationUrlBefore === srcUrl) {
      bindingAlreadySame=true;
    } else {
      bindings[dst]={
        ...sourceBase,
        inheritedFromTargetKey:src,
        inheritedAt:stamp,
        handoffTaskId:text(taskId,120),
        handoffSyncedAt:stamp,
        handoffReplacedExisting:true,
        previousDestinationBinding:{ ...destinationBefore }
      };
      bindingReplacedExisting=true;
    }
  }
  if (!customerReplySettings[dst] && customerReplySettings[src] && typeof customerReplySettings[src]==='object') {
    customerReplySettings[dst]={ ...customerReplySettings[src], inheritedFromTargetKey:src, updatedAt:Date.now() };
    replySettingInherited=true;
  }
  return {
    sourceBindingFound:!!(rawSource && srcUrl),
    bindingInherited,
    bindingReplacedExisting,
    bindingAlreadySame,
    replySettingInherited,
    destinationBindingExisting:!!destinationBefore,
    sourceUrl:srcUrl,
    destinationUrlBefore,
    destinationUrlAfter:text(bindings[dst]?.url,2400)
  };
}

function verifyLocalLineHandoffCommit({ task={}, contact={}, markedTask={}, accountId='', chatId='', displayName='', identitySource='', gptContinuity={}, sourceBindingRequired=false, destinationBindingPresent=false }={}) {
  const expectedTaskId=text(task?.taskId,120);
  const expectedGlobal=text(task?.globalCustomerId,120);
  const expectedAccount=text(accountId,128);
  const expectedChat=text(chatId,256);
  const expectedName=text(displayName,160);
  const checks={
    lineIdentity:!!(expectedAccount && (expectedChat || expectedName)),
    crmBound:!!contact && text(contact?.accountId,128)===expectedAccount && (!expectedChat || text(contact?.chatId,256)===expectedChat) && (!expectedGlobal || text(contact?.globalCustomerId,120)===expectedGlobal) && (!expectedTaskId || text(contact?._teamSync?.taskId,120)===expectedTaskId),
    taskBound:!!markedTask && text(markedTask?.status,40)==='bound' && text(markedTask?.boundLineAccountId,128)===expectedAccount && (!expectedChat || text(markedTask?.boundLineChatId,256)===expectedChat),
    gptContinuity:sourceBindingRequired ? !!destinationBindingPresent : true
  };
  const ok=Object.values(checks).every(Boolean);
  return { ok, checks, identitySource:text(identitySource,60), gptContinuity:{...gptContinuity, sourceBindingRequired:!!sourceBindingRequired, destinationBindingPresent:!!destinationBindingPresent} };
}
function verifyRemoteLineHandoffCommit({ task={}, expectedAccountId='', expectedChatId='', localDeviceId='' }={}) {
  const row=task&&typeof task==='object'?task:{};
  const checks={
    taskPresent:!!text(row?.taskId,120),
    statusBound:['bound','completed'].includes(text(row?.status,40)),
    sameDevice:!text(localDeviceId,120) || text(row?.assignedDeviceId,120)===text(localDeviceId,120),
    sameLineAccount:!text(expectedAccountId,128) || text(row?.boundLineAccountId,128)===text(expectedAccountId,128),
    sameLineChat:!text(expectedChatId,256) || text(row?.boundLineChatId,256)===text(expectedChatId,256)
  };
  return { ok:Object.values(checks).every(Boolean), checks };
}

module.exports={ pickLineAccountIdForTask, describeLineAccountIdentity, resolveLineChatIdentity, inheritChatgptState, synchronizeHandoffChatgptState, verifyLocalLineHandoffCommit, verifyRemoteLineHandoffCommit };
