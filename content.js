"use strict";(()=>{var ve=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],Ne="#33b1ff",De={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},ke={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(ve.map(e=>[e,Ne]))},Be={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...De},he="#8d8d8d";function K(e){return e?ke[e]??he:he}function V(e){return e?Be[e]??e.substring(0,3).toUpperCase():"?"}var He={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(ve.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},re=new Set(Object.keys(He));function Te(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function Ve(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function Fe(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function oe(e=!0){let t=Ve();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of Fe())n.has(r.element)||(t.push(r),n.add(r.element));return t}function xe(){let e=[],t=new Set;for(let{element:n,rid:r}of oe()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),i=n.getAttribute("data-test");e.push({rid:r,name:i??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var Ue=.5;function Q(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=Ue,confidence:t,signals:e.map(n=>n.name)}}function m(e,t,...n){let r=document.createElement(e);if(t)for(let[o,i]of Object.entries(t))i==null||i===!1||(o.startsWith("on")&&typeof i=="function"?r.addEventListener(o.slice(2).toLowerCase(),i):o==="class"||o==="className"?r.className=String(i):o==="style"?r.setAttribute("style",String(i)):o==="checked"||o==="disabled"||o==="readOnly"?i===!0&&(r[o]=!0):o==="value"?r.value=String(i):r.setAttribute(o,i===!0?"":String(i)));return ie(r,n),r}function _(e,...t){e.textContent="",ie(e,t)}function ie(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?ie(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var F="[CREV]",b={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${F}:${e}`,...t)},info(e,...t){console.info(`${F}:${e}`,...t)},warn(e,t,...n){console.warn(`${F}:${e}`,t,...n)},error(e,t,...n){console.error(`${F}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${F}:${e} [swallowed]`,t)}};var Ye="crev-env-tag",se="crev_env_tag_pos",u=null,P=null,M=null;function Ce(e,t){if(u){U(e,t);return}u=document.createElement("div"),u.id=Ye,P=document.createElement("span"),P.className="crev-env-dot",M=document.createElement("span"),M.className="crev-env-label",u.appendChild(P),u.appendChild(M),document.body.appendChild(u),U(e,t),chrome.storage.local.get(se,s=>{let d=s[se];d&&u&&(u.style.right=`${d.right??12}px`,u.style.bottom=`${d.bottom??12}px`,u.style.left="auto",u.style.top="auto")});let n=!1,r=0,o=0,i=0,p=0;u.addEventListener("mousedown",s=>{if(s.button===0){if(s.preventDefault(),n=!0,r=s.clientX,o=s.clientY,u){let d=u.getBoundingClientRect();i=window.innerWidth-d.right,p=window.innerHeight-d.bottom}document.addEventListener("mousemove",a),document.addEventListener("mouseup",l)}});function a(s){if(!n||!u)return;let d=s.clientX-r,g=s.clientY-o,c=Math.max(0,i-d),E=Math.max(0,p-g);u.style.right=`${c}px`,u.style.bottom=`${E}px`,u.style.left="auto",u.style.top="auto"}function l(){if(n=!1,document.removeEventListener("mousemove",a),document.removeEventListener("mouseup",l),u){let s=u.getBoundingClientRect(),d={right:Math.round(window.innerWidth-s.right),bottom:Math.round(window.innerHeight-s.bottom)};chrome.storage.local.set({[se]:d}).catch(()=>{})}}}function U(e,t){P&&(P.className=`crev-env-dot crev-env-dot--${t}`),M&&(M.textContent=e||"CREV")}function _e(){u?.remove(),u=null,P=null,M=null}var Se="crev-toast-container";function Ge(){let e=document.getElementById(Se);return e||(e=document.createElement("div"),e.id=Se,document.body.appendChild(e)),e}function N(e,t){let n=Ge(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var qe="crev-quick-inspector",f=null,Ie=null;function Re(e,t,n,r,o){if(I(),Ie=t.rid,f=document.createElement("div"),f.id=qe,t.type){let c=document.createElement("span");c.className="crev-qi-badge",c.textContent=t.type,f.appendChild(c)}if(t.name){let c=document.createElement("div");c.className="crev-qi-name",c.textContent=t.name,f.appendChild(c)}if(t.businessId){let c=document.createElement("div");c.className="crev-qi-row",c.textContent=`ID: ${t.businessId}`,f.appendChild(c)}let i=document.createElement("div");i.className="crev-qi-row crev-qi-rid",i.textContent=`RID: ${t.rid}`,f.appendChild(i);let p=document.createElement("button");p.className=`crev-qi-star${t.isFavorite?" active":""}`,p.textContent=t.isFavorite?"\u2605":"\u2606",p.title=t.isFavorite?"Remove from pinned":"Pin this object",p.addEventListener("click",c=>{c.stopPropagation(),r?.(t.rid);let E=p.classList.toggle("active");p.textContent=E?"\u2605":"\u2606"}),f.appendChild(p);let a=document.createElement("div");a.className="crev-qi-actions";let l=document.createElement("button");l.className="crev-qi-btn",l.textContent="Copy RID",l.addEventListener("click",c=>{c.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{l.textContent="\u2713",setTimeout(()=>{l.textContent="Copy RID"},600)}).catch(()=>{})});let s=document.createElement("button");s.className="crev-qi-btn",s.textContent="Copy ID",s.addEventListener("click",c=>{c.stopPropagation();let E=t.businessId??t.rid;navigator.clipboard.writeText(E).then(()=>{s.textContent="\u2713",setTimeout(()=>{s.textContent="Copy ID"},600)}).catch(()=>{})});let d=document.createElement("button");d.className="crev-qi-btn crev-qi-btn--accent",d.textContent="Editor",d.addEventListener("click",c=>{c.stopPropagation(),n(t.rid),I()});let g=document.createElement("button");g.className="crev-qi-btn",g.textContent="Full View",g.addEventListener("click",c=>{c.stopPropagation(),o?.(t.rid),I()}),a.appendChild(l),a.appendChild(s),a.appendChild(d),a.appendChild(g),f.appendChild(a),document.body.appendChild(f),je(e)}function je(e){if(!f)return;f.style.top="-9999px",f.style.left="-9999px",f.style.display="block";let t=e.getBoundingClientRect(),n=f.getBoundingClientRect(),r=6,o=t.bottom+r,i=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),i+n.width>window.innerWidth-r&&(i=window.innerWidth-n.width-r),i<r&&(i=r),f.style.top=`${o}px`,f.style.left=`${i}px`}function I(){f?.remove(),f=null,Ie=null}function ae(){return f!=null}var ce=new Map;function Y(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function G(e,t){let n=ce.get(e);n||(n=[],ce.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=ce.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var Ae=`.crev-outline {
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
`;var A=!1,te="all",L="off",me=null,w=null,Z=null,pe=!1,x=new Map,z=new Map,ue=new WeakSet,C=new Set,ee=new Set,we=window.location.href,y=null,le=null,q=200,T=[],O=null,D=null,ge=null,Oe=null,B=!1,j=new Set,R=null,$=null,h=!1;function Le(){try{w=chrome.runtime.connect({name:"content"}),q=200}catch(e){b.swallow("content:connectPort",e);return}if(Ke(),y&&T.length===0){let e=y;queueMicrotask(()=>{v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}w.onMessage.addListener(e=>{switch(e.type){case"INSPECT_STATE":be(e.active),h||Y("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))x.set(t,n);A&&tt();break;case"PAINT_STATE":L=e.phase,me=e.sourceName??null,Me(),h||Y("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":ot(e.rid,e.diff);break;case"PAINT_APPLY_RESULT":rt(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==te&&(te=e.mode,A&&(C.clear(),ye(),W()));break;case"RE_ENRICH":C.clear(),A&&W();break;case"CONNECTION_STATE":Qe(e.state);break;case"PROFILE_SWITCHED":Ze(e.label),h||Y("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":B=e.active,Ee(),h||Y("crev_sync_overlay",{active:e.active});break}}),w.onDisconnect.addListener(()=>{w=null,C.clear();try{chrome.runtime.getURL("");let e=q>200;setTimeout(()=>{if(Le(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);A&&W()},q),q=Math.min(q*2,1e4)}catch(e){b.swallow("content:reconnectCheck",e)}})}function v(e){if(w)try{w.postMessage(e);return}catch(t){b.swallow("content:sendToSW",t),w=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>b.swallow("content:oneShot",t))}catch(t){b.swallow("content:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"){if(e.type==="DETECTION_RESULT"){let t=T.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&T.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=T[T.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}for(T.push(e);T.length>20;)T.shift()}}function Ke(){for(;T.length>0;){let e=T.shift();try{w?.postMessage(e)}catch(t){b.swallow("content:flushPending",t);break}}}function Qe(e){let t=Oe;Oe=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";y?.isBmp&&Ce(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?N(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?N("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?N("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&N("Server down","error"))}function Ze(e){N(`Switched to ${e}`,"info"),z.clear(),fe(),B&&Ee(),y?.isBmp&&U(e,"connected")}function be(e){A=e,e?(et(),W()):(D&&(clearTimeout(D),D=null),ye(),C.clear(),I())}function et(){if(pe)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=Ae,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!A)return;let o=r.target.closest?.(".crev-outline");if(o!==ge)if(ge=o,o){let p=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");p&&it(o,p)}else st()});let n=m("div",{id:"crev-paint-banner"},m("span",{id:"crev-paint-text"},"Paint Format"),m("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>v({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),pe=!0}function Pe(e,t){let n=document.createElement("button");return n.className="crev-ec-btn",n.textContent=t==="CustomVisualization"?"</>":"EC",n.title="Open in editor",n.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n}function W(){for(let a of document.querySelectorAll(".crev-label"))(!a.parentElement||!document.body.contains(a.parentElement))&&a.remove();let e=te==="all",t=oe(e),n=e?t.filter(({element:a})=>a.tagName==="A").length:0;b.debug("sync",`syncOverlays: ${t.length} elements (${n} links), enrichMode=${te}`);let r=[],o=t.filter(({element:a})=>!ue.has(a));for(let{element:a,rid:l}of o){let s=x.get(l),d=K(s?.type);a.classList.add("crev-outline"),a.style.setProperty("--crev-color",d);let g=document.createElement("span");g.className="crev-label",s||g.classList.add("crev-label-loading"),g.setAttribute("data-crev-label",l);let c=document.createElement("span");c.className="crev-label-text",c.textContent=s?.businessId??s?.name??V(s?.type),g.appendChild(c),c.addEventListener("click",E=>{if(E.preventDefault(),E.stopPropagation(),L==="picking"){v({type:"PAINT_PICK",rid:l}),g.classList.add("crev-label-flash-pick"),setTimeout(()=>{g.classList.remove("crev-label-flash-pick")},400);return}if(L==="applying"){v({type:"PAINT_APPLY",rid:l});return}if($===l&&R){clearTimeout(R),R=null,$=null,nt(g,l);return}$=l,R=setTimeout(()=>{R=null,$=null;let H=x.get(l)?.businessId??l;navigator.clipboard.writeText(H).then(()=>{let S=c.textContent;c.textContent="\u2713",g.classList.add("crev-label-flash-ok"),setTimeout(()=>{c.textContent=S,g.classList.remove("crev-label-flash-ok")},600)}).catch(S=>b.swallow("content:clipboard",S))},250)}),s?.type&&re.has(s.type)&&g.appendChild(Pe(l,s.type)),a.appendChild(g),ue.add(a),!x.has(l)&&!C.has(l)&&(r.push(l),C.add(l))}for(let{rid:a}of t)!x.has(a)&&!C.has(a)&&(r.push(a),C.add(a));r.length>0&&(b.debug("sync",`ENRICH_BADGES: sending ${r.length} RIDs`,r),v({type:"ENRICH_BADGES",rids:r}));let i=Date.now(),p=[];for(let{rid:a}of t)!ee.has(a)&&ee.size<5e3&&(ee.add(a),p.push({rid:a,source:"dom",discoveredAt:i,updatedAt:i}));p.length>0&&v({type:"OBJECTS_DISCOVERED",objects:p})}function ye(){for(let t of document.querySelectorAll(".crev-label"))t.remove();for(let t of document.querySelectorAll(".crev-outline"))t.classList.remove("crev-outline"),t.style.removeProperty("--crev-color");let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),ge=null,ue=new WeakSet,z.clear()}function tt(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=x.get(t);if(n){let r=e.querySelector(".crev-label-text");r&&(r.textContent=n.businessId??n.name??V(n.type)),e.classList.remove("crev-label-loading");let o=e.parentElement;if(o){let i=K(n.type);o.style.setProperty("--crev-color",i)}n.type&&re.has(n.type)&&!e.querySelector(".crev-ec-btn")&&e.appendChild(Pe(t,n.type))}}}function nt(e,t){let n=x.get(t);chrome.runtime.sendMessage({type:"GET_FAVORITES"},r=>{r?.entries&&(j=new Set(r.entries.map(o=>o.rid))),Re(e,{rid:t,businessId:n?.businessId,type:n?.type,name:n?.name,isFavorite:j.has(t)},o=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:o})},o=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:o,name:n?.name,objectType:n?.type,businessId:n?.businessId}),j.has(o)?j.delete(o):j.add(o)},o=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:o})})})}document.addEventListener("keydown",e=>{e.key==="Escape"&&ae()&&I()});document.addEventListener("click",e=>{!ae()||e.target.closest("#crev-quick-inspector")||I()},!0);function k(...e){let t=document.getElementById("crev-paint-banner"),n=document.getElementById("crev-paint-text");if(!(!t||!n)){if(L==="off"){t.style.display="none";return}if(t.style.display="block",t.style.background="#ff832b",e.length>0){_(n,...e);return}L==="picking"?_(n,"Paint Format \u2014 ",m("b",null,"click a widget to pick its style")):_(n,"Paint Format from ",m("b",null,me??"?")," \u2014 click widgets to apply")}}function Me(){let e=L!=="off"?"crosshair":"pointer";for(let t of document.querySelectorAll(".crev-label-text"))t.style.cursor=e;k()}function rt(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let i=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(i),setTimeout(()=>{r.classList.remove(i)},600)}let o=document.getElementById("crev-paint-banner");if(o)if(t)k("Applied style \u2014 ",m("b",null,"refresh page to see changes")),setTimeout(()=>k(),3e3);else{o.style.background="#da1e28";let i=document.getElementById("crev-paint-text");if(i){let p=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Error: ${n??"unknown"}`;_(i,p)}setTimeout(()=>{o.style.background="#ff832b",k()},4e3)}}function ot(e,t){let n=document.getElementById("crev-paint-text");if(n){if(t.length===0){_(n,"No style differences \u2014 already identical"),setTimeout(()=>k(),2e3);return}_(n,m("div",{style:"margin-bottom:3px"},"Style changes:"),...t.map(r=>m("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},m("b",null,r.prop),": ",r.from," \u2192 ",r.to)),m("div",{style:"margin-top:4px"},m("button",{class:"crev-paint-apply-btn",onClick:()=>{v({type:"PAINT_CONFIRM",rid:e}),_(n,"Applying\u2026")}},"Apply"),m("button",{class:"crev-paint-cancel-btn",onClick:()=>k()},"Cancel")))}}function it(e,t){O&&(clearTimeout(O),O=null);let n=document.getElementById("crev-tooltip");if(!n)return;let r=x.get(t),o=K(r?.type),i=V(r?.type),p=r?.type??(C.has(t)?"Loading\u2026":"Unknown");_(n,m("div",{class:"crev-tt-type",style:`background:${o}`},i)," ",m("span",{style:"color:#8d8d8d;font-size:10px"},p),r?.name&&m("div",{class:"crev-tt-name"},r.name),r?.businessId&&m("div",{class:"crev-tt-row"},`ID: ${r.businessId}`),m("div",{class:"crev-tt-row"},`RID: ${t}`)),n.style.top="-9999px",n.style.left="-9999px",n.style.display="block";let a=e.getBoundingClientRect(),l=n.getBoundingClientRect(),s=a.bottom+4,d=a.left;s+l.height>window.innerHeight&&(s=a.top-l.height-4),s<4&&(s=4),d+l.width>window.innerWidth&&(d=window.innerWidth-l.width-4),d<0&&(d=4),n.style.top=`${s}px`,n.style.left=`${d}px`}function st(){O&&clearTimeout(O),O=setTimeout(()=>{let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),O=null},50)}G("crev_sync_inspect",e=>{let t=e;if(t.active!==A){h=!0;try{be(t.active)}finally{h=!1}}});G("crev_sync_paint",e=>{let t=e;h=!0;try{L=t.phase,me=t.sourceName??null,Me()}finally{h=!1}});G("crev_sync_overlay",e=>{let t=e;if(t.active!==B){h=!0;try{B=t.active,Ee()}finally{h=!1}}});G("crev_sync_profile",e=>{let t=e;h=!0,y?.isBmp&&U(t.label,t.connected!==!1?"connected":"disconnected"),h=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=x.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){b.swallow("content:contextmenu",o)}}}},!0);var at=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),ct=new Set(["expression","html","javascript"]),lt=6;function Ee(){if(B){let e=[];for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");n&&!z.has(n)&&e.push(n)}if(e.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:e},t=>{if(!chrome.runtime.lastError&&t?.type==="OVERLAY_PROPS_DATA"&&t.props){for(let[n,r]of Object.entries(t.props))z.set(n,r);fe()}})}catch(t){b.swallow("content:getOverlayProps",t)}}fe()}function fe(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=x.get(t),r=e.querySelector(".crev-label-text");if(r)if(B){e.classList.add("crev-label--card");let o=n?.type??"Unknown",i=n?.businessId??"",p=n?.name??"unnamed",a=t.length>12?t.slice(0,6)+"\u2026"+t.slice(-4):t;r.innerHTML="";let l=document.createElement("span");l.className="crev-card-line crev-card-type",l.textContent=i?`${o} | ${i}`:o;let s=document.createElement("span");s.className="crev-card-line",s.textContent=p;let d=document.createElement("span");d.className="crev-card-line crev-card-rid",d.textContent=a,r.appendChild(l),r.appendChild(s),r.appendChild(d);let g=z.get(t);if(g){let c=Object.entries(g).filter(([E])=>!at.has(E));if(c.length>0){let E=document.createElement("span");E.className="crev-card-sep",r.appendChild(E);let ne=0;for(let[H,S]of c){if(ne>=lt)break;let X=document.createElement("span");if(X.className="crev-card-line crev-card-prop",ct.has(H)){let J=S.split(`
`).length;X.textContent=`${H}: ${J} line${J!==1?"s":""}`}else{let J=S.length>30?S.slice(0,27)+"\u2026":S;X.textContent=`${H}: ${J}`}r.appendChild(X),ne++}}}}else e.classList.remove("crev-label--card"),r.innerHTML="",r.textContent=n?.businessId??n?.name??V(n?.type)}}function dt(){Z||(Z=new MutationObserver(e=>{e.every(n=>n.type!=="childList"||n.removedNodes.length>0?!1:Array.from(n.addedNodes).every(r=>r instanceof HTMLElement&&(r.classList.contains("crev-label")||r.id==="crev-tooltip")))||(window.location.href!==we&&(we=window.location.href,C.clear(),ee.clear(),R&&(clearTimeout(R),R=null,$=null)),A&&(D&&clearTimeout(D),D=setTimeout(()=>W(),150)),le&&clearTimeout(le),le=setTimeout(()=>{let n=Q();(!y||n.confidence!==y.confidence||n.isBmp!==y.isBmp)&&(y=n,v({type:"DETECTION_RESULT",confidence:n.confidence,signals:n.signals,isBmp:n.isBmp}))},2e3))}),Z.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=Z)}function pt(){let e=Q();y=e,v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&v(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(y&&n.length>0){let r=[...y.signals,...n],o=n.length*.15,i=Math.min(1,y.confidence+o),p=i>=.5;v({type:"DETECTION_RESULT",confidence:i,signals:r,isBmp:p})}}}));function ut(){let e=Te(),t=y??Q(),n=t.isBmp?xe():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return be(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=ut();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>b.swallow("content:clipboardWrite",r)),!1});function gt(){window.__crev_observer?.disconnect(),ye(),I(),_e(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),pe=!1}window.__crev_content_loaded&&gt();window.__crev_content_loaded=!0;try{Le()}catch(e){b.swallow("content:init:port",e)}try{pt()}catch(e){b.swallow("content:init:detection",e)}try{dt()}catch(e){b.swallow("content:init:observer",e)}})();
