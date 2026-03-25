"use strict";(()=>{function oe(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function Ie(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function Re(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function W(e=!0){let t=Ie();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of Re())n.has(r.element)||(t.push(r),n.add(r.element));return t}function ie(){let e=[],t=new Set;for(let{element:n,rid:r}of W()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),s=n.getAttribute("data-test");e.push({rid:r,name:s??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var Ae=.5;function $(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=Ae,confidence:t,signals:e.map(n=>n.name)}}function b(e,t,...n){let r=document.createElement(e);if(t)for(let[o,s]of Object.entries(t))s==null||s===!1||(o.startsWith("on")&&typeof s=="function"?r.addEventListener(o.slice(2).toLowerCase(),s):o==="class"||o==="className"?r.className=String(s):o==="style"?r.setAttribute("style",String(s)):o==="checked"||o==="disabled"||o==="readOnly"?s===!0&&(r[o]=!0):o==="value"?r.value=String(s):r.setAttribute(o,s===!0?"":String(s)));return z(r,n),r}function S(e,...t){e.textContent="",z(e,t)}function z(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?z(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var D="[CREV]",v={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${D}:${e}`,...t)},info(e,...t){console.info(`${D}:${e}`,...t)},warn(e,t,...n){console.warn(`${D}:${e}`,t,...n)},error(e,t,...n){console.error(`${D}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${D}:${e} [swallowed]`,t)}};var I=null,k=200,C=[],se=null,ae=null;function ce(e){se=e}function le(e){ae=e}function K(){try{I=chrome.runtime.connect({name:"content"}),k=200}catch(e){v.swallow("port:connect",e);return}I.onMessage.addListener(e=>{se?.(e)}),Oe(),I.onDisconnect.addListener(()=>{I=null;try{chrome.runtime.getURL("");let e=k>200;setTimeout(()=>{if(K(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);ae?.()},k),k=Math.min(k*2,1e4)}catch(e){v.swallow("port:reconnectCheck",e)}})}function E(e){if(I)try{I.postMessage(e);return}catch(t){v.swallow("port:send",t),I=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>v.swallow("port:oneShot",t))}catch(t){v.swallow("port:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"||e.type==="ENRICH_BADGES"){if(e.type==="DETECTION_RESULT"){let t=C.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&C.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=C[C.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}if(e.type==="ENRICH_BADGES"){let t=C[C.length-1];if(t?.type==="ENRICH_BADGES"){let n=new Set(t.rids);for(let r of e.rids)n.has(r)||t.rids.push(r);return}}for(C.push(e);C.length>20;)C.shift()}}function Oe(){for(;C.length>0;){let e=C.shift();try{I?.postMessage(e)}catch(t){v.swallow("port:flush",t);break}}}var Le="crev-env-tag",Q="crev_env_tag_pos",l=null,P=null,M=null;function de(e,t){if(l){H(e,t);return}l=document.createElement("div"),l.id=Le,P=document.createElement("span"),P.className="crev-env-dot",M=document.createElement("span"),M.className="crev-env-label",l.appendChild(P),l.appendChild(M),document.body.appendChild(l),H(e,t),chrome.storage.local.get(Q,c=>{let p=c[Q];p&&l&&(l.style.bottom=`${p.bottom??12}px`,l.style.top="auto",p.snap==="left"?(l.classList.add("crev-env-tag--edge-left"),l.style.left="0",l.style.right="auto"):p.snap==="right"?(l.classList.add("crev-env-tag--edge-right"),l.style.right="0",l.style.left="auto"):(l.style.right=`${p.right??12}px`,l.style.left="auto"))});let n=!1,r=0,o=0,s=0,u=0;l.addEventListener("mousedown",c=>{if(c.button===0){if(c.preventDefault(),n=!0,r=c.clientX,o=c.clientY,l){l.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let p=l.getBoundingClientRect();s=window.innerWidth-p.right,u=window.innerHeight-p.bottom,l.style.right=`${s}px`,l.style.bottom=`${u}px`,l.style.left="auto",l.style.top="auto"}document.addEventListener("mousemove",m),document.addEventListener("mouseup",d)}});function m(c){if(!n||!l)return;let p=c.clientX-r,f=c.clientY-o,a=Math.max(0,s-p),y=Math.max(0,u-f);l.style.right=`${a}px`,l.style.bottom=`${y}px`,l.style.left="auto",l.style.top="auto"}function d(){if(n=!1,document.removeEventListener("mousemove",m),document.removeEventListener("mouseup",d),!l)return;let c=l.getBoundingClientRect(),p=c.left+c.width/2,f=window.innerWidth;l.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let a=null;p<f*.15?(a="left",l.classList.add("crev-env-tag--edge-left"),l.style.left="0",l.style.right="auto"):p>f*.85&&(a="right",l.classList.add("crev-env-tag--edge-right"),l.style.right="0",l.style.left="auto");let y=l.getBoundingClientRect(),h={right:Math.round(window.innerWidth-y.right),bottom:Math.round(window.innerHeight-y.bottom)};a&&(h.snap=a),chrome.storage.local.set({[Q]:h}).catch(()=>{})}}function H(e,t){P&&(P.className=`crev-env-dot crev-env-dot--${t}`),M&&(M.textContent=e||"CREV")}function pe(){l?.remove(),l=null,P=null,M=null}var ue="crev-toast-container";function Pe(){let e=document.getElementById(ue);return e||(e=document.createElement("div"),e.id=ue,document.body.appendChild(e)),e}function _(e,t){let n=Pe(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var Me="crev-quick-inspector",g=null,me=null;function fe(e,t,n,r,o){if(R(),me=t.rid,g=document.createElement("div"),g.id=Me,t.type){let a=document.createElement("span");a.className="crev-qi-badge",a.textContent=t.type,g.appendChild(a)}if(t.name){let a=document.createElement("div");a.className="crev-qi-name",a.textContent=t.name,g.appendChild(a)}if(t.businessId){let a=document.createElement("div");a.className="crev-qi-row",a.textContent=`ID: ${t.businessId}`,g.appendChild(a)}if(t.templateBusinessId){let a=document.createElement("div");a.className="crev-qi-row crev-qi-template",a.textContent=`Template: ${t.templateBusinessId}`,g.appendChild(a)}let s=document.createElement("div");s.className="crev-qi-row crev-qi-rid",s.textContent=`RID: ${t.rid}`,g.appendChild(s);let u=document.createElement("button");u.className=`crev-qi-star${t.isFavorite?" active":""}`,u.textContent=t.isFavorite?"\u2605":"\u2606",u.title=t.isFavorite?"Remove from pinned":"Pin this object",u.addEventListener("click",a=>{a.stopPropagation(),r?.(t.rid);let y=u.classList.toggle("active");u.textContent=y?"\u2605":"\u2606"}),g.appendChild(u);let m=document.createElement("div");m.className="crev-qi-actions";let d=document.createElement("button");d.className="crev-qi-btn",d.textContent="Copy RID",d.addEventListener("click",a=>{a.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{d.textContent="\u2713",setTimeout(()=>{d.textContent="Copy RID"},600)}).catch(()=>{})});let c=document.createElement("button");c.className="crev-qi-btn",c.textContent="Copy ID",c.addEventListener("click",a=>{a.stopPropagation();let y=t.businessId??t.rid;navigator.clipboard.writeText(y).then(()=>{c.textContent="\u2713",setTimeout(()=>{c.textContent="Copy ID"},600)}).catch(()=>{})});let p=document.createElement("button");p.className="crev-qi-btn crev-qi-btn--accent",p.textContent="Editor",p.addEventListener("click",a=>{a.stopPropagation(),n(t.rid),R()});let f=document.createElement("button");f.className="crev-qi-btn",f.textContent="Full View",f.addEventListener("click",a=>{a.stopPropagation(),o?.(t.rid),R()}),m.appendChild(d),m.appendChild(c),m.appendChild(p),m.appendChild(f),g.appendChild(m),document.body.appendChild(g),Ne(e)}function Ne(e){if(!g)return;g.style.top="-9999px",g.style.left="-9999px",g.style.display="block";let t=e.getBoundingClientRect(),n=g.getBoundingClientRect(),r=6,o=t.bottom+r,s=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),s+n.width>window.innerWidth-r&&(s=window.innerWidth-n.width-r),s<r&&(s=r),g.style.top=`${o}px`,g.style.left=`${s}px`}function R(){g?.remove(),g=null,me=null}function J(){return g!=null}var Z=new Map;function B(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function F(e,t){let n=Z.get(e);n||(n=[],Z.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=Z.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var ge=`.crev-outline {
  position: relative !important;
}
.crev-outline::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--crev-color, #8d8d8d);
  pointer-events: none;
  z-index: 9999;
}
.crev-label {
  position: absolute;
  top: 2px; right: 2px;
  z-index: 10000;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 4px;
  font: 600 11px/1.3 system-ui, sans-serif;
  color: #fff;
  background: var(--crev-color, #8d8d8d);
  opacity: 0.93;
  box-shadow: 0 1px 3px rgba(0,0,0,0.25);
  pointer-events: auto;
  user-select: none;
  white-space: nowrap;
}
.crev-label:hover { opacity: 1; animation: none; }
.crev-label-flash-pick { background: #ff832b !important; }
.crev-label-flash-ok { background: #42be65 !important; }
.crev-label-flash-error { background: #fa4d56 !important; }
.crev-label-text {
  cursor: pointer;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
@keyframes crev-shimmer {
  0%, 100% { opacity: 0.93; }
  50% { opacity: 0.5; }
}
.crev-label-loading {
  animation: crev-shimmer 1.5s ease-in-out infinite;
}
/* Action strip below badge */
.crev-actions {
  position: absolute;
  top: 22px; right: 2px;
  z-index: 10000;
  display: inline-flex;
  gap: 2px;
  opacity: 0.8;
}
.crev-actions:hover { opacity: 1; }
.crev-ec-btn, .crev-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 5px;
  border: 1px solid rgba(0,0,0,0.3);
  background: rgba(0,0,0,0.45);
  color: #fff;
  font: 700 9px/1.2 'SF Mono', 'Cascadia Code', Consolas, monospace;
  border-radius: 3px;
  cursor: pointer;
  backdrop-filter: blur(2px);
}
.crev-ec-btn:hover, .crev-action-btn:hover {
  background: rgba(0,0,0,0.7);
  border-color: rgba(255,255,255,0.5);
}
.crev-paint-apply-btn {
  background: #fff;
  color: #ff832b;
  border: none;
  border-radius: 3px;
  padding: 2px 10px;
  font-weight: 700;
  cursor: pointer;
  margin-right: 6px;
}
.crev-paint-cancel-btn {
  background: rgba(255,255,255,0.2);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.4);
  border-radius: 3px;
  padding: 2px 10px;
  cursor: pointer;
}
#crev-paint-banner {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 2147483646;
  padding: 5px 12px;
  background: #ff832b;
  color: #fff;
  font: 600 11px/1.4 system-ui, sans-serif;
  text-align: center;
  display: none;
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}
#crev-paint-banner b { font-weight: 800; }
#crev-paint-banner .crev-paint-close {
  position: absolute;
  right: 8px;
  top: 3px;
  background: none;
  border: none;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  opacity: 0.7;
}
#crev-paint-banner .crev-paint-close:hover { opacity: 1; }
#crev-tooltip {
  position: fixed;
  z-index: 2147483646;
  padding: 8px 12px;
  border-radius: 8px;
  font: 11px/1.4 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #e6e1e5;
  background: #36343b;
  border: 1px solid #49454f;
  box-shadow: 0 4px 8px rgba(0,0,0,0.4);
  pointer-events: none;
  display: none;
  max-width: 300px;
}
#crev-tooltip .crev-tt-type {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  margin-bottom: 3px;
}
#crev-tooltip .crev-tt-name {
  font-weight: 600;
  margin-bottom: 2px;
}
#crev-tooltip .crev-tt-row {
  color: #c6c6c6;
  font-size: 10px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  word-break: break-all;
}

/* \u2500\u2500 Environment Indicator Tag \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

#crev-env-tag {
  position: fixed;
  bottom: 12px;
  right: 12px;
  z-index: 2147483645;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(28, 27, 31, 0.85);
  border: 1px solid rgba(73, 69, 79, 0.6);
  font: 500 10px/1.3 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #cac4d0;
  cursor: move;
  user-select: none;
  opacity: 0.25;
  transition: opacity 150ms ease;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
#crev-env-tag:hover {
  opacity: 1;
}
.crev-env-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.crev-env-dot--connected { background: #7dd392; }
.crev-env-dot--disconnected { background: #f2b8b5; }
.crev-env-dot--not-configured { background: #938f99; }
.crev-env-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crev-env-tag--edge-left {
  writing-mode: vertical-lr;
  left: 0 !important;
  right: auto !important;
  border-radius: 0 6px 6px 0;
}
.crev-env-tag--edge-right {
  writing-mode: vertical-rl;
  right: 0 !important;
  left: auto !important;
  border-radius: 6px 0 0 6px;
}
.crev-env-tag--edge-left,
.crev-env-tag--edge-right {
  padding: 10px 4px;
}
.crev-env-tag--edge-left .crev-env-label,
.crev-env-tag--edge-right .crev-env-label {
  white-space: nowrap;
}

/* \u2500\u2500 Connection Toasts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

#crev-toast-container {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483644;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.crev-toast {
  padding: 8px 14px;
  border-radius: 8px;
  font: 500 11px/1.4 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #fff;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  pointer-events: auto;
  opacity: 0;
  transform: translateX(20px);
  transition: opacity 300ms ease, transform 300ms ease;
  max-width: 280px;
}
.crev-toast--visible {
  opacity: 1;
  transform: translateX(0);
}
.crev-toast--exit {
  opacity: 0;
  transform: translateX(20px);
}
.crev-toast--success {
  background: rgba(66, 190, 101, 0.92);
}
.crev-toast--error {
  background: rgba(218, 30, 40, 0.92);
}
.crev-toast--info {
  background: rgba(69, 137, 255, 0.92);
}

/* \u2500\u2500 Technical Overlay Cards \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

.crev-label--card {
  max-width: 320px;
  white-space: normal;
  padding: 4px 8px;
  line-height: 1.3;
  font-size: 10px;
}
.crev-label--card .crev-label-text {
  display: flex;
  flex-direction: column;
  max-width: none;
  white-space: normal;
}
.crev-card-line { display: block; }
.crev-card-type { font-weight: 700; }
.crev-card-rid { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 9px; opacity: 0.8; }
.crev-card-sep {
  display: block;
  height: 1px;
  background: rgba(255,255,255,0.15);
  margin: 3px 0;
}
.crev-card-prop {
  font-size: 9px;
  opacity: 0.7;
  font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
}

/* \u2500\u2500 Quick Inspector Star \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

.crev-qi-star {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: #938f99;
  padding: 0;
  line-height: 1;
}
.crev-qi-star:hover { color: #f1c21b; }
.crev-qi-star.active { color: #f1c21b; }

/* \u2500\u2500 Quick Inspector Popup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

#crev-quick-inspector {
  position: fixed;
  z-index: 2147483647;
  padding: 10px 14px;
  border-radius: 10px;
  background: #1c1b1f;
  border: 1px solid #49454f;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  font: 11px/1.5 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #e6e1e5;
  min-width: 200px;
  max-width: 320px;
}
.crev-qi-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: #ba88ff;
  margin-bottom: 4px;
}
.crev-qi-name {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crev-qi-row {
  font-size: 10px;
  color: #cac4d0;
}
.crev-qi-template {
  color: #a89db8;
}
.crev-qi-rid {
  font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
  word-break: break-all;
  margin-bottom: 6px;
}
.crev-qi-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.crev-qi-btn {
  padding: 3px 10px;
  border: 1px solid #49454f;
  border-radius: 6px;
  background: #2b2930;
  color: #e6e1e5;
  font: 500 10px/1.2 'Segoe UI', Roboto, system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.crev-qi-btn:hover {
  background: #36343b;
  border-color: #938f99;
}
.crev-qi-btn--accent {
  border-color: #ba88ff;
  color: #ba88ff;
}
.crev-qi-btn--accent:hover {
  background: #ba88ff;
  color: #1c1b1f;
}
`;var U=class{inspectActive=!1;enrichMode="all";paintPhase="off";paintSourceName=null;styleInjected=!1;technicalOverlay=!1;fromSync=!1;prevConnDisplay=null;lastUrl=typeof window<"u"?window.location.href:"";lastDetection=null;enrichments=new Map;overlayProps=new Map;badgedElements=new WeakSet;requestedRids=new Set;discoveredRids=new Set;favoriteRids=new Set;observer=null;tooltipHideTimer=null;debounceTimer=null;labelClickTimer=null;hoveredOutlineEl=null;labelClickRid=null;resetOverlays(){this.badgedElements=new WeakSet,this.requestedRids.clear(),this.overlayProps.clear(),this.labelClickTimer&&(clearTimeout(this.labelClickTimer),this.labelClickTimer=null),this.labelClickRid=null,this.hoveredOutlineEl=null}resetDiscovery(){this.discoveredRids.clear()}resetAll(){this.inspectActive=!1,this.enrichMode="all",this.paintPhase="off",this.paintSourceName=null,this.styleInjected=!1,this.technicalOverlay=!1,this.fromSync=!1,this.prevConnDisplay=null,this.lastUrl=typeof window<"u"?window.location.href:"",this.lastDetection=null,this.enrichments.clear(),this.resetOverlays(),this.resetDiscovery(),this.favoriteRids.clear(),this.debounceTimer&&(clearTimeout(this.debounceTimer),this.debounceTimer=null),this.tooltipHideTimer&&(clearTimeout(this.tooltipHideTimer),this.tooltipHideTimer=null),this.observer?.disconnect(),this.observer=null}};var be=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],ke="#33b1ff",He={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},Be={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(be.map(e=>[e,ke]))},Fe={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...He},ye="#8d8d8d";function V(e){return e?Be[e]??ye:ye}function N(e){return e?Fe[e]??e.substring(0,3).toUpperCase():"?"}var Ve={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(be.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},ee=new Set(Object.keys(Ve));function ve(e,t){let n=document.createElement("button");return n.className="crev-ec-btn",n.textContent=t==="CustomVisualization"?"</>":"EC",n.title="Open in editor",n.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n}function w(e){for(let d of document.querySelectorAll(".crev-label"))(!d.parentElement||!document.body.contains(d.parentElement))&&d.remove();let t=e.enrichMode==="all",n=W(t),r=t?n.filter(({element:d})=>d.tagName==="A").length:0;v.debug("sync",`syncOverlays: ${n.length} elements (${r} links), enrichMode=${e.enrichMode}`);let o=[],s=n.filter(({element:d})=>!e.badgedElements.has(d));for(let{element:d,rid:c}of s){let p=e.enrichments.get(c),f=V(p?.type);d.classList.add("crev-outline"),d.style.setProperty("--crev-color",f);let a=document.createElement("span");a.className="crev-label",p||a.classList.add("crev-label-loading"),a.setAttribute("data-crev-label",c);let y=document.createElement("span");if(y.className="crev-label-text",y.textContent=p?.businessId??p?.name??N(p?.type),a.appendChild(y),y.addEventListener("click",h=>{if(h.preventDefault(),h.stopPropagation(),e.paintPhase==="picking"){E({type:"PAINT_PICK",rid:c}),a.classList.add("crev-label-flash-pick"),setTimeout(()=>{a.classList.remove("crev-label-flash-pick")},400);return}if(e.paintPhase==="applying"){E({type:"PAINT_APPLY",rid:c});return}if(e.labelClickRid===c&&e.labelClickTimer){clearTimeout(e.labelClickTimer),e.labelClickTimer=null,e.labelClickRid=null,Ye(e,a,c);return}let T=h.shiftKey;e.labelClickRid=c,e.labelClickTimer=setTimeout(()=>{e.labelClickTimer=null,e.labelClickRid=null;let x=e.enrichments.get(c),A=!!x?.templateBusinessId,O=T&&A?x.templateBusinessId:x?.businessId??c,L=T&&A?"\u2713 Tmpl":"\u2713";navigator.clipboard.writeText(O).then(()=>{let j=y.textContent;y.textContent=L,a.classList.add("crev-label-flash-ok"),setTimeout(()=>{y.textContent=j,a.classList.remove("crev-label-flash-ok")},600)}).catch(j=>v.swallow("content:clipboard",j))},250)}),d.appendChild(a),p){let h=document.createElement("span");h.className="crev-actions",p.type&&ee.has(p.type)&&h.appendChild(ve(c,p.type));let T=document.createElement("button");T.className="crev-action-btn",T.textContent="\u2315",T.title="Find references",T.addEventListener("click",x=>{x.preventDefault(),x.stopPropagation(),chrome.runtime.sendMessage({type:"SEARCH_REFERENCES",rid:c,businessId:p.businessId,objectType:p.type,name:p.name})}),h.appendChild(T),d.appendChild(h)}e.badgedElements.add(d),!e.enrichments.has(c)&&!e.requestedRids.has(c)&&(o.push(c),e.requestedRids.add(c))}for(let{rid:d}of n)!e.enrichments.has(d)&&!e.requestedRids.has(d)&&(o.push(d),e.requestedRids.add(d));o.length>0&&(v.debug("sync",`ENRICH_BADGES: sending ${o.length} RIDs`,o),E({type:"ENRICH_BADGES",rids:o}));let u=Date.now(),m=[];for(let{rid:d}of n)!e.discoveredRids.has(d)&&e.discoveredRids.size<5e3&&(e.discoveredRids.add(d),m.push({rid:d,source:"dom",discoveredAt:u,updatedAt:u}));m.length>0&&E({type:"OBJECTS_DISCOVERED",objects:m})}function q(e){for(let n of document.querySelectorAll(".crev-label"))n.remove();for(let n of document.querySelectorAll(".crev-outline"))n.classList.remove("crev-outline"),n.style.removeProperty("--crev-color");let t=document.getElementById("crev-tooltip");t&&(t.style.display="none"),e.hoveredOutlineEl=null,e.badgedElements=new WeakSet,e.overlayProps.clear()}function he(e){for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");if(!n)continue;let r=e.enrichments.get(n);if(r){let o=t.querySelector(".crev-label-text");o&&(o.textContent=r.businessId??r.name??N(r.type)),t.classList.remove("crev-label-loading");let s=t.parentElement;if(s){let u=V(r.type);s.style.setProperty("--crev-color",u)}if(s&&!s.querySelector(".crev-actions")){let u=document.createElement("span");u.className="crev-actions",r.type&&ee.has(r.type)&&u.appendChild(ve(n,r.type));let m=document.createElement("button");m.className="crev-action-btn",m.textContent="\u2315",m.title="Find references",m.addEventListener("click",d=>{d.preventDefault(),d.stopPropagation(),chrome.runtime.sendMessage({type:"SEARCH_REFERENCES",rid:n,businessId:r.businessId,objectType:r.type,name:r.name})}),u.appendChild(m),s.appendChild(u)}}}}function Ye(e,t,n){let r=e.enrichments.get(n);chrome.runtime.sendMessage({type:"GET_FAVORITES"},o=>{o?.entries&&(e.favoriteRids=new Set(o.entries.map(s=>s.rid))),fe(t,{rid:n,businessId:r?.businessId,templateBusinessId:r?.templateBusinessId,type:r?.type,name:r?.name,isFavorite:e.favoriteRids.has(n)},s=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:s})},s=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:s,name:r?.name,objectType:r?.type,businessId:r?.businessId}),e.favoriteRids.has(s)?e.favoriteRids.delete(s):e.favoriteRids.add(s)},s=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:s})})})}function te(e,...t){let n=document.getElementById("crev-paint-banner"),r=document.getElementById("crev-paint-text");if(!(!n||!r)){if(e.paintPhase==="off"){n.style.display="none";return}if(n.style.display="block",n.style.background="#ff832b",t.length>0){S(r,...t);return}e.paintPhase==="picking"?S(r,"Paint Format \u2014 ",b("b",null,"click a widget to pick its style")):S(r,"Paint Format from ",b("b",null,e.paintSourceName??"?")," \u2014 click widgets to apply")}}function ne(e){let t=e.paintPhase!=="off"?"crosshair":"pointer";for(let n of document.querySelectorAll(".crev-label-text"))n.style.cursor=t;te(e)}function Ee(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let o=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(o),setTimeout(()=>{r.classList.remove(o)},600)}if(t)_("Applied \u2014 refresh page to see changes","success");else{let o=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Paint error: ${n??"unknown"}`;_(o,"error")}}function Te(e,t,n){let r=document.getElementById("crev-paint-text");if(r){if(n.length===0){S(r,"No style differences \u2014 already identical"),setTimeout(()=>te(e),2e3);return}S(r,b("div",{style:"margin-bottom:3px"},"Style changes:"),...n.map(o=>b("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},b("b",null,o.prop),": ",o.from," \u2192 ",o.to)),b("div",{style:"margin-top:4px"},b("button",{class:"crev-paint-apply-btn",onClick:()=>{E({type:"PAINT_CONFIRM",rid:t}),S(r,"Applying\u2026")}},"Apply"),b("button",{class:"crev-paint-cancel-btn",onClick:()=>te(e)},"Cancel")))}}var Ge=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),je=new Set(["expression","html","javascript"]),We=6;function Ce(e,t,n){e.tooltipHideTimer&&(clearTimeout(e.tooltipHideTimer),e.tooltipHideTimer=null);let r=document.getElementById("crev-tooltip");if(!r)return;let o=e.enrichments.get(n),s=V(o?.type),u=N(o?.type),m=o?.type??(e.requestedRids.has(n)?"Loading\u2026":"Unknown");S(r,b("div",{class:"crev-tt-type",style:`background:${s}`},u)," ",b("span",{style:"color:#8d8d8d;font-size:10px"},m),o?.name&&b("div",{class:"crev-tt-name"},o.name),o?.businessId&&b("div",{class:"crev-tt-row"},`ID: ${o.businessId}`),b("div",{class:"crev-tt-row"},`RID: ${n}`)),r.style.top="-9999px",r.style.left="-9999px",r.style.display="block";let d=t.getBoundingClientRect(),c=r.getBoundingClientRect(),p=d.bottom+4,f=d.left;p+c.height>window.innerHeight&&(p=d.top-c.height-4),p<4&&(p=4),f+c.width>window.innerWidth&&(f=window.innerWidth-c.width-4),f<0&&(f=4),r.style.top=`${p}px`,r.style.left=`${f}px`}function xe(e){e.tooltipHideTimer&&clearTimeout(e.tooltipHideTimer),e.tooltipHideTimer=setTimeout(()=>{let t=document.getElementById("crev-tooltip");t&&(t.style.display="none"),e.tooltipHideTimer=null},50)}function G(e){if(e.technicalOverlay){let t=[];for(let n of document.querySelectorAll("[data-crev-label]")){let r=n.getAttribute("data-crev-label");r&&!e.overlayProps.has(r)&&t.push(r)}if(t.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:t},n=>{if(!chrome.runtime.lastError&&n?.type==="OVERLAY_PROPS_DATA"&&n.props){for(let[r,o]of Object.entries(n.props))e.overlayProps.set(r,o);Y(e)}})}catch{}}Y(e)}function Y(e){for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");if(!n)continue;let r=e.enrichments.get(n),o=t.querySelector(".crev-label-text");if(o)if(e.technicalOverlay){t.classList.add("crev-label--card");let s=r?.type??"Unknown",u=r?.businessId??"",m=r?.name??"unnamed",d=n.length>12?n.slice(0,6)+"\u2026"+n.slice(-4):n;o.innerHTML="";let c=document.createElement("span");c.className="crev-card-line crev-card-type",c.textContent=u?`${s} | ${u}`:s;let p=document.createElement("span");p.className="crev-card-line",p.textContent=m;let f=document.createElement("span");f.className="crev-card-line crev-card-rid",f.textContent=d,o.appendChild(c),o.appendChild(p),o.appendChild(f);let a=e.overlayProps.get(n);if(a){let y=Object.entries(a).filter(([h])=>!Ge.has(h));if(y.length>0){let h=document.createElement("span");h.className="crev-card-sep",o.appendChild(h);let T=0;for(let[x,A]of y){if(T>=We)break;let O=document.createElement("span");if(O.className="crev-card-line crev-card-prop",je.has(x)){let L=A.split(`
`).length;O.textContent=`${x}: ${L} line${L!==1?"s":""}`}else{let L=A.length>30?A.slice(0,27)+"\u2026":A;O.textContent=`${x}: ${L}`}o.appendChild(O),T++}}}}else t.classList.remove("crev-label--card"),o.innerHTML="",o.textContent=r?.businessId??r?.name??N(r?.type)}}function Se(e,t){e.observer||(e.observer=new MutationObserver(n=>{n.every(o=>o.type!=="childList"||o.removedNodes.length>0?!1:Array.from(o.addedNodes).every(s=>s instanceof HTMLElement&&(s.classList.contains("crev-label")||s.id==="crev-tooltip")))||(window.location.href!==e.lastUrl&&(e.lastUrl=window.location.href,e.resetOverlays(),e.resetDiscovery(),t()),e.inspectActive&&(e.debounceTimer&&clearTimeout(e.debounceTimer),e.debounceTimer=setTimeout(()=>w(e),150)))}),e.observer.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=e.observer)}var i=new U;function re(e){i.inspectActive=e,e?(ze(),w(i)):(i.debounceTimer&&(clearTimeout(i.debounceTimer),i.debounceTimer=null),q(i),i.requestedRids.clear(),R())}function ze(){if(i.styleInjected)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=ge,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!i.inspectActive)return;let o=r.target.closest?.(".crev-outline");if(o!==i.hoveredOutlineEl)if(i.hoveredOutlineEl=o,o){let u=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");u&&Ce(i,o,u)}else xe(i)});let n=b("div",{id:"crev-paint-banner"},b("span",{id:"crev-paint-text"},"Paint Format"),b("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>E({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),i.styleInjected=!0}function Xe(e){let t=i.prevConnDisplay;i.prevConnDisplay=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";i.lastDetection?.isBmp&&de(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?_(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?_("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?_("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&_("Server down","error"))}function Ke(e){_(`Switched to ${e}`,"info"),i.overlayProps.clear(),Y(i),i.technicalOverlay&&G(i),i.lastDetection?.isBmp&&H(e,"connected")}function _e(){let e=$();i.lastDetection=e,E({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}function Qe(){let e=oe(),t=i.lastDetection??$(),n=t.isBmp?ie():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}ce(e=>{switch(e.type){case"INSPECT_STATE":re(e.active),i.fromSync||B("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))i.enrichments.set(t,n);i.inspectActive&&he(i);break;case"PAINT_STATE":i.paintPhase=e.phase,i.paintSourceName=e.sourceName??null,ne(i),i.fromSync||B("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":Te(i,e.rid,e.diff);break;case"PAINT_APPLY_RESULT":Ee(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==i.enrichMode&&(i.enrichMode=e.mode,i.inspectActive&&(i.requestedRids.clear(),q(i),w(i)));break;case"RE_ENRICH":i.requestedRids.clear(),i.inspectActive&&w(i);break;case"CONNECTION_STATE":Xe(e.state);break;case"PROFILE_SWITCHED":Ke(e.label),i.fromSync||B("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":i.technicalOverlay=e.active,G(i),i.fromSync||B("crev_sync_overlay",{active:e.active});break}});le(()=>{if(i.requestedRids.clear(),i.lastDetection){let e=i.lastDetection;queueMicrotask(()=>{E({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}i.inspectActive&&w(i)});F("crev_sync_inspect",e=>{let t=e;if(t.active!==i.inspectActive){i.fromSync=!0;try{re(t.active)}finally{i.fromSync=!1}}});F("crev_sync_paint",e=>{let t=e;i.fromSync=!0;try{i.paintPhase=t.phase,i.paintSourceName=t.sourceName??null,ne(i)}finally{i.fromSync=!1}});F("crev_sync_overlay",e=>{let t=e;if(t.active!==i.technicalOverlay){i.fromSync=!0;try{i.technicalOverlay=t.active,G(i)}finally{i.fromSync=!1}}});F("crev_sync_profile",e=>{let t=e;i.fromSync=!0,i.lastDetection?.isBmp&&H(t.label,t.connected!==!1?"connected":"disconnected"),i.fromSync=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=i.enrichments.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){v.swallow("content:contextmenu",o)}}}},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&J()&&R()});document.addEventListener("click",e=>{!J()||e.target.closest("#crev-quick-inspector")||R()},!0);document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&E(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(i.lastDetection&&n.length>0){let r=[...i.lastDetection.signals,...n],o=n.length*.15,s=Math.min(1,i.lastDetection.confidence+o),u=s>=.5;E({type:"DETECTION_RESULT",confidence:s,signals:r,isBmp:u})}}}));chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return re(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=Qe();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>v.swallow("content:clipboardWrite",r)),!1});function Je(){i.observer?.disconnect(),q(i),R(),pe(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),i.styleInjected=!1}window.__crev_content_loaded&&Je();window.__crev_content_loaded=!0;try{K()}catch(e){v.swallow("content:init:port",e)}try{_e()}catch(e){v.swallow("content:init:detection",e)}try{Se(i,_e)}catch(e){v.swallow("content:init:observer",e)}})();
