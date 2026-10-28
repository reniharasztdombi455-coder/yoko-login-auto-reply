const api=window.copyApi||{};
const pasteBtn=document.querySelector('#pasteBtn');
const clearBtn=document.querySelector('#clearBtn');
const copyBtn=document.querySelector('#copyBtn');
const sendBtn=document.querySelector('#sendBtn');
const buttons=[pasteBtn,clearBtn,copyBtn,sendBtn].filter(Boolean);
const busyButtons=new Set();
let refreshBusy=false;
let lastState={};

function pulse(btn,kind){
  if(!btn)return;
  btn.classList.remove('ok','error');
  void btn.offsetWidth;
  btn.classList.add(kind);
  setTimeout(()=>btn.classList.remove(kind),650);
}
function setButtonBusy(btn,value,busyText=''){
  if(!btn)return;
  if(value){
    busyButtons.add(btn);
    btn.disabled=true;
    if(busyText)btn.textContent=busyText;
  }else{
    busyButtons.delete(btn);
    btn.disabled=btn===sendBtn&&btn.dataset.yokoQueued==='1';
  }
}
function invokeWithTimeout(promise,ms,label){
  if(!ms)return Promise.resolve(promise);
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label||'操作'}超时，请再试一次。`)),ms))
  ]);
}
function safeInvoke(name,args=[],timeoutMs=0,label='操作'){
  const fn=api&&typeof api[name]==='function'?api[name]:null;
  if(!fn)return Promise.reject(new Error(`${label}通道未就绪，请关闭并重新打开 GPT 工作台。`));
  return invokeWithTimeout(fn(...args),timeoutMs,label);
}
function sendFailureLabel(result){
  const r=result||{},error=String(r?.error||'');
  if(r?.targetChanged||/客户.*切换|聊天对象已经变化/.test(error))return '客户已切换';
  if(r?.unbound||/没有绑定 GPT|尚未绑定 GPT/.test(error))return 'GPT未绑定';
  if(/绑定不一致|对话和客户绑定不一致/.test(error))return '绑定不一致';
  if(r?.emptyDraft||/没有可发送内容|没有识别到.*日语|没有识别到可直接发送/.test(error))return '无可发送正文';
  if(/没有找到.*输入框|读取不到.*输入框|当前聊天页面不可用/.test(error))return '未找到输入框';
  if(r?.draftConflict||/已有.*未发送.*内容|避免覆盖草稿/.test(error))return '已有草稿';
  return '发送失败';
}

async function refresh(){
  if(refreshBusy)return;
  refreshBusy=true;
  try{
    const s=await safeInvoke('state',[],3500,'GPT状态读取');
    lastState=s||{};
    const ready=!!s?.ready,sendReady=!!s?.sendReady,target=String(s?.targetName||'当前客户'),replyAlreadySent=!!s?.replyAlreadySent,replyFreshnessPending=!!s?.replyFreshnessPending,sendQueued=!!s?.sendQueued;
    if(!busyButtons.has(pasteBtn)){pasteBtn.textContent='粘贴';pasteBtn.disabled=false;}
    if(!busyButtons.has(clearBtn)){clearBtn.textContent='清空';clearBtn.disabled=false;}
    if(!busyButtons.has(copyBtn)){copyBtn.textContent='复制';copyBtn.disabled=false;}
    if(!busyButtons.has(sendBtn)){sendBtn.dataset.yokoQueued=sendQueued?'1':'0';sendBtn.textContent=sendQueued?'等待GPT…':(replyAlreadySent?'✓ 已发送':'发送');sendBtn.disabled=sendQueued;}
    pasteBtn.title='把 Windows 剪贴板里的文字粘贴到 ChatGPT 输入框（不会自动发送）';
    clearBtn.title='清空 ChatGPT 输入框里的全部文字（不会发送）';
    copyBtn.dataset.ready=ready?'1':'0';
    sendBtn.dataset.ready=sendReady?'1':'0';
    copyBtn.title=ready?'复制 GPT 最新可直接发送正文':(s?.reason==='generating'?'GPT 正在生成，点击会再次实时检查':s?.reason==='no-direct-reply'?'暂未识别到可直接发送正文，点击会实时重试':'暂时没有可复制的 GPT 回复，点击会实时重试');
    sendBtn.title=sendQueued
      ? `已记录发送意图：正在等待 GPT 完成本轮回复，完成后会自动发送给 ${target}；中途切换客户会自动取消，避免误发`
      : replyAlreadySent
      ? `这条 GPT 回复已经发送给 ${target}，再次点击不会重复发送`
      : replyFreshnessPending
      ? `${target} 的新客户消息已经送进 GPT，正在等待本轮新的 GPT 回复；上一轮旧回复不会发送`
      : sendReady
      ? `只发送 GPT 最新回复里的【适合直接发送｜客户语言】正文给 ${target}；中文对照、流程建议和其他内容都不会发送`
      : (!s?.bound?`${target} 尚未绑定 GPT；绑定完成后才能安全发送`:(s?.routeMatched===false?'当前 GPT 页面和客户绑定不一致，为避免串客户已禁用发送':copyBtn.title));
  }catch(error){
    for(const btn of buttons){if(!busyButtons.has(btn))btn.disabled=false;}
    if(!busyButtons.has(pasteBtn))pasteBtn.textContent='粘贴';
    if(!busyButtons.has(clearBtn))clearBtn.textContent='清空';
    if(!busyButtons.has(copyBtn))copyBtn.textContent='复制';
    if(!busyButtons.has(sendBtn))sendBtn.textContent='发送';
    const message=String(error?.message||error||'GPT 状态读取失败');
    pasteBtn.title='把剪贴板文字粘贴到 ChatGPT 输入框；状态读取失败不影响再次点击';
    clearBtn.title='清空 ChatGPT 输入框；状态读取失败不影响再次点击';
    copyBtn.title=`${message}；点击“复制”会直接重试`;
    sendBtn.title=`${message}；点击“发送”会直接重试并继续执行客户绑定保护`;
  }finally{refreshBusy=false;}
}

async function runAction(btn,{name,busyText,label,timeoutMs=0,refreshDelay=220,onSuccess,onFailure}){
  if(!btn||busyButtons.has(btn))return;
  setButtonBusy(btn,true,busyText);
  try{
    const result=await safeInvoke(name,[],timeoutMs,label);
    if(result?.ok===false){
      if(onFailure)onFailure(result);
      else throw new Error(result?.error||`${label}失败`);
      return;
    }
    if(onSuccess)onSuccess(result||{});
    pulse(btn,'ok');
  }catch(error){
    btn.title=String(error?.message||error||`${label}失败`);
    pulse(btn,'error');
    if(btn===sendBtn)btn.textContent='发送失败';
  }finally{
    setButtonBusy(btn,false);
    setTimeout(refresh,refreshDelay);
  }
}

pasteBtn?.addEventListener('click',()=>runAction(pasteBtn,{
  name:'paste',busyText:'粘贴中…',label:'粘贴',timeoutMs:10000,refreshDelay:260,
  onSuccess:r=>{pasteBtn.title=`已粘贴 ${Number(r?.length||0)} 个字符，不会自动发送`;}
}));
clearBtn?.addEventListener('click',()=>runAction(clearBtn,{
  name:'clear',busyText:'清空中…',label:'清空',timeoutMs:10000,refreshDelay:220,
  onSuccess:r=>{clearBtn.title=String(r?.message||'ChatGPT 输入框已清空，不会发送');}
}));
copyBtn?.addEventListener('click',()=>runAction(copyBtn,{
  name:'copy',busyText:'复制中…',label:'复制',timeoutMs:10000,refreshDelay:180,
  onSuccess:r=>{copyBtn.title=`已复制 ${Number(r?.length||0)} 个字符到 Windows 剪贴板`;}
}));
sendBtn?.addEventListener('click',()=>runAction(sendBtn,{
  name:'send',busyText:'发送中…',label:'发送',timeoutMs:0,refreshDelay:850,
  onFailure:r=>{
    if(r?.pending||r?.generationBusy||r?.freshnessPending){
      sendBtn.textContent='等待GPT';
      sendBtn.title=String(r?.error||'GPT 正在生成本轮回复，稍后再点发送即可；不会重复发送客户消息。');
      return;
    }
    sendBtn.textContent=sendFailureLabel(r);
    sendBtn.title=String(r?.error||'发送失败');
    pulse(sendBtn,'error');
  },
  onSuccess:r=>{
    if(r?.queued){sendBtn.dataset.yokoQueued='1';sendBtn.textContent='等待GPT…';sendBtn.disabled=true;sendBtn.title=String(r?.message||'已排队：GPT 回复完成后会自动发送给当前客户');return;}
    sendBtn.dataset.yokoQueued='0';
    if(r?.alreadySent){sendBtn.textContent='✓ 已发送';sendBtn.title=String(r?.message||'这条 GPT 回复已经发送过，本次没有重复发送');return;}
    sendBtn.textContent='✓ 已发送';
    sendBtn.title=String(r?.message||'已只发送 GPT 的日语正文给当前客户');
  }
}));

setInterval(refresh,1600);
refresh();
