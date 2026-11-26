const V='modather-v10';
const FAV='modather-fav'; /* link icons: kept forever, never wiped by a version bump */
const ICONS=['icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-64.png'];
const SHELL=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-64.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V&&k!==FAV).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
async function tell(m){const cs=await self.clients.matchAll();cs.forEach(c=>c.postMessage(m))}
async function page(){
  const c=await caches.open(V);
  try{
    const r=await Promise.race([fetch('index.html',{cache:'no-cache'}),new Promise((_,no)=>setTimeout(no,4000))]);
    if(r&&r.ok){await c.put('index.html',r.clone());return r}
  }catch(e){}
  return (await c.match('index.html'))||new Response('Offline',{status:503});
}
async function special(r,u,fn){
  const ic=await caches.open('modather-icons'),base=u.origin+u.pathname;
  if(fn==='manifest.webmanifest'){
    const ver=await ic.match(u.origin+u.pathname.replace(/manifest\.webmanifest$/,'__ver'));
    let res=await caches.match(base,{ignoreSearch:true});if(!res)try{res=await fetch(r)}catch(e){}
    if(!res)return new Response('{}',{status:503});
    if(!ver)return res;
    try{const j=await res.clone().json(),v=await ver.text();j.icons=(j.icons||[]).map(i=>({...i,src:i.src.split('?')[0]+'?v='+v}));return new Response(JSON.stringify(j),{headers:{'Content-Type':'application/manifest+json'}})}catch(e){return res}
  }
  const hit=await ic.match(base);if(hit)return hit;
  return (await caches.match(base,{ignoreSearch:true}))||fetch(r);
}

/* link icons (Google favicon service or any image from another site): download once, then always serve from the device */
async function favGet(url){
  const c=await caches.open(FAV);
  const hit=await c.match(url);if(hit)return hit;
  try{
    let res;
    try{res=await fetch(url,{mode:'cors',credentials:'omit'});if(!res.ok)throw 0}catch(e){res=await fetch(url,{mode:'no-cors',credentials:'omit'})}
    if(res&&(res.ok||res.type==='opaque'))await c.put(url,res.clone());
    return res;
  }catch(e){return Response.error()}
}
self.addEventListener('message',e=>{const d=e.data||{};if(d.t==='fav'&&Array.isArray(d.urls))e.waitUntil(Promise.all(d.urls.map(favGet)))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.hostname==='api.github.com'||u.hostname.endsWith('.supabase.co')||u.hostname.endsWith('emailjs.com'))return; /* live data and auth must never be served from cache */
  {const fn=u.pathname.split('/').pop();if(u.origin===location.origin&&(ICONS.includes(fn)||fn==='manifest.webmanifest')){e.respondWith(special(r,u,fn));return}}
  if(u.origin!==location.origin&&r.destination==='image'){e.respondWith(favGet(r.url));return}
  if(r.mode==='navigate'){if(u.origin===location.origin&&/\/(index\.html)?$/.test(u.pathname))e.respondWith(page());return}
  e.respondWith(caches.match(r).then(hit=>{
    const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==='opaque')){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res}).catch(()=>hit);
    return hit||net;
  }));
});
