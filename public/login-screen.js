export function mountLoginScreen(root,{onSubmit,enabled=true}){
 const form=root.querySelector('form'),email=form.elements.email,password=form.elements.password,fields=root.querySelector('fieldset'),button=root.querySelector('#loginSubmit'),error=root.querySelector('#loginError'),toggle=root.querySelector('#togglePassword'),loading=root.querySelector('#loginLoading');let busy=false;
 function message(text){error.textContent=text;error.hidden=!text;}
 function lock(value){busy=value;fields.disabled=value||!enabled;form.setAttribute('aria-busy',String(value));button.querySelector('span').textContent=value?'Verificando acceso…':'Ingresar al CRM';button.querySelector('.login-spinner').hidden=!value;}
 toggle.addEventListener('click',()=>{const visible=password.type==='password';password.type=visible?'text':'password';toggle.setAttribute('aria-pressed',String(visible));toggle.setAttribute('aria-label',visible?'Ocultar contraseña':'Mostrar contraseña');toggle.textContent=visible?'Ocultar':'Mostrar';});
 form.addEventListener('input',event=>{event.target.removeAttribute('aria-invalid');if(!busy)message('');});
 form.addEventListener('submit',async event=>{event.preventDefault();if(busy||!enabled)return;email.value=email.value.trim();message('');if(!email.value||!email.checkValidity()){message('Ingresá un correo electrónico válido.');email.setAttribute('aria-invalid','true');email.focus();return;}if(!password.value){message('Ingresá tu contraseña.');password.setAttribute('aria-invalid','true');password.focus();return;}lock(true);try{await onSubmit(email.value,password.value);password.value='';}catch(err){password.value='';message(err.message);error.focus();}finally{lock(false);}});
 lock(false);
 return {
  show({checking=false,error:text=''}={}){root.hidden=false;loading.hidden=!checking;loading.querySelector('span:last-child').textContent='Verificando tu sesión…';form.hidden=checking;root.querySelector('#loginIntro').hidden=checking;message(text);document.title='Ingresar · El Viejo · Villeta';if(!checking&&!busy)(text?error:email).focus();},
  hide(){root.hidden=true;message('');password.value='';password.type='password';toggle.textContent='Mostrar';toggle.setAttribute('aria-label','Mostrar contraseña');toggle.setAttribute('aria-pressed','false');},
  reset(){form.reset();password.type='password';toggle.textContent='Mostrar';toggle.setAttribute('aria-label','Mostrar contraseña');toggle.setAttribute('aria-pressed','false');message('');}
 };
}
