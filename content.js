"use strict";(()=>{var he=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],Be="#33b1ff",Ve={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},Fe={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(he.map(e=>[e,Be]))},Ue={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...Ve},ve="#8d8d8d";function Q(e){return e?Fe[e]??ve:ve}function F(e){return e?Ue[e]??e.substring(0,3).toUpperCase():"?"}var Ye={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(he.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},ne=new Set(Object.keys(Ye));function Te(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function Ge(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function qe(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function re(e=!0){let t=Ge();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of qe())n.has(r.element)||(t.push(r),n.add(r.element));return t}function xe(){let e=[],t=new Set;for(let{element:n,rid:r}of re()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),i=n.getAttribute("data-test");e.push({rid:r,name:i??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var je=.5;function oe(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=je,confidence:t,signals:e.map(n=>n.name)}}function m(e,t,...n){let r=document.createElement(e);if(t)for(let[o,i]of Object.entries(t))i==null||i===!1||(o.startsWith("on")&&typeof i=="function"?r.addEventListener(o.slice(2).toLowerCase(),i):o==="class"||o==="className"?r.className=String(i):o==="style"?r.setAttribute("style",String(i)):o==="checked"||o==="disabled"||o==="readOnly"?i===!0&&(r[o]=!0):o==="value"?r.value=String(i):r.setAttribute(o,i===!0?"":String(i)));return ie(r,n),r}function C(e,...t){e.textContent="",ie(e,t)}function ie(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?ie(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var U="[CREV]",y={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${U}:${e}`,...t)},info(e,...t){console.info(`${U}:${e}`,...t)},warn(e,t,...n){console.warn(`${U}:${e}`,t,...n)},error(e,t,...n){console.error(`${U}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${U}:${e} [swallowed]`,t)}};var I=null,Y=200,_=[],Ce=null,_e=null;function Se(e){Ce=e}function Ie(e){_e=e}function ae(){try{I=chrome.runtime.connect({name:"content"}),Y=200}catch(e){y.swallow("port:connect",e);return}I.onMessage.addListener(e=>{Ce?.(e)}),We(),I.onDisconnect.addListener(()=>{I=null;try{chrome.runtime.getURL("");let e=Y>200;setTimeout(()=>{if(ae(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);_e?.()},Y),Y=Math.min(Y*2,1e4)}catch(e){y.swallow("port:reconnectCheck",e)}})}function v(e){if(I)try{I.postMessage(e);return}catch(t){y.swallow("port:send",t),I=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>y.swallow("port:oneShot",t))}catch(t){y.swallow("port:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"){if(e.type==="DETECTION_RESULT"){let t=_.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&_.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=_[_.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}for(_.push(e);_.length>20;)_.shift()}}function We(){for(;_.length>0;){let e=_.shift();try{I?.postMessage(e)}catch(t){y.swallow("port:flush",t);break}}}var Xe="crev-env-tag",ce="crev_env_tag_pos",s=null,M=null,N=null;function Re(e,t){if(s){G(e,t);return}s=document.createElement("div"),s.id=Xe,M=document.createElement("span"),M.className="crev-env-dot",N=document.createElement("span"),N.className="crev-env-label",s.appendChild(M),s.appendChild(N),document.body.appendChild(s),G(e,t),chrome.storage.local.get(ce,c=>{let p=c[ce];p&&s&&(s.style.bottom=`${p.bottom??12}px`,s.style.top="auto",p.snap==="left"?(s.classList.add("crev-env-tag--edge-left"),s.style.left="0",s.style.right="auto"):p.snap==="right"?(s.classList.add("crev-env-tag--edge-right"),s.style.right="0",s.style.left="auto"):(s.style.right=`${p.right??12}px`,s.style.left="auto"))});let n=!1,r=0,o=0,i=0,u=0;s.addEventListener("mousedown",c=>{if(c.button===0){if(c.preventDefault(),n=!0,r=c.clientX,o=c.clientY,s){s.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let p=s.getBoundingClientRect();i=window.innerWidth-p.right,u=window.innerHeight-p.bottom,s.style.right=`${i}px`,s.style.bottom=`${u}px`,s.style.left="auto",s.style.top="auto"}document.addEventListener("mousemove",l),document.addEventListener("mouseup",d)}});function l(c){if(!n||!s)return;let p=c.clientX-r,g=c.clientY-o,a=Math.max(0,i-p),b=Math.max(0,u-g);s.style.right=`${a}px`,s.style.bottom=`${b}px`,s.style.left="auto",s.style.top="auto"}function d(){if(n=!1,document.removeEventListener("mousemove",l),document.removeEventListener("mouseup",d),!s)return;let c=s.getBoundingClientRect(),p=c.left+c.width/2,g=window.innerWidth;s.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let a=null;p<g*.15?(a="left",s.classList.add("crev-env-tag--edge-left"),s.style.left="0",s.style.right="auto"):p>g*.85&&(a="right",s.classList.add("crev-env-tag--edge-right"),s.style.right="0",s.style.left="auto");let b=s.getBoundingClientRect(),P={right:Math.round(window.innerWidth-b.right),bottom:Math.round(window.innerHeight-b.bottom)};a&&(P.snap=a),chrome.storage.local.set({[ce]:P}).catch(()=>{})}}function G(e,t){M&&(M.className=`crev-env-dot crev-env-dot--${t}`),N&&(N.textContent=e||"CREV")}function we(){s?.remove(),s=null,M=null,N=null}var Ae="crev-toast-container";function ze(){let e=document.getElementById(Ae);return e||(e=document.createElement("div"),e.id=Ae,document.body.appendChild(e)),e}function k(e,t){let n=ze(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var Je="crev-quick-inspector",f=null,Oe=null;function Le(e,t,n,r,o){if(R(),Oe=t.rid,f=document.createElement("div"),f.id=Je,t.type){let a=document.createElement("span");a.className="crev-qi-badge",a.textContent=t.type,f.appendChild(a)}if(t.name){let a=document.createElement("div");a.className="crev-qi-name",a.textContent=t.name,f.appendChild(a)}if(t.businessId){let a=document.createElement("div");a.className="crev-qi-row",a.textContent=`ID: ${t.businessId}`,f.appendChild(a)}let i=document.createElement("div");i.className="crev-qi-row crev-qi-rid",i.textContent=`RID: ${t.rid}`,f.appendChild(i);let u=document.createElement("button");u.className=`crev-qi-star${t.isFavorite?" active":""}`,u.textContent=t.isFavorite?"\u2605":"\u2606",u.title=t.isFavorite?"Remove from pinned":"Pin this object",u.addEventListener("click",a=>{a.stopPropagation(),r?.(t.rid);let b=u.classList.toggle("active");u.textContent=b?"\u2605":"\u2606"}),f.appendChild(u);let l=document.createElement("div");l.className="crev-qi-actions";let d=document.createElement("button");d.className="crev-qi-btn",d.textContent="Copy RID",d.addEventListener("click",a=>{a.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{d.textContent="\u2713",setTimeout(()=>{d.textContent="Copy RID"},600)}).catch(()=>{})});let c=document.createElement("button");c.className="crev-qi-btn",c.textContent="Copy ID",c.addEventListener("click",a=>{a.stopPropagation();let b=t.businessId??t.rid;navigator.clipboard.writeText(b).then(()=>{c.textContent="\u2713",setTimeout(()=>{c.textContent="Copy ID"},600)}).catch(()=>{})});let p=document.createElement("button");p.className="crev-qi-btn crev-qi-btn--accent",p.textContent="Editor",p.addEventListener("click",a=>{a.stopPropagation(),n(t.rid),R()});let g=document.createElement("button");g.className="crev-qi-btn",g.textContent="Full View",g.addEventListener("click",a=>{a.stopPropagation(),o?.(t.rid),R()}),l.appendChild(d),l.appendChild(c),l.appendChild(p),l.appendChild(g),f.appendChild(l),document.body.appendChild(f),Ke(e)}function Ke(e){if(!f)return;f.style.top="-9999px",f.style.left="-9999px",f.style.display="block";let t=e.getBoundingClientRect(),n=f.getBoundingClientRect(),r=6,o=t.bottom+r,i=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),i+n.width>window.innerWidth-r&&(i=window.innerWidth-n.width-r),i<r&&(i=r),f.style.top=`${o}px`,f.style.left=`${i}px`}function R(){f?.remove(),f=null,Oe=null}function le(){return f!=null}var de=new Map;function q(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function j(e,t){let n=de.get(e);n||(n=[],de.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=de.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var Pe=`.crev-outline {
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
.crev-ec-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 6px;
  margin-left: 2px;
  border: 1px solid rgba(0,0,0,0.3);
  background: rgba(255,255,255,0.2);
  color: #fff;
  font: 700 10px/1.2 'SF Mono', 'Cascadia Code', Consolas, monospace;
  border-radius: 3px;
  cursor: pointer;
  letter-spacing: -0.5px;
}
.crev-ec-btn:hover { background: rgba(255,255,255,0.4); border-color: rgba(255,255,255,0.8); }
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
  z-index: 2147483647;
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
`;var A=!1,te="all",L="off",me=null,Z=null,pe=!1,h=new Map,X=new Map,ue=new WeakSet,T=new Set,ee=new Set,Me=window.location.href,x=null,O=null,D=null,ge=null,Ne=null,B=!1,$=new Set,w=null,W=null,E=!1;Se(e=>{switch(e.type){case"INSPECT_STATE":ye(e.active),E||q("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))h.set(t,n);A&&ot();break;case"PAINT_STATE":L=e.phase,me=e.sourceName??null,De(),E||q("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":at(e.rid,e.diff);break;case"PAINT_APPLY_RESULT":st(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==te&&(te=e.mode,A&&(T.clear(),be(),z()));break;case"RE_ENRICH":T.clear(),A&&z();break;case"CONNECTION_STATE":tt(e.state);break;case"PROFILE_SWITCHED":nt(e.label),E||q("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":B=e.active,Ee(),E||q("crev_sync_overlay",{active:e.active});break}});Ie(()=>{if(T.clear(),x){let e=x;queueMicrotask(()=>{v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}A&&z()});function tt(e){let t=Ne;Ne=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";x?.isBmp&&Re(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?k(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?k("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?k("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&k("Server down","error"))}function nt(e){k(`Switched to ${e}`,"info"),X.clear(),fe(),B&&Ee(),x?.isBmp&&G(e,"connected")}function ye(e){A=e,e?(rt(),z()):(D&&(clearTimeout(D),D=null),be(),T.clear(),R())}function rt(){if(pe)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=Pe,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!A)return;let o=r.target.closest?.(".crev-outline");if(o!==ge)if(ge=o,o){let u=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");u&&ct(o,u)}else lt()});let n=m("div",{id:"crev-paint-banner"},m("span",{id:"crev-paint-text"},"Paint Format"),m("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>v({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),pe=!0}function ke(e,t){let n=document.createElement("button");return n.className="crev-ec-btn",n.textContent=t==="CustomVisualization"?"</>":"EC",n.title="Open in editor",n.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n}function z(){for(let l of document.querySelectorAll(".crev-label"))(!l.parentElement||!document.body.contains(l.parentElement))&&l.remove();let e=te==="all",t=re(e),n=e?t.filter(({element:l})=>l.tagName==="A").length:0;y.debug("sync",`syncOverlays: ${t.length} elements (${n} links), enrichMode=${te}`);let r=[],o=t.filter(({element:l})=>!ue.has(l));for(let{element:l,rid:d}of o){let c=h.get(d),p=Q(c?.type);l.classList.add("crev-outline"),l.style.setProperty("--crev-color",p);let g=document.createElement("span");g.className="crev-label",c||g.classList.add("crev-label-loading"),g.setAttribute("data-crev-label",d);let a=document.createElement("span");a.className="crev-label-text",a.textContent=c?.businessId??c?.name??F(c?.type),g.appendChild(a),a.addEventListener("click",b=>{if(b.preventDefault(),b.stopPropagation(),L==="picking"){v({type:"PAINT_PICK",rid:d}),g.classList.add("crev-label-flash-pick"),setTimeout(()=>{g.classList.remove("crev-label-flash-pick")},400);return}if(L==="applying"){v({type:"PAINT_APPLY",rid:d});return}if(W===d&&w){clearTimeout(w),w=null,W=null,it(g,d);return}W=d,w=setTimeout(()=>{w=null,W=null;let V=h.get(d)?.businessId??d;navigator.clipboard.writeText(V).then(()=>{let S=a.textContent;a.textContent="\u2713",g.classList.add("crev-label-flash-ok"),setTimeout(()=>{a.textContent=S,g.classList.remove("crev-label-flash-ok")},600)}).catch(S=>y.swallow("content:clipboard",S))},250)}),c?.type&&ne.has(c.type)&&g.appendChild(ke(d,c.type)),l.appendChild(g),ue.add(l),!h.has(d)&&!T.has(d)&&(r.push(d),T.add(d))}for(let{rid:l}of t)!h.has(l)&&!T.has(l)&&(r.push(l),T.add(l));r.length>0&&(y.debug("sync",`ENRICH_BADGES: sending ${r.length} RIDs`,r),v({type:"ENRICH_BADGES",rids:r}));let i=Date.now(),u=[];for(let{rid:l}of t)!ee.has(l)&&ee.size<5e3&&(ee.add(l),u.push({rid:l,source:"dom",discoveredAt:i,updatedAt:i}));u.length>0&&v({type:"OBJECTS_DISCOVERED",objects:u})}function be(){for(let t of document.querySelectorAll(".crev-label"))t.remove();for(let t of document.querySelectorAll(".crev-outline"))t.classList.remove("crev-outline"),t.style.removeProperty("--crev-color");let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),ge=null,ue=new WeakSet,X.clear()}function ot(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=h.get(t);if(n){let r=e.querySelector(".crev-label-text");r&&(r.textContent=n.businessId??n.name??F(n.type)),e.classList.remove("crev-label-loading");let o=e.parentElement;if(o){let i=Q(n.type);o.style.setProperty("--crev-color",i)}n.type&&ne.has(n.type)&&!e.querySelector(".crev-ec-btn")&&e.appendChild(ke(t,n.type))}}}function it(e,t){let n=h.get(t);chrome.runtime.sendMessage({type:"GET_FAVORITES"},r=>{r?.entries&&($=new Set(r.entries.map(o=>o.rid))),Le(e,{rid:t,businessId:n?.businessId,type:n?.type,name:n?.name,isFavorite:$.has(t)},o=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:o})},o=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:o,name:n?.name,objectType:n?.type,businessId:n?.businessId}),$.has(o)?$.delete(o):$.add(o)},o=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:o})})})}document.addEventListener("keydown",e=>{e.key==="Escape"&&le()&&R()});document.addEventListener("click",e=>{!le()||e.target.closest("#crev-quick-inspector")||R()},!0);function H(...e){let t=document.getElementById("crev-paint-banner"),n=document.getElementById("crev-paint-text");if(!(!t||!n)){if(L==="off"){t.style.display="none";return}if(t.style.display="block",t.style.background="#ff832b",e.length>0){C(n,...e);return}L==="picking"?C(n,"Paint Format \u2014 ",m("b",null,"click a widget to pick its style")):C(n,"Paint Format from ",m("b",null,me??"?")," \u2014 click widgets to apply")}}function De(){let e=L!=="off"?"crosshair":"pointer";for(let t of document.querySelectorAll(".crev-label-text"))t.style.cursor=e;H()}function st(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let i=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(i),setTimeout(()=>{r.classList.remove(i)},600)}let o=document.getElementById("crev-paint-banner");if(o)if(t)H("Applied style \u2014 ",m("b",null,"refresh page to see changes")),setTimeout(()=>H(),3e3);else{o.style.background="#da1e28";let i=document.getElementById("crev-paint-text");if(i){let u=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Error: ${n??"unknown"}`;C(i,u)}setTimeout(()=>{o.style.background="#ff832b",H()},4e3)}}function at(e,t){let n=document.getElementById("crev-paint-text");if(n){if(t.length===0){C(n,"No style differences \u2014 already identical"),setTimeout(()=>H(),2e3);return}C(n,m("div",{style:"margin-bottom:3px"},"Style changes:"),...t.map(r=>m("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},m("b",null,r.prop),": ",r.from," \u2192 ",r.to)),m("div",{style:"margin-top:4px"},m("button",{class:"crev-paint-apply-btn",onClick:()=>{v({type:"PAINT_CONFIRM",rid:e}),C(n,"Applying\u2026")}},"Apply"),m("button",{class:"crev-paint-cancel-btn",onClick:()=>H()},"Cancel")))}}function ct(e,t){O&&(clearTimeout(O),O=null);let n=document.getElementById("crev-tooltip");if(!n)return;let r=h.get(t),o=Q(r?.type),i=F(r?.type),u=r?.type??(T.has(t)?"Loading\u2026":"Unknown");C(n,m("div",{class:"crev-tt-type",style:`background:${o}`},i)," ",m("span",{style:"color:#8d8d8d;font-size:10px"},u),r?.name&&m("div",{class:"crev-tt-name"},r.name),r?.businessId&&m("div",{class:"crev-tt-row"},`ID: ${r.businessId}`),m("div",{class:"crev-tt-row"},`RID: ${t}`)),n.style.top="-9999px",n.style.left="-9999px",n.style.display="block";let l=e.getBoundingClientRect(),d=n.getBoundingClientRect(),c=l.bottom+4,p=l.left;c+d.height>window.innerHeight&&(c=l.top-d.height-4),c<4&&(c=4),p+d.width>window.innerWidth&&(p=window.innerWidth-d.width-4),p<0&&(p=4),n.style.top=`${c}px`,n.style.left=`${p}px`}function lt(){O&&clearTimeout(O),O=setTimeout(()=>{let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),O=null},50)}j("crev_sync_inspect",e=>{let t=e;if(t.active!==A){E=!0;try{ye(t.active)}finally{E=!1}}});j("crev_sync_paint",e=>{let t=e;E=!0;try{L=t.phase,me=t.sourceName??null,De()}finally{E=!1}});j("crev_sync_overlay",e=>{let t=e;if(t.active!==B){E=!0;try{B=t.active,Ee()}finally{E=!1}}});j("crev_sync_profile",e=>{let t=e;E=!0,x?.isBmp&&G(t.label,t.connected!==!1?"connected":"disconnected"),E=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=h.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){y.swallow("content:contextmenu",o)}}}},!0);var dt=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),pt=new Set(["expression","html","javascript"]),ut=6;function Ee(){if(B){let e=[];for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");n&&!X.has(n)&&e.push(n)}if(e.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:e},t=>{if(!chrome.runtime.lastError&&t?.type==="OVERLAY_PROPS_DATA"&&t.props){for(let[n,r]of Object.entries(t.props))X.set(n,r);fe()}})}catch(t){y.swallow("content:getOverlayProps",t)}}fe()}function fe(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=h.get(t),r=e.querySelector(".crev-label-text");if(r)if(B){e.classList.add("crev-label--card");let o=n?.type??"Unknown",i=n?.businessId??"",u=n?.name??"unnamed",l=t.length>12?t.slice(0,6)+"\u2026"+t.slice(-4):t;r.innerHTML="";let d=document.createElement("span");d.className="crev-card-line crev-card-type",d.textContent=i?`${o} | ${i}`:o;let c=document.createElement("span");c.className="crev-card-line",c.textContent=u;let p=document.createElement("span");p.className="crev-card-line crev-card-rid",p.textContent=l,r.appendChild(d),r.appendChild(c),r.appendChild(p);let g=X.get(t);if(g){let a=Object.entries(g).filter(([b])=>!dt.has(b));if(a.length>0){let b=document.createElement("span");b.className="crev-card-sep",r.appendChild(b);let P=0;for(let[V,S]of a){if(P>=ut)break;let J=document.createElement("span");if(J.className="crev-card-line crev-card-prop",pt.has(V)){let K=S.split(`
`).length;J.textContent=`${V}: ${K} line${K!==1?"s":""}`}else{let K=S.length>30?S.slice(0,27)+"\u2026":S;J.textContent=`${V}: ${K}`}r.appendChild(J),P++}}}}else e.classList.remove("crev-label--card"),r.innerHTML="",r.textContent=n?.businessId??n?.name??F(n?.type)}}function gt(){Z||(Z=new MutationObserver(e=>{e.every(n=>n.type!=="childList"||n.removedNodes.length>0?!1:Array.from(n.addedNodes).every(r=>r instanceof HTMLElement&&(r.classList.contains("crev-label")||r.id==="crev-tooltip")))||(window.location.href!==Me&&(Me=window.location.href,T.clear(),ee.clear(),w&&(clearTimeout(w),w=null,W=null),He()),A&&(D&&clearTimeout(D),D=setTimeout(()=>z(),150)))}),Z.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=Z)}function He(){let e=oe();x=e,v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&v(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(x&&n.length>0){let r=[...x.signals,...n],o=n.length*.15,i=Math.min(1,x.confidence+o),u=i>=.5;v({type:"DETECTION_RESULT",confidence:i,signals:r,isBmp:u})}}}));function ft(){let e=Te(),t=x??oe(),n=t.isBmp?xe():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return ye(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=ft();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>y.swallow("content:clipboardWrite",r)),!1});function mt(){window.__crev_observer?.disconnect(),be(),R(),we(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),pe=!1}window.__crev_content_loaded&&mt();window.__crev_content_loaded=!0;try{ae()}catch(e){y.swallow("content:init:port",e)}try{He()}catch(e){y.swallow("content:init:detection",e)}try{gt()}catch(e){y.swallow("content:init:observer",e)}})();
