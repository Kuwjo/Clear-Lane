const CACHE="clearlane-v4";
const FILES=["./","./index.html","./manifest.json","./icon-192.png","./icon-512.png","./icon-180.png","./favicon.png","./icon.svg"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim();});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.pathname.startsWith("/.netlify/")||u.origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(res=>{const c=res.clone();caches.open(CACHE).then(x=>x.put(e.request,c)).catch(()=>{});return res;}).catch(()=>caches.match(e.request).then(r=>r||caches.match("./index.html"))));
});
