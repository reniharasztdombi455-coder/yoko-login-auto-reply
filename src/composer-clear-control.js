'use strict';

// V1.27.65 — non-sealed composer helpers.
// LINE's src/line-preload.js is part of the V1.25.11 sealed core, so its native
// paste button must remain untouched. This module adds a Clear companion from
// the main process after LINE loads and talks only to the already-public
// window.yokoLine getInputText/setInputText API.

const LINE_CLEAR_CONTROL_VERSION = 'v127197-right-composer-actions-final';

function lineComposerClearControlScript() {
  return `(() => {
    try {
      const VERSION=${JSON.stringify('v127197-right-composer-actions-final')};
      const EXISTING=window.__yokoLineComposerClearControl;
      if (EXISTING?.version===VERSION) {
        try { EXISTING.position?.(); } catch {}
        return {ok:true,alreadyInstalled:true,version:VERSION};
      }

      const ID='yoko-v12765-line-composer-clear';
      let clearBtn=document.getElementById(ID);
      let pasteBtn=null;
      let observer=null;
      let disposed=false;
      const waitTimers=new Set();

      const visible=el=>{
        try{
          if(!el||!el.isConnected)return false;
          const r=el.getBoundingClientRect(),s=getComputedStyle(el);
          return r.width>8&&r.height>8&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;
        }catch{return false}
      };

      const currentComposer=()=>{
        try{
          const rows=[];
          for(const el of document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')){
            if(!visible(el))continue;
            const r=el.getBoundingClientRect();
            if(r.width<120||r.height<10||r.bottom<innerHeight*.68||r.top>=innerHeight-4)continue;
            const meta=[el.getAttribute?.('placeholder'),el.getAttribute?.('aria-label'),el.getAttribute?.('name'),el.getAttribute?.('role')].filter(Boolean).join(' ').toLowerCase();
            if(/search|搜索|查找|filter|筛选/i.test(meta))continue;
            rows.push({el,r});
          }
          rows.sort((a,b)=>b.r.bottom-a.r.bottom||b.r.width-a.r.width);
          return rows[0]||null;
        }catch{return null}
      };

      const setPx=(style,key,value)=>{
        const next=Math.round(value)+'px';
        if(style[key]!==next)style[key]=next;
      };

      const position=()=>{
        if(disposed)return false;
        if(!pasteBtn?.isConnected) pasteBtn=document.querySelector('.yoko-line-paste-action');
        if(!clearBtn?.isConnected) clearBtn=document.getElementById(ID);
        if(!clearBtn)return false;
        if(!pasteBtn||!visible(pasteBtn)){
          clearBtn.style.display='none';
          return false;
        }
        // V1.27.196: own the two LINE composer helpers as one RIGHT-aligned
        // action group. The sealed paste control may still calculate its legacy
        // left position; this companion corrects it only when the actual composer
        // is visible, without touching the LINE message/translation preload.
        const composer=currentComposer();
        const gap=6;
        const clearWidth=Math.max(58,clearBtn.offsetWidth||58);
        const pasteWidth=Math.max(58,pasteBtn.offsetWidth||58);
        const groupWidth=pasteWidth+gap+clearWidth;
        if(composer){
          const cr=composer.r;
          const desiredLeft=Math.max(cr.left+8,Math.min(cr.right-groupWidth-8,innerWidth-groupWidth-8));
          const desiredTop=Math.max(8,cr.top-32);
          setPx(pasteBtn.style,'left',desiredLeft);
          setPx(pasteBtn.style,'top',desiredTop);
        }else{
          // LINE 3.7.x can render its composer without textarea/contenteditable
          // metadata. V1.27.196 then left the sealed Paste button at the old
          // bottom-left position. Fall back to a viewport-right anchor while
          // preserving the native button's vertical row.
          const desiredLeft=Math.max(8,innerWidth-groupWidth-84);
          const current=pasteBtn.getBoundingClientRect();
          setPx(pasteBtn.style,'left',desiredLeft);
          if(current?.top>=0)setPx(pasteBtn.style,'top',current.top);
        }
        const r=pasteBtn.getBoundingClientRect();
        let left=r.right+gap;
        if(left+clearWidth>innerWidth-8) left=Math.max(8,r.left-clearWidth-gap);
        clearBtn.style.display='block';
        setPx(clearBtn.style,'left',left);
        setPx(clearBtn.style,'top',r.top);
        return true;
      };

      const ensureButton=()=>{
        if(clearBtn?.isConnected)return clearBtn;
        clearBtn=document.createElement('button');
        clearBtn.id=ID;
        clearBtn.type='button';
        clearBtn.dataset.yokoUi='1';
        clearBtn.textContent='清空';
        clearBtn.title='清空当前 LINE 输入框里的全部文字（不会自动发送）';
        Object.assign(clearBtn.style,{
          position:'fixed',zIndex:'2147482501',display:'none',minWidth:'58px',height:'28px',
          padding:'0 12px',border:'1px solid rgba(15,23,42,.16)',borderRadius:'8px',
          background:'rgba(255,255,255,.97)',color:'#172033',fontSize:'12px',fontWeight:'600',
          boxShadow:'0 1px 4px rgba(15,23,42,.08)',cursor:'pointer',lineHeight:'26px'
        });
        clearBtn.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation()});
        clearBtn.addEventListener('click',async event=>{
          event.preventDefault();event.stopPropagation();
          if(clearBtn.dataset.busy==='1')return;
          clearBtn.dataset.busy='1';
          clearBtn.disabled=true;
          clearBtn.textContent='清空中…';
          try{
            const before=String(await window.yokoLine?.getInputText?.()||'');
            if(!before){
              clearBtn.textContent='✓ 已清空';
              clearBtn.title='当前 LINE 输入框已经是空的';
            }else{
              const result=await window.yokoLine?.setInputText?.('');
              if(result?.ok===false)throw new Error(result?.error||'清空失败');
              await new Promise(r=>setTimeout(r,70));
              const after=String(await window.yokoLine?.getInputText?.()||'');
              if(after.trim())throw new Error('LINE 输入框仍有文字，未清空');
              clearBtn.textContent='✓ 已清空';
              clearBtn.title='当前 LINE 输入框已清空，不会自动发送';
            }
          }catch(error){
            clearBtn.textContent='清空失败';
            clearBtn.title=String(error?.message||error||'清空失败');
          }finally{
            setTimeout(()=>{
              if(clearBtn?.isConnected){
                clearBtn.textContent='清空';
                clearBtn.disabled=false;
                clearBtn.dataset.busy='0';
                clearBtn.title='清空当前 LINE 输入框里的全部文字（不会自动发送）';
                position();
              }
            },850);
          }
        });
        document.documentElement.appendChild(clearBtn);
        return clearBtn;
      };

      const connectToPaste=()=>{
        pasteBtn=document.querySelector('.yoko-line-paste-action');
        if(!pasteBtn)return false;
        ensureButton();
        try{observer?.disconnect()}catch{}
        observer=new MutationObserver(()=>position());
        try{observer.observe(pasteBtn,{attributes:true,attributeFilter:['style','class']})}catch{}
        position();
        return true;
      };

      ensureButton();
      if(!connectToPaste()){
        // Bounded bootstrap only. Once the sealed LINE paste control exists,
        // its style mutations drive our position; there is no perpetual DOM poll.
        for(let i=1;i<=20;i++){
          const timer=setTimeout(()=>{waitTimers.delete(timer);if(disposed)return;if(connectToPaste()){for(const t of waitTimers)clearTimeout(t);waitTimers.clear()}},i*250);
          waitTimers.add(timer);
        }
      }

      const onResize=()=>position();
      const onScroll=()=>position();
      addEventListener('resize',onResize,{passive:true});
      addEventListener('scroll',onScroll,{passive:true,capture:true});

      const api={
        version:VERSION,
        position,
        dispose(){
          disposed=true;
          try{observer?.disconnect()}catch{}
          for(const t of waitTimers)clearTimeout(t);
          waitTimers.clear();
          removeEventListener('resize',onResize);
          removeEventListener('scroll',onScroll,true);
          try{clearBtn?.remove()}catch{}
        }
      };
      window.__yokoLineComposerClearControl=api;
      return {ok:true,version:VERSION,waiting:!pasteBtn};
    } catch(error) {
      return {ok:false,error:String(error?.message||error||'LINE 清空按钮安装失败')};
    }
  })()`;
}

async function installLineComposerClearControl(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  try {
    const result = await webContents.executeJavaScript(lineComposerClearControlScript(), true);
    return !!result?.ok;
  } catch {
    return false;
  }
}

module.exports = {
  LINE_CLEAR_CONTROL_VERSION,
  lineComposerClearControlScript,
  installLineComposerClearControl
};
