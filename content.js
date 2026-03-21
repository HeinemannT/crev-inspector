"use strict";(()=>{var he=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],Be="#33b1ff",Ve={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},Fe={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(he.map(e=>[e,Be]))},Ue={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...Ve},ve="#8d8d8d";function K(e){return e?Fe[e]??ve:ve}function V(e){return e?Ue[e]??e.substring(0,3).toUpperCase():"?"}var Ye={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(he.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},te=new Set(Object.keys(Ye));function Te(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function Ge(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function qe(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function ne(e=!0){let t=Ge();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of qe())n.has(r.element)||(t.push(r),n.add(r.element));return t}function xe(){let e=[],t=new Set;for(let{element:n,rid:r}of ne()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),s=n.getAttribute("data-test");e.push({rid:r,name:s??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var je=.5;function re(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=je,confidence:t,signals:e.map(n=>n.name)}}function m(e,t,...n){let r=document.createElement(e);if(t)for(let[o,s]of Object.entries(t))s==null||s===!1||(o.startsWith("on")&&typeof s=="function"?r.addEventListener(o.slice(2).toLowerCase(),s):o==="class"||o==="className"?r.className=String(s):o==="style"?r.setAttribute("style",String(s)):o==="checked"||o==="disabled"||o==="readOnly"?s===!0&&(r[o]=!0):o==="value"?r.value=String(s):r.setAttribute(o,s===!0?"":String(s)));return oe(r,n),r}function S(e,...t){e.textContent="",oe(e,t)}function oe(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?oe(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var F="[CREV]",y={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${F}:${e}`,...t)},info(e,...t){console.info(`${F}:${e}`,...t)},warn(e,t,...n){console.warn(`${F}:${e}`,t,...n)},error(e,t,...n){console.error(`${F}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${F}:${e} [swallowed]`,t)}};var I=null,U=200,C=[],Ce=null,_e=null;function Se(e){Ce=e}function Ie(e){_e=e}function se(){try{I=chrome.runtime.connect({name:"content"}),U=200}catch(e){y.swallow("port:connect",e);return}I.onMessage.addListener(e=>{Ce?.(e)}),We(),I.onDisconnect.addListener(()=>{I=null;try{chrome.runtime.getURL("");let e=U>200;setTimeout(()=>{if(se(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);_e?.()},U),U=Math.min(U*2,1e4)}catch(e){y.swallow("port:reconnectCheck",e)}})}function v(e){if(I)try{I.postMessage(e);return}catch(t){y.swallow("port:send",t),I=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>y.swallow("port:oneShot",t))}catch(t){y.swallow("port:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"){if(e.type==="DETECTION_RESULT"){let t=C.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&C.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=C[C.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}for(C.push(e);C.length>20;)C.shift()}}function We(){for(;C.length>0;){let e=C.shift();try{I?.postMessage(e)}catch(t){y.swallow("port:flush",t);break}}}var Xe="crev-env-tag",ae="crev_env_tag_pos",i=null,N=null,k=null;function Re(e,t){if(i){Y(e,t);return}i=document.createElement("div"),i.id=Xe,N=document.createElement("span"),N.className="crev-env-dot",k=document.createElement("span"),k.className="crev-env-label",i.appendChild(N),i.appendChild(k),document.body.appendChild(i),Y(e,t),chrome.storage.local.get(ae,c=>{let p=c[ae];p&&i&&(i.style.bottom=`${p.bottom??12}px`,i.style.top="auto",p.snap==="left"?(i.classList.add("crev-env-tag--edge-left"),i.style.left="0",i.style.right="auto"):p.snap==="right"?(i.classList.add("crev-env-tag--edge-right"),i.style.right="0",i.style.left="auto"):(i.style.right=`${p.right??12}px`,i.style.left="auto"))});let n=!1,r=0,o=0,s=0,u=0;i.addEventListener("mousedown",c=>{if(c.button===0){if(c.preventDefault(),n=!0,r=c.clientX,o=c.clientY,i){i.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let p=i.getBoundingClientRect();s=window.innerWidth-p.right,u=window.innerHeight-p.bottom,i.style.right=`${s}px`,i.style.bottom=`${u}px`,i.style.left="auto",i.style.top="auto"}document.addEventListener("mousemove",l),document.addEventListener("mouseup",d)}});function l(c){if(!n||!i)return;let p=c.clientX-r,g=c.clientY-o,a=Math.max(0,s-p),b=Math.max(0,u-g);i.style.right=`${a}px`,i.style.bottom=`${b}px`,i.style.left="auto",i.style.top="auto"}function d(){if(n=!1,document.removeEventListener("mousemove",l),document.removeEventListener("mouseup",d),!i)return;let c=i.getBoundingClientRect(),p=c.left+c.width/2,g=window.innerWidth;i.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let a=null;p<g*.15?(a="left",i.classList.add("crev-env-tag--edge-left"),i.style.left="0",i.style.right="auto"):p>g*.85&&(a="right",i.classList.add("crev-env-tag--edge-right"),i.style.right="0",i.style.left="auto");let b=i.getBoundingClientRect(),M={right:Math.round(window.innerWidth-b.right),bottom:Math.round(window.innerHeight-b.bottom)};a&&(M.snap=a),chrome.storage.local.set({[ae]:M}).catch(()=>{})}}function Y(e,t){N&&(N.className=`crev-env-dot crev-env-dot--${t}`),k&&(k.textContent=e||"CREV")}function we(){i?.remove(),i=null,N=null,k=null}var Ae="crev-toast-container";function ze(){let e=document.getElementById(Ae);return e||(e=document.createElement("div"),e.id=Ae,document.body.appendChild(e)),e}function R(e,t){let n=ze(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var Je="crev-quick-inspector",f=null,Oe=null;function Le(e,t,n,r,o){if(w(),Oe=t.rid,f=document.createElement("div"),f.id=Je,t.type){let a=document.createElement("span");a.className="crev-qi-badge",a.textContent=t.type,f.appendChild(a)}if(t.name){let a=document.createElement("div");a.className="crev-qi-name",a.textContent=t.name,f.appendChild(a)}if(t.businessId){let a=document.createElement("div");a.className="crev-qi-row",a.textContent=`ID: ${t.businessId}`,f.appendChild(a)}let s=document.createElement("div");s.className="crev-qi-row crev-qi-rid",s.textContent=`RID: ${t.rid}`,f.appendChild(s);let u=document.createElement("button");u.className=`crev-qi-star${t.isFavorite?" active":""}`,u.textContent=t.isFavorite?"\u2605":"\u2606",u.title=t.isFavorite?"Remove from pinned":"Pin this object",u.addEventListener("click",a=>{a.stopPropagation(),r?.(t.rid);let b=u.classList.toggle("active");u.textContent=b?"\u2605":"\u2606"}),f.appendChild(u);let l=document.createElement("div");l.className="crev-qi-actions";let d=document.createElement("button");d.className="crev-qi-btn",d.textContent="Copy RID",d.addEventListener("click",a=>{a.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{d.textContent="\u2713",setTimeout(()=>{d.textContent="Copy RID"},600)}).catch(()=>{})});let c=document.createElement("button");c.className="crev-qi-btn",c.textContent="Copy ID",c.addEventListener("click",a=>{a.stopPropagation();let b=t.businessId??t.rid;navigator.clipboard.writeText(b).then(()=>{c.textContent="\u2713",setTimeout(()=>{c.textContent="Copy ID"},600)}).catch(()=>{})});let p=document.createElement("button");p.className="crev-qi-btn crev-qi-btn--accent",p.textContent="Editor",p.addEventListener("click",a=>{a.stopPropagation(),n(t.rid),w()});let g=document.createElement("button");g.className="crev-qi-btn",g.textContent="Full View",g.addEventListener("click",a=>{a.stopPropagation(),o?.(t.rid),w()}),l.appendChild(d),l.appendChild(c),l.appendChild(p),l.appendChild(g),f.appendChild(l),document.body.appendChild(f),Ke(e)}function Ke(e){if(!f)return;f.style.top="-9999px",f.style.left="-9999px",f.style.display="block";let t=e.getBoundingClientRect(),n=f.getBoundingClientRect(),r=6,o=t.bottom+r,s=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),s+n.width>window.innerWidth-r&&(s=window.innerWidth-n.width-r),s<r&&(s=r),f.style.top=`${o}px`,f.style.left=`${s}px`}function w(){f?.remove(),f=null,Oe=null}function ce(){return f!=null}var le=new Map;function G(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function q(e,t){let n=le.get(e);n||(n=[],le.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=le.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var Pe=`.crev-outline {
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
`;var O=!1,ee="all",P="off",me=null,Q=null,de=!1,h=new Map,W=new Map,pe=new WeakSet,T=new Set,Z=new Set,Me=window.location.href,x=null,L=null,D=null,ue=null,Ne=null,H=!1,j=new Set,A=null,$=null,E=!1;Se(e=>{switch(e.type){case"INSPECT_STATE":ye(e.active),E||G("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))h.set(t,n);O&&ot();break;case"PAINT_STATE":P=e.phase,me=e.sourceName??null,De(),E||G("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":at(e.rid,e.diff);break;case"PAINT_APPLY_RESULT":st(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==ee&&(ee=e.mode,O&&(T.clear(),be(),X()));break;case"RE_ENRICH":T.clear(),O&&X();break;case"CONNECTION_STATE":tt(e.state);break;case"PROFILE_SWITCHED":nt(e.label),E||G("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":H=e.active,Ee(),E||G("crev_sync_overlay",{active:e.active});break}});Ie(()=>{if(T.clear(),x){let e=x;queueMicrotask(()=>{v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}O&&X()});function tt(e){let t=Ne;Ne=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";x?.isBmp&&Re(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?R(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?R("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?R("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&R("Server down","error"))}function nt(e){R(`Switched to ${e}`,"info"),W.clear(),fe(),H&&Ee(),x?.isBmp&&Y(e,"connected")}function ye(e){O=e,e?(rt(),X()):(D&&(clearTimeout(D),D=null),be(),T.clear(),w())}function rt(){if(de)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=Pe,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!O)return;let o=r.target.closest?.(".crev-outline");if(o!==ue)if(ue=o,o){let u=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");u&&ct(o,u)}else lt()});let n=m("div",{id:"crev-paint-banner"},m("span",{id:"crev-paint-text"},"Paint Format"),m("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>v({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),de=!0}function ke(e,t){let n=document.createElement("button");return n.className="crev-ec-btn",n.textContent=t==="CustomVisualization"?"</>":"EC",n.title="Open in editor",n.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n}function X(){for(let l of document.querySelectorAll(".crev-label"))(!l.parentElement||!document.body.contains(l.parentElement))&&l.remove();let e=ee==="all",t=ne(e),n=e?t.filter(({element:l})=>l.tagName==="A").length:0;y.debug("sync",`syncOverlays: ${t.length} elements (${n} links), enrichMode=${ee}`);let r=[],o=t.filter(({element:l})=>!pe.has(l));for(let{element:l,rid:d}of o){let c=h.get(d),p=K(c?.type);l.classList.add("crev-outline"),l.style.setProperty("--crev-color",p);let g=document.createElement("span");g.className="crev-label",c||g.classList.add("crev-label-loading"),g.setAttribute("data-crev-label",d);let a=document.createElement("span");a.className="crev-label-text",a.textContent=c?.businessId??c?.name??V(c?.type),g.appendChild(a),a.addEventListener("click",b=>{if(b.preventDefault(),b.stopPropagation(),P==="picking"){v({type:"PAINT_PICK",rid:d}),g.classList.add("crev-label-flash-pick"),setTimeout(()=>{g.classList.remove("crev-label-flash-pick")},400);return}if(P==="applying"){v({type:"PAINT_APPLY",rid:d});return}if($===d&&A){clearTimeout(A),A=null,$=null,it(g,d);return}$=d,A=setTimeout(()=>{A=null,$=null;let B=h.get(d)?.businessId??d;navigator.clipboard.writeText(B).then(()=>{let _=a.textContent;a.textContent="\u2713",g.classList.add("crev-label-flash-ok"),setTimeout(()=>{a.textContent=_,g.classList.remove("crev-label-flash-ok")},600)}).catch(_=>y.swallow("content:clipboard",_))},250)}),c?.type&&te.has(c.type)&&g.appendChild(ke(d,c.type)),l.appendChild(g),pe.add(l),!h.has(d)&&!T.has(d)&&(r.push(d),T.add(d))}for(let{rid:l}of t)!h.has(l)&&!T.has(l)&&(r.push(l),T.add(l));r.length>0&&(y.debug("sync",`ENRICH_BADGES: sending ${r.length} RIDs`,r),v({type:"ENRICH_BADGES",rids:r}));let s=Date.now(),u=[];for(let{rid:l}of t)!Z.has(l)&&Z.size<5e3&&(Z.add(l),u.push({rid:l,source:"dom",discoveredAt:s,updatedAt:s}));u.length>0&&v({type:"OBJECTS_DISCOVERED",objects:u})}function be(){for(let t of document.querySelectorAll(".crev-label"))t.remove();for(let t of document.querySelectorAll(".crev-outline"))t.classList.remove("crev-outline"),t.style.removeProperty("--crev-color");let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),ue=null,pe=new WeakSet,W.clear()}function ot(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=h.get(t);if(n){let r=e.querySelector(".crev-label-text");r&&(r.textContent=n.businessId??n.name??V(n.type)),e.classList.remove("crev-label-loading");let o=e.parentElement;if(o){let s=K(n.type);o.style.setProperty("--crev-color",s)}n.type&&te.has(n.type)&&!e.querySelector(".crev-ec-btn")&&e.appendChild(ke(t,n.type))}}}function it(e,t){let n=h.get(t);chrome.runtime.sendMessage({type:"GET_FAVORITES"},r=>{r?.entries&&(j=new Set(r.entries.map(o=>o.rid))),Le(e,{rid:t,businessId:n?.businessId,type:n?.type,name:n?.name,isFavorite:j.has(t)},o=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:o})},o=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:o,name:n?.name,objectType:n?.type,businessId:n?.businessId}),j.has(o)?j.delete(o):j.add(o)},o=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:o})})})}document.addEventListener("keydown",e=>{e.key==="Escape"&&ce()&&w()});document.addEventListener("click",e=>{!ce()||e.target.closest("#crev-quick-inspector")||w()},!0);function ge(...e){let t=document.getElementById("crev-paint-banner"),n=document.getElementById("crev-paint-text");if(!(!t||!n)){if(P==="off"){t.style.display="none";return}if(t.style.display="block",t.style.background="#ff832b",e.length>0){S(n,...e);return}P==="picking"?S(n,"Paint Format \u2014 ",m("b",null,"click a widget to pick its style")):S(n,"Paint Format from ",m("b",null,me??"?")," \u2014 click widgets to apply")}}function De(){let e=P!=="off"?"crosshair":"pointer";for(let t of document.querySelectorAll(".crev-label-text"))t.style.cursor=e;ge()}function st(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let o=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(o),setTimeout(()=>{r.classList.remove(o)},600)}if(t)R("Applied \u2014 refresh page to see changes","success");else{let o=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Paint error: ${n??"unknown"}`;R(o,"error")}}function at(e,t){let n=document.getElementById("crev-paint-text");if(n){if(t.length===0){S(n,"No style differences \u2014 already identical"),setTimeout(()=>ge(),2e3);return}S(n,m("div",{style:"margin-bottom:3px"},"Style changes:"),...t.map(r=>m("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},m("b",null,r.prop),": ",r.from," \u2192 ",r.to)),m("div",{style:"margin-top:4px"},m("button",{class:"crev-paint-apply-btn",onClick:()=>{v({type:"PAINT_CONFIRM",rid:e}),S(n,"Applying\u2026")}},"Apply"),m("button",{class:"crev-paint-cancel-btn",onClick:()=>ge()},"Cancel")))}}function ct(e,t){L&&(clearTimeout(L),L=null);let n=document.getElementById("crev-tooltip");if(!n)return;let r=h.get(t),o=K(r?.type),s=V(r?.type),u=r?.type??(T.has(t)?"Loading\u2026":"Unknown");S(n,m("div",{class:"crev-tt-type",style:`background:${o}`},s)," ",m("span",{style:"color:#8d8d8d;font-size:10px"},u),r?.name&&m("div",{class:"crev-tt-name"},r.name),r?.businessId&&m("div",{class:"crev-tt-row"},`ID: ${r.businessId}`),m("div",{class:"crev-tt-row"},`RID: ${t}`)),n.style.top="-9999px",n.style.left="-9999px",n.style.display="block";let l=e.getBoundingClientRect(),d=n.getBoundingClientRect(),c=l.bottom+4,p=l.left;c+d.height>window.innerHeight&&(c=l.top-d.height-4),c<4&&(c=4),p+d.width>window.innerWidth&&(p=window.innerWidth-d.width-4),p<0&&(p=4),n.style.top=`${c}px`,n.style.left=`${p}px`}function lt(){L&&clearTimeout(L),L=setTimeout(()=>{let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),L=null},50)}q("crev_sync_inspect",e=>{let t=e;if(t.active!==O){E=!0;try{ye(t.active)}finally{E=!1}}});q("crev_sync_paint",e=>{let t=e;E=!0;try{P=t.phase,me=t.sourceName??null,De()}finally{E=!1}});q("crev_sync_overlay",e=>{let t=e;if(t.active!==H){E=!0;try{H=t.active,Ee()}finally{E=!1}}});q("crev_sync_profile",e=>{let t=e;E=!0,x?.isBmp&&Y(t.label,t.connected!==!1?"connected":"disconnected"),E=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=h.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){y.swallow("content:contextmenu",o)}}}},!0);var dt=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),pt=new Set(["expression","html","javascript"]),ut=6;function Ee(){if(H){let e=[];for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");n&&!W.has(n)&&e.push(n)}if(e.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:e},t=>{if(!chrome.runtime.lastError&&t?.type==="OVERLAY_PROPS_DATA"&&t.props){for(let[n,r]of Object.entries(t.props))W.set(n,r);fe()}})}catch(t){y.swallow("content:getOverlayProps",t)}}fe()}function fe(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=h.get(t),r=e.querySelector(".crev-label-text");if(r)if(H){e.classList.add("crev-label--card");let o=n?.type??"Unknown",s=n?.businessId??"",u=n?.name??"unnamed",l=t.length>12?t.slice(0,6)+"\u2026"+t.slice(-4):t;r.innerHTML="";let d=document.createElement("span");d.className="crev-card-line crev-card-type",d.textContent=s?`${o} | ${s}`:o;let c=document.createElement("span");c.className="crev-card-line",c.textContent=u;let p=document.createElement("span");p.className="crev-card-line crev-card-rid",p.textContent=l,r.appendChild(d),r.appendChild(c),r.appendChild(p);let g=W.get(t);if(g){let a=Object.entries(g).filter(([b])=>!dt.has(b));if(a.length>0){let b=document.createElement("span");b.className="crev-card-sep",r.appendChild(b);let M=0;for(let[B,_]of a){if(M>=ut)break;let z=document.createElement("span");if(z.className="crev-card-line crev-card-prop",pt.has(B)){let J=_.split(`
`).length;z.textContent=`${B}: ${J} line${J!==1?"s":""}`}else{let J=_.length>30?_.slice(0,27)+"\u2026":_;z.textContent=`${B}: ${J}`}r.appendChild(z),M++}}}}else e.classList.remove("crev-label--card"),r.innerHTML="",r.textContent=n?.businessId??n?.name??V(n?.type)}}function gt(){Q||(Q=new MutationObserver(e=>{e.every(n=>n.type!=="childList"||n.removedNodes.length>0?!1:Array.from(n.addedNodes).every(r=>r instanceof HTMLElement&&(r.classList.contains("crev-label")||r.id==="crev-tooltip")))||(window.location.href!==Me&&(Me=window.location.href,T.clear(),Z.clear(),A&&(clearTimeout(A),A=null,$=null),He()),O&&(D&&clearTimeout(D),D=setTimeout(()=>X(),150)))}),Q.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=Q)}function He(){let e=re();x=e,v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&v(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(x&&n.length>0){let r=[...x.signals,...n],o=n.length*.15,s=Math.min(1,x.confidence+o),u=s>=.5;v({type:"DETECTION_RESULT",confidence:s,signals:r,isBmp:u})}}}));function ft(){let e=Te(),t=x??re(),n=t.isBmp?xe():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return ye(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=ft();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>y.swallow("content:clipboardWrite",r)),!1});function mt(){window.__crev_observer?.disconnect(),be(),w(),we(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),de=!1}window.__crev_content_loaded&&mt();window.__crev_content_loaded=!0;try{se()}catch(e){y.swallow("content:init:port",e)}try{He()}catch(e){y.swallow("content:init:detection",e)}try{gt()}catch(e){y.swallow("content:init:observer",e)}})();
