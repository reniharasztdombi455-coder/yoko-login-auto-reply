'use strict';

const LEAD_PLATFORMS = Object.freeze(['tiktok','metabusiness','facebook','instagram']);
const HANDOFF_PLATFORMS = Object.freeze(['line','whatsapp','telegram']);
const ALL_ROLE_PLATFORMS = Object.freeze([...LEAD_PLATFORMS, ...HANDOFF_PLATFORMS]);

function text(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}
function platformId(value='') { return text(value, 40).toLowerCase(); }
function isLeadPlatform(value='') { return LEAD_PLATFORMS.includes(platformId(value)); }
function isHandoffPlatform(value='') { return HANDOFF_PLATFORMS.includes(platformId(value)); }

function normalizeCapabilityAccount(raw={}) {
  const platform=platformId(raw.platform);
  if(!ALL_ROLE_PLATFORMS.includes(platform)) return null;
  const accountId=text(raw.accountId || raw.localAccountId || raw.id, 128);
  if(!accountId) return null;
  return {
    platform,
    accountId,
    accountName:text(raw.accountName || raw.name || raw.displayName, 160),
    loggedIn:raw.loggedIn === true,
    runtimeOpen:raw.runtimeOpen === true,
    loginState:text(raw.loginState || (raw.loggedIn === true ? 'authenticated' : 'unknown'), 40),
    checkedAt:text(raw.checkedAt,80) || new Date().toISOString()
  };
}

function normalizeNodeCapabilities(raw={}) {
  const accounts=[]; const seen=new Set();
  for(const item of Array.isArray(raw.accounts)?raw.accounts:[]){
    const normalized=normalizeCapabilityAccount(item); if(!normalized)continue;
    const key=`${normalized.platform}|${normalized.accountId}`;
    if(seen.has(key))continue; seen.add(key); accounts.push(normalized);
  }
  const logged=accounts.filter(row=>row.loggedIn);
  const leadPlatforms=[...new Set(logged.filter(row=>isLeadPlatform(row.platform)).map(row=>row.platform))];
  const handoffPlatforms=[...new Set(logged.filter(row=>isHandoffPlatform(row.platform)).map(row=>row.platform))];
  const leadAccounts=logged.filter(row=>isLeadPlatform(row.platform));
  const handoffAccounts=logged.filter(row=>isHandoffPlatform(row.platform));
  const dynamicRole=leadAccounts.length && handoffAccounts.length ? 'dual' : (leadAccounts.length ? 'lead' : (handoffAccounts.length ? 'handoff' : 'idle'));
  return {
    version:1,
    dynamicRole,
    leadPlatforms,
    handoffPlatforms,
    leadAccountCount:leadAccounts.length,
    handoffAccountCount:handoffAccounts.length,
    accounts:accounts.slice(0,120),
    updatedAt:text(raw.updatedAt,80) || new Date().toISOString()
  };
}

function dynamicRoleLabel(role='') {
  return ({lead:'引流节点',handoff:'承接节点',dual:'引流 + 承接节点',idle:'空闲节点'})[String(role||'')] || '空闲节点';
}

function loggedAccountIds(capabilities={}, platform='') {
  const p=platformId(platform);
  return new Set((Array.isArray(capabilities?.accounts)?capabilities.accounts:[])
    .filter(row=>row?.loggedIn===true && platformId(row.platform)===p)
    .map(row=>text(row.accountId,128)).filter(Boolean));
}

module.exports={
  LEAD_PLATFORMS,HANDOFF_PLATFORMS,ALL_ROLE_PLATFORMS,
  isLeadPlatform,isHandoffPlatform,normalizeCapabilityAccount,normalizeNodeCapabilities,dynamicRoleLabel,loggedAccountIds
};
