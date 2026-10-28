const form=document.getElementById('loginForm');
const button=document.getElementById('loginButton');
const status=document.getElementById('status');
const remember=document.getElementById('rememberPassword');
(async()=>{try{const saved=await window.yokoLogin.rememberedLogin();if(saved?.ok&&saved.username&&saved.password){document.getElementById('username').value=saved.username;document.getElementById('password').value=saved.password;if(remember)remember.checked=true;}}catch{}})();
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
    const username=document.getElementById('username')?.value||'';
    const passwordValue=document.getElementById('password')?.value||'';
    await window.yokoLogin.login({username,password:passwordValue,remember:!!remember?.checked});
    if(status)status.style.color='#287653';
    if(status)status.textContent='登录成功，正在打开软件…';
    const password=document.getElementById('password');if(password)password.value='';
  }catch(error){
    if(status){status.style.color='#b14635';status.textContent=error?.message||String(error);}
    if(button)button.disabled=false;
  }
});
