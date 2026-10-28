'use strict';

const LEAD_AUTH_COOKIE_NAMES = Object.freeze({
  tiktok:new Set(['sessionid','sessionid_ss','sid_tt','sid_guard','uid_tt','uid_tt_ss']),
  facebook:new Set(['c_user']),
  metabusiness:new Set(['c_user']),
  instagram:new Set(['sessionid'])
});

function platformKey(value='') { return String(value || '').trim().toLowerCase(); }
function isLeadCapabilityPlatform(platform='') { return !!LEAD_AUTH_COOKIE_NAMES[platformKey(platform)]; }
function authCookieNameRelevant(platform='', name='') {
  const wanted=LEAD_AUTH_COOKIE_NAMES[platformKey(platform)];
  return !!wanted && wanted.has(String(name || '').trim().toLowerCase());
}
function authCookiePresentFromRows(platform='', rows=[], nowSeconds=Date.now()/1000) {
  const wanted=LEAD_AUTH_COOKIE_NAMES[platformKey(platform)];
  if (!wanted) return false;
  const now=Number(nowSeconds || 0) || 0;
  return (Array.isArray(rows) ? rows : []).some(cookie => {
    if (!wanted.has(String(cookie?.name || '').trim().toLowerCase())) return false;
    if (!String(cookie?.value || '').length) return false;
    const expiry=Number(cookie?.expirationDate || 0);
    if (expiry > 0 && now > 0 && expiry <= now) return false;
    return true;
  });
}
function leadCapabilityFromEvidence({ platform='', runtimeOpen=false, loaded=false, routeOk=false, page={}, authCookie=false }={}) {
  if (!isLeadCapabilityPlatform(platform) || runtimeOpen !== true) return false;
  // Once a loaded page explicitly presents a login form, that visible state
  // wins over a stale cookie. Before load completes, a valid auth cookie can
  // bridge the renderer hydration gap and restore the node capability.
  if (loaded && page?.loginLike === true) return false;
  if (authCookie === true) return true;
  if (!loaded) return false;
  return routeOk === true || page?.shellLike === true;
}

module.exports={
  LEAD_AUTH_COOKIE_NAMES,
  isLeadCapabilityPlatform,
  authCookieNameRelevant,
  authCookiePresentFromRows,
  leadCapabilityFromEvidence
};
