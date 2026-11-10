const V='modather-v3';
const ICONS=['icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-64.png'];
const SHELL=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-64.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
async function tell(m){const cs=await self.clients.matchAll();cs.forEach(c=>c.postMessage(m))}
async function page(){
  const c=await caches.open(V),hit=await c.match('index.html');
  const upd=fetch('index.html',{cache:'no-cache'}).then(async r=>{
    if(!r.ok)return;const nt=await r.clone().text();
    if(hit){const ot=await hit.clone().text();if(ot!==nt){await c.put('index.html',r);tell('updated')}}else await c.put('index.html',r);
  }).catch(()=>{});
  return hit||(await upd,await c.match('index.html'))||new Response('Offline',{status:503});
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
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.hostname==='api.github.com')return;
  {const fn=u.pathname.split('/').pop();if(u.origin===location.origin&&(ICONS.includes(fn)||fn==='manifest.webmanifest')){e.respondWith(special(r,u,fn));return}}
  if(r.mode==='navigate'){e.respondWith(page());return}
  e.respondWith(caches.match(r).then(hit=>{
    const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==='opaque')){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res}).catch(()=>hit);
    return hit||net;
  }));
});
