const form=document.getElementById('loginForm');
const button=document.getElementById('loginButton');
const status=document.getElementById('status');
document.getElementById('togglePassword')?.addEventListener('click',()=>{
  const input=document.getElementById('password');
  const toggle=document.getElementById('togglePassword');
  if(!input||!toggle)return;
  const hidden=input.type==='password';
  input.type=hidden?'text':'password';
  toggle.textContent=hidden?'◌':'◉';
});
form?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(button)button.disabled=true;
  if(status)status.textContent='正在验证账号…';
  try{
    await window.yokoLogin.login({username:document.getElementById('username')?.value||'',password:document.getElementById('password')?.value||''});
    if(status)status.style.color='#287653';
    if(status)status.textContent='登录成功，正在打开软件…';
    const password=document.getElementById('password');if(password)password.value='';
  }catch(error){
    if(status){status.style.color='#b14635';status.textContent=error?.message||String(error);}
    if(button)button.disabled=false;
  }
});
