"use strict";(()=>{var be=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],Ne="#33b1ff",ke={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},De={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(be.map(e=>[e,Ne]))},Be={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...ke},me="#8d8d8d";function $(e){return e?De[e]??me:me}function D(e){return e?Be[e]??e.substring(0,3).toUpperCase():"?"}var He={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(be.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},Z=new Set(Object.keys(He));function Ee(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function Fe(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function Ue(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function ee(e=!0){let t=Fe();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of Ue())n.has(r.element)||(t.push(r),n.add(r.element));return t}function ye(){let e=[],t=new Set;for(let{element:n,rid:r}of ee()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),i=n.getAttribute("data-test");e.push({rid:r,name:i??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var Ve=.5;function X(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=Ve,confidence:t,signals:e.map(n=>n.name)}}function f(e,t,...n){let r=document.createElement(e);if(t)for(let[o,i]of Object.entries(t))i==null||i===!1||(o.startsWith("on")&&typeof i=="function"?r.addEventListener(o.slice(2).toLowerCase(),i):o==="class"||o==="className"?r.className=String(i):o==="style"?r.setAttribute("style",String(i)):o==="checked"||o==="disabled"||o==="readOnly"?i===!0&&(r[o]=!0):o==="value"?r.value=String(i):r.setAttribute(o,i===!0?"":String(i)));return te(r,n),r}function T(e,...t){e.textContent="",te(e,t)}function te(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?te(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var ne="[CREV]",m={debug(e,...t){},info(e,...t){console.info(`${ne}:${e}`,...t)},warn(e,t,...n){console.warn(`${ne}:${e}`,t,...n)},error(e,t,...n){console.error(`${ne}:${e}`,t,...n)},swallow(e,t){}};var Ye="crev-env-tag",re="crev_env_tag_pos",p=null,L=null,P=null;function ve(e,t){if(p){B(e,t);return}p=document.createElement("div"),p.id=Ye,L=document.createElement("span"),L.className="crev-env-dot",P=document.createElement("span"),P.className="crev-env-label",p.appendChild(L),p.appendChild(P),document.body.appendChild(p),B(e,t),chrome.storage.local.get(re,s=>{let c=s[re];c&&p&&(p.style.right=`${c.right??12}px`,p.style.bottom=`${c.bottom??12}px`,p.style.left="auto",p.style.top="auto")});let n=!1,r=0,o=0,i=0,a=0;p.addEventListener("mousedown",s=>{if(s.button===0){if(s.preventDefault(),n=!0,r=s.clientX,o=s.clientY,p){let c=p.getBoundingClientRect();i=window.innerWidth-c.right,a=window.innerHeight-c.bottom}document.addEventListener("mousemove",d),document.addEventListener("mouseup",u)}});function d(s){if(!n||!p)return;let c=s.clientX-r,E=s.clientY-o,l=Math.max(0,i-c),y=Math.max(0,a-E);p.style.right=`${l}px`,p.style.bottom=`${y}px`,p.style.left="auto",p.style.top="auto"}function u(){if(n=!1,document.removeEventListener("mousemove",d),document.removeEventListener("mouseup",u),p){let s=p.getBoundingClientRect(),c={right:Math.round(window.innerWidth-s.right),bottom:Math.round(window.innerHeight-s.bottom)};chrome.storage.local.set({[re]:c}).catch(()=>{})}}}function B(e,t){L&&(L.className=`crev-env-dot crev-env-dot--${t}`),P&&(P.textContent=e||"CREV")}function he(){p?.remove(),p=null,L=null,P=null}var Te="crev-toast-container";function qe(){let e=document.getElementById(Te);return e||(e=document.createElement("div"),e.id=Te,document.body.appendChild(e)),e}function M(e,t){let n=qe(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var Ge="crev-quick-inspector",g=null,xe=null;function Ce(e,t,n,r,o){if(C(),xe=t.rid,g=document.createElement("div"),g.id=Ge,t.type){let l=document.createElement("span");l.className="crev-qi-badge",l.textContent=t.type,g.appendChild(l)}if(t.name){let l=document.createElement("div");l.className="crev-qi-name",l.textContent=t.name,g.appendChild(l)}if(t.businessId){let l=document.createElement("div");l.className="crev-qi-row",l.textContent=`ID: ${t.businessId}`,g.appendChild(l)}let i=document.createElement("div");i.className="crev-qi-row crev-qi-rid",i.textContent=`RID: ${t.rid}`,g.appendChild(i);let a=document.createElement("button");a.className=`crev-qi-star${t.isFavorite?" active":""}`,a.textContent=t.isFavorite?"\u2605":"\u2606",a.title=t.isFavorite?"Remove from pinned":"Pin this object",a.addEventListener("click",l=>{l.stopPropagation(),r?.(t.rid);let y=a.classList.toggle("active");a.textContent=y?"\u2605":"\u2606"}),g.appendChild(a);let d=document.createElement("div");d.className="crev-qi-actions";let u=document.createElement("button");u.className="crev-qi-btn",u.textContent="Copy RID",u.addEventListener("click",l=>{l.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{u.textContent="\u2713",setTimeout(()=>{u.textContent="Copy RID"},600)}).catch(()=>{})});let s=document.createElement("button");s.className="crev-qi-btn",s.textContent="Copy ID",s.addEventListener("click",l=>{l.stopPropagation();let y=t.businessId??t.rid;navigator.clipboard.writeText(y).then(()=>{s.textContent="\u2713",setTimeout(()=>{s.textContent="Copy ID"},600)}).catch(()=>{})});let c=document.createElement("button");c.className="crev-qi-btn crev-qi-btn--accent",c.textContent="Editor",c.addEventListener("click",l=>{l.stopPropagation(),n(t.rid),C()});let E=document.createElement("button");E.className="crev-qi-btn",E.textContent="Full View",E.addEventListener("click",l=>{l.stopPropagation(),o?.(t.rid),C()}),d.appendChild(u),d.appendChild(s),d.appendChild(c),d.appendChild(E),g.appendChild(d),document.body.appendChild(g),je(e)}function je(e){if(!g)return;g.style.top="-9999px",g.style.left="-9999px",g.style.display="block";let t=e.getBoundingClientRect(),n=g.getBoundingClientRect(),r=6,o=t.bottom+r,i=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),i+n.width>window.innerWidth-r&&(i=window.innerWidth-n.width-r),i<r&&(i=r),g.style.top=`${o}px`,g.style.left=`${i}px`}function C(){g?.remove(),g=null,xe=null}function oe(){return g!=null}var ie=new Map;function H(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function F(e,t){let n=ie.get(e);n||(n=[],ie.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=ie.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var _e=`.crev-outline {
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
`;var S=!1,ae="widgets",w="off",ue=null,I=null,z=null,ce=!1,x=new Map,Y=new Map,le=new WeakSet,R=new Set,de=new Set,Se=window.location.href,b=null,se=null,K=200,_=[],A=null,N=null,pe=null,Ie=null,q=!1,Re=new Set,U=null,Q=null,v=!1;function Oe(){try{I=chrome.runtime.connect({name:"content"}),K=200}catch(e){m.swallow("content:connectPort",e);return}if(Ke(),b&&_.length===0){let e=b;queueMicrotask(()=>{h({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}I.onMessage.addListener(e=>{switch(e.type){case"INSPECT_STATE":ge(e.active),v||H("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))x.set(t,n);S&&et();break;case"PAINT_STATE":w=e.phase,ue=e.sourceName??null,Pe(),v||H("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":rt(e.rid,e.diff);break;case"PAINT_APPLY_RESULT":nt(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==ae&&(ae=e.mode,S&&(R.clear(),fe(),V()));break;case"RE_ENRICH":R.clear(),S&&V();break;case"CONNECTION_STATE":Qe(e.state);break;case"PROFILE_SWITCHED":Je(e.label),v||H("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":q=e.active,Me(),v||H("crev_sync_overlay",{active:e.active});break}}),I.onDisconnect.addListener(()=>{I=null,R.clear();try{chrome.runtime.getURL(""),setTimeout(()=>{Oe();for(let e of document.querySelectorAll(".crev-label"))e.style.opacity="0.4",setTimeout(()=>{e.style.opacity=""},800);S&&V()},K),K=Math.min(K*2,1e4)}catch(e){m.swallow("content:reconnectCheck",e)}})}function h(e){if(I)try{I.postMessage(e);return}catch(t){m.swallow("content:sendToSW",t),I=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>m.swallow("content:oneShot",t))}catch(t){m.swallow("content:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"){if(e.type==="DETECTION_RESULT"){let t=_.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&_.splice(t,1)}for(_.push(e);_.length>20;)_.shift()}}function Ke(){for(;_.length>0;){let e=_.shift();try{I?.postMessage(e)}catch(t){m.swallow("content:flushPending",t);break}}}function Qe(e){let t=Ie;Ie=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";b?.isBmp&&ve(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?M(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?M("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?M("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&M("Server down","error"))}function Je(e){M(`Switched to ${e}`,"info"),Y.clear(),b?.isBmp&&B(e,"connected")}function ge(e){S=e,e?(Ze(),V()):(N&&(clearTimeout(N),N=null),fe(),R.clear(),C())}function Ze(){if(ce)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=_e,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!S)return;let o=r.target.closest?.(".crev-outline");if(o!==pe)if(pe=o,o){let a=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");a&&ot(o,a)}else it()});let n=f("div",{id:"crev-paint-banner"},f("span",{id:"crev-paint-text"},"Paint Format"),f("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>h({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),ce=!0}function Le(e,t){let n=document.createElement("button");return n.className="crev-ec-btn",n.textContent=t==="CustomVisualization"?"</>":"EC",n.title="Open in editor",n.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n}function V(){for(let i of document.querySelectorAll(".crev-label"))(!i.parentElement||!document.body.contains(i.parentElement))&&i.remove();let e=ee(ae==="all"),t=[],n=e.filter(({element:i})=>!le.has(i));for(let{element:i,rid:a}of n){let d=x.get(a),u=$(d?.type);i.classList.add("crev-outline"),i.style.setProperty("--crev-color",u);let s=document.createElement("span");s.className="crev-label",d||s.classList.add("crev-label-loading"),s.setAttribute("data-crev-label",a);let c=document.createElement("span");c.className="crev-label-text",c.textContent=d?.businessId??d?.name??D(d?.type),s.appendChild(c),c.addEventListener("click",E=>{if(E.preventDefault(),E.stopPropagation(),w==="picking"){h({type:"PAINT_PICK",rid:a}),s.classList.add("crev-label-flash-pick"),setTimeout(()=>{s.classList.remove("crev-label-flash-pick")},400);return}if(w==="applying"){h({type:"PAINT_APPLY",rid:a});return}if(Q===a&&U){clearTimeout(U),U=null,Q=null,tt(s,a);return}Q=a,U=setTimeout(()=>{U=null,Q=null;let y=x.get(a)?.businessId??a;navigator.clipboard.writeText(y).then(()=>{let O=c.textContent;c.textContent="\u2713",s.classList.add("crev-label-flash-ok"),setTimeout(()=>{c.textContent=O,s.classList.remove("crev-label-flash-ok")},600)}).catch(O=>m.swallow("content:clipboard",O))},250)}),d?.type&&Z.has(d.type)&&s.appendChild(Le(a,d.type)),i.appendChild(s),le.add(i),!x.has(a)&&!R.has(a)&&(t.push(a),R.add(a))}t.length>0&&h({type:"ENRICH_BADGES",rids:t});let r=Date.now(),o=[];for(let{rid:i}of e)de.has(i)||(de.add(i),o.push({rid:i,source:"dom",discoveredAt:r,updatedAt:r}));o.length>0&&h({type:"OBJECTS_DISCOVERED",objects:o})}function fe(){for(let t of document.querySelectorAll(".crev-label"))t.remove();for(let t of document.querySelectorAll(".crev-outline"))t.classList.remove("crev-outline"),t.style.removeProperty("--crev-color");let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),pe=null,le=new WeakSet,Y.clear()}function et(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=x.get(t);if(n){let r=e.querySelector(".crev-label-text");r&&(r.textContent=n.businessId??n.name??D(n.type)),e.classList.remove("crev-label-loading");let o=e.parentElement;if(o){let i=$(n.type);o.style.setProperty("--crev-color",i)}n.type&&Z.has(n.type)&&!e.querySelector(".crev-ec-btn")&&e.appendChild(Le(t,n.type))}}}function tt(e,t){let n=x.get(t);chrome.runtime.sendMessage({type:"GET_FAVORITES"},r=>{r?.entries&&(Re=new Set(r.entries.map(o=>o.rid))),Ce(e,{rid:t,businessId:n?.businessId,type:n?.type,name:n?.name,isFavorite:Re.has(t)},o=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:o})},o=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:o,name:n?.name,objectType:n?.type,businessId:n?.businessId})},o=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:o})})})}document.addEventListener("keydown",e=>{e.key==="Escape"&&oe()&&C()});document.addEventListener("click",e=>{!oe()||e.target.closest("#crev-quick-inspector")||C()},!0);function k(...e){let t=document.getElementById("crev-paint-banner"),n=document.getElementById("crev-paint-text");if(!(!t||!n)){if(w==="off"){t.style.display="none";return}if(t.style.display="block",t.style.background="#ff832b",e.length>0){T(n,...e);return}w==="picking"?T(n,"Paint Format \u2014 ",f("b",null,"click a widget to pick its style")):T(n,"Paint Format from ",f("b",null,ue??"?")," \u2014 click widgets to apply")}}function Pe(){let e=w!=="off"?"crosshair":"pointer";for(let t of document.querySelectorAll(".crev-label-text"))t.style.cursor=e;k()}function nt(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let i=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(i),setTimeout(()=>{r.classList.remove(i)},600)}let o=document.getElementById("crev-paint-banner");if(o)if(t)k("Applied style \u2014 ",f("b",null,"refresh page to see changes")),setTimeout(()=>k(),3e3);else{o.style.background="#da1e28";let i=document.getElementById("crev-paint-text");if(i){let a=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Error: ${n??"unknown"}`;T(i,a)}setTimeout(()=>{o.style.background="#ff832b",k()},4e3)}}function rt(e,t){let n=document.getElementById("crev-paint-text");if(n){if(t.length===0){T(n,"No style differences \u2014 already identical"),setTimeout(()=>k(),2e3);return}T(n,f("div",{style:"margin-bottom:3px"},"Style changes:"),...t.map(r=>f("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},f("b",null,r.prop),": ",r.from," \u2192 ",r.to)),f("div",{style:"margin-top:4px"},f("button",{class:"crev-paint-apply-btn",onClick:()=>{h({type:"PAINT_CONFIRM",rid:e}),T(n,"Applying\u2026")}},"Apply"),f("button",{class:"crev-paint-cancel-btn",onClick:()=>k()},"Cancel")))}}function ot(e,t){A&&(clearTimeout(A),A=null);let n=document.getElementById("crev-tooltip");if(!n)return;let r=x.get(t),o=$(r?.type),i=D(r?.type),a=r?.type??(R.has(t)?"Loading\u2026":"Unknown");T(n,f("div",{class:"crev-tt-type",style:`background:${o}`},i)," ",f("span",{style:"color:#8d8d8d;font-size:10px"},a),r?.name&&f("div",{class:"crev-tt-name"},r.name),r?.businessId&&f("div",{class:"crev-tt-row"},`ID: ${r.businessId}`),f("div",{class:"crev-tt-row"},`RID: ${t}`)),n.style.top="-9999px",n.style.left="-9999px",n.style.display="block";let d=e.getBoundingClientRect(),u=n.getBoundingClientRect(),s=d.bottom+4,c=d.left;s+u.height>window.innerHeight&&(s=d.top-u.height-4),s<4&&(s=4),c+u.width>window.innerWidth&&(c=window.innerWidth-u.width-4),c<0&&(c=4),n.style.top=`${s}px`,n.style.left=`${c}px`}function it(){A&&clearTimeout(A),A=setTimeout(()=>{let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),A=null},50)}F("crev_sync_inspect",e=>{let t=e;t.active!==S&&(v=!0,ge(t.active),v=!1)});F("crev_sync_paint",e=>{let t=e;v=!0,w=t.phase,ue=t.sourceName??null,Pe(),v=!1});F("crev_sync_overlay",e=>{let t=e;t.active!==q&&(v=!0,q=t.active,Me(),v=!1)});F("crev_sync_profile",e=>{let t=e;v=!0,b?.isBmp&&B(t.label,t.connected!==!1?"connected":"disconnected"),v=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=x.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){m.swallow("content:contextmenu",o)}}}},!0);var st=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),at=new Set(["expression","html","javascript"]),ct=6;function Me(){if(q){let e=[];for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");n&&!Y.has(n)&&e.push(n)}if(e.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:e},t=>{if(!chrome.runtime.lastError&&t?.type==="OVERLAY_PROPS_DATA"&&t.props){for(let[n,r]of Object.entries(t.props))Y.set(n,r);Ae()}})}catch(t){m.swallow("content:getOverlayProps",t)}}Ae()}function Ae(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=x.get(t),r=e.querySelector(".crev-label-text");if(r)if(q){e.classList.add("crev-label--card");let o=n?.type??"Unknown",i=n?.businessId??"",a=n?.name??"unnamed",d=t.length>12?t.slice(0,6)+"\u2026"+t.slice(-4):t;r.innerHTML="";let u=document.createElement("span");u.className="crev-card-line crev-card-type",u.textContent=i?`${o} | ${i}`:o;let s=document.createElement("span");s.className="crev-card-line",s.textContent=a;let c=document.createElement("span");c.className="crev-card-line crev-card-rid",c.textContent=d,r.appendChild(u),r.appendChild(s),r.appendChild(c);let E=Y.get(t);if(E){let l=Object.entries(E).filter(([y])=>!st.has(y));if(l.length>0){let y=document.createElement("span");y.className="crev-card-sep",r.appendChild(y);let O=0;for(let[J,G]of l){if(O>=ct)break;let j=document.createElement("span");if(j.className="crev-card-line crev-card-prop",at.has(J)){let W=G.split(`
`).length;j.textContent=`${J}: ${W} line${W!==1?"s":""}`}else{let W=G.length>30?G.slice(0,27)+"\u2026":G;j.textContent=`${J}: ${W}`}r.appendChild(j),O++}}}}else e.classList.remove("crev-label--card"),r.innerHTML="",r.textContent=n?.businessId??n?.name??D(n?.type)}}function lt(){z||(z=new MutationObserver(e=>{e.every(n=>n.type!=="childList"||n.removedNodes.length>0?!1:Array.from(n.addedNodes).every(r=>r instanceof HTMLElement&&(r.classList.contains("crev-label")||r.id==="crev-tooltip")))||(window.location.href!==Se&&(Se=window.location.href,R.clear(),de.clear()),S&&(N&&clearTimeout(N),N=setTimeout(()=>V(),150)),se&&clearTimeout(se),se=setTimeout(()=>{let n=X();(!b||n.confidence!==b.confidence||n.isBmp!==b.isBmp)&&(b=n,h({type:"DETECTION_RESULT",confidence:n.confidence,signals:n.signals,isBmp:n.isBmp}))},2e3))}),z.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=z)}function dt(){let e=X();b=e,h({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&h(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(b&&n.length>0){let r=[...b.signals,...n],o=n.length*.15,i=Math.min(1,b.confidence+o),a=i>=.5;h({type:"DETECTION_RESULT",confidence:i,signals:r,isBmp:a})}}}));function pt(){let e=Ee(),t=b??X(),n=t.isBmp?ye():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return ge(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=pt();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>m.swallow("content:clipboardWrite",r)),!1});function ut(){window.__crev_observer?.disconnect(),fe(),C(),he(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),ce=!1}window.__crev_content_loaded&&ut();window.__crev_content_loaded=!0;try{Oe()}catch(e){m.swallow("content:init:port",e)}try{dt()}catch(e){m.swallow("content:init:detection",e)}try{lt()}catch(e){m.swallow("content:init:observer",e)}})();
