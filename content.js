"use strict";(()=>{var Te=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],Ve="#33b1ff",Fe={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},Ue={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(Te.map(e=>[e,Ve]))},Ye={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...Fe},he="#8d8d8d";function J(e){return e?Ue[e]??he:he}function U(e){return e?Ye[e]??e.substring(0,3).toUpperCase():"?"}var Ge={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(Te.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},ne=new Set(Object.keys(Ge));function xe(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function qe(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function je(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function re(e=!0){let t=qe();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of je())n.has(r.element)||(t.push(r),n.add(r.element));return t}function Ce(){let e=[],t=new Set;for(let{element:n,rid:r}of re()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),a=n.getAttribute("data-test");e.push({rid:r,name:a??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var $e=.5;function oe(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=$e,confidence:t,signals:e.map(n=>n.name)}}function y(e,t,...n){let r=document.createElement(e);if(t)for(let[o,a]of Object.entries(t))a==null||a===!1||(o.startsWith("on")&&typeof a=="function"?r.addEventListener(o.slice(2).toLowerCase(),a):o==="class"||o==="className"?r.className=String(a):o==="style"?r.setAttribute("style",String(a)):o==="checked"||o==="disabled"||o==="readOnly"?a===!0&&(r[o]=!0):o==="value"?r.value=String(a):r.setAttribute(o,a===!0?"":String(a)));return ie(r,n),r}function S(e,...t){e.textContent="",ie(e,t)}function ie(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?ie(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var Y="[CREV]",b={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${Y}:${e}`,...t)},info(e,...t){console.info(`${Y}:${e}`,...t)},warn(e,t,...n){console.warn(`${Y}:${e}`,t,...n)},error(e,t,...n){console.error(`${Y}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${Y}:${e} [swallowed]`,t)}};var I=null,G=200,v=[],_e=null,Se=null;function Ie(e){_e=e}function Re(e){Se=e}function ae(){try{I=chrome.runtime.connect({name:"content"}),G=200}catch(e){b.swallow("port:connect",e);return}I.onMessage.addListener(e=>{_e?.(e)}),Xe(),I.onDisconnect.addListener(()=>{I=null;try{chrome.runtime.getURL("");let e=G>200;setTimeout(()=>{if(ae(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);Se?.()},G),G=Math.min(G*2,1e4)}catch(e){b.swallow("port:reconnectCheck",e)}})}function h(e){if(I)try{I.postMessage(e);return}catch(t){b.swallow("port:send",t),I=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>b.swallow("port:oneShot",t))}catch(t){b.swallow("port:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"||e.type==="ENRICH_BADGES"){if(e.type==="DETECTION_RESULT"){let t=v.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&v.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=v[v.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}if(e.type==="ENRICH_BADGES"){let t=v[v.length-1];if(t?.type==="ENRICH_BADGES"){let n=new Set(t.rids);for(let r of e.rids)n.has(r)||t.rids.push(r);return}}for(v.push(e);v.length>20;)v.shift()}}function Xe(){for(;v.length>0;){let e=v.shift();try{I?.postMessage(e)}catch(t){b.swallow("port:flush",t);break}}}var ze="crev-env-tag",ce="crev_env_tag_pos",s=null,B=null,H=null;function we(e,t){if(s){q(e,t);return}s=document.createElement("div"),s.id=ze,B=document.createElement("span"),B.className="crev-env-dot",H=document.createElement("span"),H.className="crev-env-label",s.appendChild(B),s.appendChild(H),document.body.appendChild(s),q(e,t),chrome.storage.local.get(ce,c=>{let p=c[ce];p&&s&&(s.style.bottom=`${p.bottom??12}px`,s.style.top="auto",p.snap==="left"?(s.classList.add("crev-env-tag--edge-left"),s.style.left="0",s.style.right="auto"):p.snap==="right"?(s.classList.add("crev-env-tag--edge-right"),s.style.right="0",s.style.left="auto"):(s.style.right=`${p.right??12}px`,s.style.left="auto"))});let n=!1,r=0,o=0,a=0,u=0;s.addEventListener("mousedown",c=>{if(c.button===0){if(c.preventDefault(),n=!0,r=c.clientX,o=c.clientY,s){s.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let p=s.getBoundingClientRect();a=window.innerWidth-p.right,u=window.innerHeight-p.bottom,s.style.right=`${a}px`,s.style.bottom=`${u}px`,s.style.left="auto",s.style.top="auto"}document.addEventListener("mousemove",l),document.addEventListener("mouseup",d)}});function l(c){if(!n||!s)return;let p=c.clientX-r,g=c.clientY-o,i=Math.max(0,a-p),m=Math.max(0,u-g);s.style.right=`${i}px`,s.style.bottom=`${m}px`,s.style.left="auto",s.style.top="auto"}function d(){if(n=!1,document.removeEventListener("mousemove",l),document.removeEventListener("mouseup",d),!s)return;let c=s.getBoundingClientRect(),p=c.left+c.width/2,g=window.innerWidth;s.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let i=null;p<g*.15?(i="left",s.classList.add("crev-env-tag--edge-left"),s.style.left="0",s.style.right="auto"):p>g*.85&&(i="right",s.classList.add("crev-env-tag--edge-right"),s.style.right="0",s.style.left="auto");let m=s.getBoundingClientRect(),_={right:Math.round(window.innerWidth-m.right),bottom:Math.round(window.innerHeight-m.bottom)};i&&(_.snap=i),chrome.storage.local.set({[ce]:_}).catch(()=>{})}}function q(e,t){B&&(B.className=`crev-env-dot crev-env-dot--${t}`),H&&(H.textContent=e||"CREV")}function Ae(){s?.remove(),s=null,B=null,H=null}var Oe="crev-toast-container";function Ke(){let e=document.getElementById(Oe);return e||(e=document.createElement("div"),e.id=Oe,document.body.appendChild(e)),e}function R(e,t){let n=Ke(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var Je="crev-quick-inspector",f=null,Le=null;function Pe(e,t,n,r,o){if(w(),Le=t.rid,f=document.createElement("div"),f.id=Je,t.type){let i=document.createElement("span");i.className="crev-qi-badge",i.textContent=t.type,f.appendChild(i)}if(t.name){let i=document.createElement("div");i.className="crev-qi-name",i.textContent=t.name,f.appendChild(i)}if(t.businessId){let i=document.createElement("div");i.className="crev-qi-row",i.textContent=`ID: ${t.businessId}`,f.appendChild(i)}if(t.templateBusinessId){let i=document.createElement("div");i.className="crev-qi-row crev-qi-template",i.textContent=`Template: ${t.templateBusinessId}`,f.appendChild(i)}let a=document.createElement("div");a.className="crev-qi-row crev-qi-rid",a.textContent=`RID: ${t.rid}`,f.appendChild(a);let u=document.createElement("button");u.className=`crev-qi-star${t.isFavorite?" active":""}`,u.textContent=t.isFavorite?"\u2605":"\u2606",u.title=t.isFavorite?"Remove from pinned":"Pin this object",u.addEventListener("click",i=>{i.stopPropagation(),r?.(t.rid);let m=u.classList.toggle("active");u.textContent=m?"\u2605":"\u2606"}),f.appendChild(u);let l=document.createElement("div");l.className="crev-qi-actions";let d=document.createElement("button");d.className="crev-qi-btn",d.textContent="Copy RID",d.addEventListener("click",i=>{i.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{d.textContent="\u2713",setTimeout(()=>{d.textContent="Copy RID"},600)}).catch(()=>{})});let c=document.createElement("button");c.className="crev-qi-btn",c.textContent="Copy ID",c.addEventListener("click",i=>{i.stopPropagation();let m=t.businessId??t.rid;navigator.clipboard.writeText(m).then(()=>{c.textContent="\u2713",setTimeout(()=>{c.textContent="Copy ID"},600)}).catch(()=>{})});let p=document.createElement("button");p.className="crev-qi-btn crev-qi-btn--accent",p.textContent="Editor",p.addEventListener("click",i=>{i.stopPropagation(),n(t.rid),w()});let g=document.createElement("button");g.className="crev-qi-btn",g.textContent="Full View",g.addEventListener("click",i=>{i.stopPropagation(),o?.(t.rid),w()}),l.appendChild(d),l.appendChild(c),l.appendChild(p),l.appendChild(g),f.appendChild(l),document.body.appendChild(f),Qe(e)}function Qe(e){if(!f)return;f.style.top="-9999px",f.style.left="-9999px",f.style.display="block";let t=e.getBoundingClientRect(),n=f.getBoundingClientRect(),r=6,o=t.bottom+r,a=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),a+n.width>window.innerWidth-r&&(a=window.innerWidth-n.width-r),a<r&&(a=r),f.style.top=`${o}px`,f.style.left=`${a}px`}function w(){f?.remove(),f=null,Le=null}function le(){return f!=null}var de=new Map;function j(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function $(e,t){let n=de.get(e);n||(n=[],de.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=de.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var Me=`.crev-outline {
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
`;var O=!1,ee="all",N="off",ye=null,Q=null,pe=!1,T=new Map,z=new Map,ue=new WeakSet,x=new Set,Z=new Set,Ne=window.location.href,C=null,M=null,V=null,ge=null,ke=null,F=!1,W=new Set,A=null,X=null,E=!1;Ie(e=>{switch(e.type){case"INSPECT_STATE":be(e.active),E||j("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))T.set(t,n);O&&it();break;case"PAINT_STATE":N=e.phase,ye=e.sourceName??null,Be(),E||j("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":ct(e.rid,e.diff);break;case"PAINT_APPLY_RESULT":at(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==ee&&(ee=e.mode,O&&(x.clear(),Ee(),K()));break;case"RE_ENRICH":x.clear(),O&&K();break;case"CONNECTION_STATE":nt(e.state);break;case"PROFILE_SWITCHED":rt(e.label),E||j("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":F=e.active,ve(),E||j("crev_sync_overlay",{active:e.active});break}});Re(()=>{if(x.clear(),C){let e=C;queueMicrotask(()=>{h({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}O&&K()});function nt(e){let t=ke;ke=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";C?.isBmp&&we(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?R(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?R("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?R("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&R("Server down","error"))}function rt(e){R(`Switched to ${e}`,"info"),z.clear(),me(),F&&ve(),C?.isBmp&&q(e,"connected")}function be(e){O=e,e?(ot(),K()):(V&&(clearTimeout(V),V=null),Ee(),x.clear(),w())}function ot(){if(pe)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=Me,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!O)return;let o=r.target.closest?.(".crev-outline");if(o!==ge)if(ge=o,o){let u=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");u&&lt(o,u)}else dt()});let n=y("div",{id:"crev-paint-banner"},y("span",{id:"crev-paint-text"},"Paint Format"),y("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>h({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),pe=!0}function De(e,t){let n=document.createElement("button");return n.className="crev-ec-btn",n.textContent=t==="CustomVisualization"?"</>":"EC",n.title="Open in editor",n.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n}function K(){for(let l of document.querySelectorAll(".crev-label"))(!l.parentElement||!document.body.contains(l.parentElement))&&l.remove();let e=ee==="all",t=re(e),n=e?t.filter(({element:l})=>l.tagName==="A").length:0;b.debug("sync",`syncOverlays: ${t.length} elements (${n} links), enrichMode=${ee}`);let r=[],o=t.filter(({element:l})=>!ue.has(l));for(let{element:l,rid:d}of o){let c=T.get(d),p=J(c?.type);l.classList.add("crev-outline"),l.style.setProperty("--crev-color",p);let g=document.createElement("span");g.className="crev-label",c||g.classList.add("crev-label-loading"),g.setAttribute("data-crev-label",d);let i=document.createElement("span");i.className="crev-label-text",i.textContent=c?.businessId??c?.name??U(c?.type),g.appendChild(i),i.addEventListener("click",m=>{if(m.preventDefault(),m.stopPropagation(),N==="picking"){h({type:"PAINT_PICK",rid:d}),g.classList.add("crev-label-flash-pick"),setTimeout(()=>{g.classList.remove("crev-label-flash-pick")},400);return}if(N==="applying"){h({type:"PAINT_APPLY",rid:d});return}if(X===d&&A){clearTimeout(A),A=null,X=null,st(g,d);return}let _=m.shiftKey;X=d,A=setTimeout(()=>{A=null,X=null;let L=T.get(d),P=!!L?.templateBusinessId,k=_&&P?L.templateBusinessId:L?.businessId??d,D=_&&P?"\u2713 Tmpl":"\u2713";navigator.clipboard.writeText(k).then(()=>{let te=i.textContent;i.textContent=D,g.classList.add("crev-label-flash-ok"),setTimeout(()=>{i.textContent=te,g.classList.remove("crev-label-flash-ok")},600)}).catch(te=>b.swallow("content:clipboard",te))},250)}),c?.type&&ne.has(c.type)&&g.appendChild(De(d,c.type)),l.appendChild(g),ue.add(l),!T.has(d)&&!x.has(d)&&(r.push(d),x.add(d))}for(let{rid:l}of t)!T.has(l)&&!x.has(l)&&(r.push(l),x.add(l));r.length>0&&(b.debug("sync",`ENRICH_BADGES: sending ${r.length} RIDs`,r),h({type:"ENRICH_BADGES",rids:r}));let a=Date.now(),u=[];for(let{rid:l}of t)!Z.has(l)&&Z.size<5e3&&(Z.add(l),u.push({rid:l,source:"dom",discoveredAt:a,updatedAt:a}));u.length>0&&h({type:"OBJECTS_DISCOVERED",objects:u})}function Ee(){for(let t of document.querySelectorAll(".crev-label"))t.remove();for(let t of document.querySelectorAll(".crev-outline"))t.classList.remove("crev-outline"),t.style.removeProperty("--crev-color");let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),ge=null,ue=new WeakSet,z.clear()}function it(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=T.get(t);if(n){let r=e.querySelector(".crev-label-text");r&&(r.textContent=n.businessId??n.name??U(n.type)),e.classList.remove("crev-label-loading");let o=e.parentElement;if(o){let a=J(n.type);o.style.setProperty("--crev-color",a)}n.type&&ne.has(n.type)&&!e.querySelector(".crev-ec-btn")&&e.appendChild(De(t,n.type))}}}function st(e,t){let n=T.get(t);chrome.runtime.sendMessage({type:"GET_FAVORITES"},r=>{r?.entries&&(W=new Set(r.entries.map(o=>o.rid))),Pe(e,{rid:t,businessId:n?.businessId,templateBusinessId:n?.templateBusinessId,type:n?.type,name:n?.name,isFavorite:W.has(t)},o=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:o})},o=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:o,name:n?.name,objectType:n?.type,businessId:n?.businessId}),W.has(o)?W.delete(o):W.add(o)},o=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:o})})})}document.addEventListener("keydown",e=>{e.key==="Escape"&&le()&&w()});document.addEventListener("click",e=>{!le()||e.target.closest("#crev-quick-inspector")||w()},!0);function fe(...e){let t=document.getElementById("crev-paint-banner"),n=document.getElementById("crev-paint-text");if(!(!t||!n)){if(N==="off"){t.style.display="none";return}if(t.style.display="block",t.style.background="#ff832b",e.length>0){S(n,...e);return}N==="picking"?S(n,"Paint Format \u2014 ",y("b",null,"click a widget to pick its style")):S(n,"Paint Format from ",y("b",null,ye??"?")," \u2014 click widgets to apply")}}function Be(){let e=N!=="off"?"crosshair":"pointer";for(let t of document.querySelectorAll(".crev-label-text"))t.style.cursor=e;fe()}function at(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let o=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(o),setTimeout(()=>{r.classList.remove(o)},600)}if(t)R("Applied \u2014 refresh page to see changes","success");else{let o=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Paint error: ${n??"unknown"}`;R(o,"error")}}function ct(e,t){let n=document.getElementById("crev-paint-text");if(n){if(t.length===0){S(n,"No style differences \u2014 already identical"),setTimeout(()=>fe(),2e3);return}S(n,y("div",{style:"margin-bottom:3px"},"Style changes:"),...t.map(r=>y("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},y("b",null,r.prop),": ",r.from," \u2192 ",r.to)),y("div",{style:"margin-top:4px"},y("button",{class:"crev-paint-apply-btn",onClick:()=>{h({type:"PAINT_CONFIRM",rid:e}),S(n,"Applying\u2026")}},"Apply"),y("button",{class:"crev-paint-cancel-btn",onClick:()=>fe()},"Cancel")))}}function lt(e,t){M&&(clearTimeout(M),M=null);let n=document.getElementById("crev-tooltip");if(!n)return;let r=T.get(t),o=J(r?.type),a=U(r?.type),u=r?.type??(x.has(t)?"Loading\u2026":"Unknown");S(n,y("div",{class:"crev-tt-type",style:`background:${o}`},a)," ",y("span",{style:"color:#8d8d8d;font-size:10px"},u),r?.name&&y("div",{class:"crev-tt-name"},r.name),r?.businessId&&y("div",{class:"crev-tt-row"},`ID: ${r.businessId}`),y("div",{class:"crev-tt-row"},`RID: ${t}`)),n.style.top="-9999px",n.style.left="-9999px",n.style.display="block";let l=e.getBoundingClientRect(),d=n.getBoundingClientRect(),c=l.bottom+4,p=l.left;c+d.height>window.innerHeight&&(c=l.top-d.height-4),c<4&&(c=4),p+d.width>window.innerWidth&&(p=window.innerWidth-d.width-4),p<0&&(p=4),n.style.top=`${c}px`,n.style.left=`${p}px`}function dt(){M&&clearTimeout(M),M=setTimeout(()=>{let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),M=null},50)}$("crev_sync_inspect",e=>{let t=e;if(t.active!==O){E=!0;try{be(t.active)}finally{E=!1}}});$("crev_sync_paint",e=>{let t=e;E=!0;try{N=t.phase,ye=t.sourceName??null,Be()}finally{E=!1}});$("crev_sync_overlay",e=>{let t=e;if(t.active!==F){E=!0;try{F=t.active,ve()}finally{E=!1}}});$("crev_sync_profile",e=>{let t=e;E=!0,C?.isBmp&&q(t.label,t.connected!==!1?"connected":"disconnected"),E=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=T.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){b.swallow("content:contextmenu",o)}}}},!0);var pt=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),ut=new Set(["expression","html","javascript"]),gt=6;function ve(){if(F){let e=[];for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");n&&!z.has(n)&&e.push(n)}if(e.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:e},t=>{if(!chrome.runtime.lastError&&t?.type==="OVERLAY_PROPS_DATA"&&t.props){for(let[n,r]of Object.entries(t.props))z.set(n,r);me()}})}catch(t){b.swallow("content:getOverlayProps",t)}}me()}function me(){for(let e of document.querySelectorAll("[data-crev-label]")){let t=e.getAttribute("data-crev-label");if(!t)continue;let n=T.get(t),r=e.querySelector(".crev-label-text");if(r)if(F){e.classList.add("crev-label--card");let o=n?.type??"Unknown",a=n?.businessId??"",u=n?.name??"unnamed",l=t.length>12?t.slice(0,6)+"\u2026"+t.slice(-4):t;r.innerHTML="";let d=document.createElement("span");d.className="crev-card-line crev-card-type",d.textContent=a?`${o} | ${a}`:o;let c=document.createElement("span");c.className="crev-card-line",c.textContent=u;let p=document.createElement("span");p.className="crev-card-line crev-card-rid",p.textContent=l,r.appendChild(d),r.appendChild(c),r.appendChild(p);let g=z.get(t);if(g){let i=Object.entries(g).filter(([m])=>!pt.has(m));if(i.length>0){let m=document.createElement("span");m.className="crev-card-sep",r.appendChild(m);let _=0;for(let[L,P]of i){if(_>=gt)break;let k=document.createElement("span");if(k.className="crev-card-line crev-card-prop",ut.has(L)){let D=P.split(`
`).length;k.textContent=`${L}: ${D} line${D!==1?"s":""}`}else{let D=P.length>30?P.slice(0,27)+"\u2026":P;k.textContent=`${L}: ${D}`}r.appendChild(k),_++}}}}else e.classList.remove("crev-label--card"),r.innerHTML="",r.textContent=n?.businessId??n?.name??U(n?.type)}}function ft(){Q||(Q=new MutationObserver(e=>{e.every(n=>n.type!=="childList"||n.removedNodes.length>0?!1:Array.from(n.addedNodes).every(r=>r instanceof HTMLElement&&(r.classList.contains("crev-label")||r.id==="crev-tooltip")))||(window.location.href!==Ne&&(Ne=window.location.href,x.clear(),Z.clear(),A&&(clearTimeout(A),A=null,X=null),He()),O&&(V&&clearTimeout(V),V=setTimeout(()=>K(),150)))}),Q.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=Q)}function He(){let e=oe();C=e,h({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&h(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(C&&n.length>0){let r=[...C.signals,...n],o=n.length*.15,a=Math.min(1,C.confidence+o),u=a>=.5;h({type:"DETECTION_RESULT",confidence:a,signals:r,isBmp:u})}}}));function mt(){let e=xe(),t=C??oe(),n=t.isBmp?Ce():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return be(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=mt();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>b.swallow("content:clipboardWrite",r)),!1});function yt(){window.__crev_observer?.disconnect(),Ee(),w(),Ae(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),pe=!1}window.__crev_content_loaded&&yt();window.__crev_content_loaded=!0;try{ae()}catch(e){b.swallow("content:init:port",e)}try{He()}catch(e){b.swallow("content:init:detection",e)}try{ft()}catch(e){b.swallow("content:init:observer",e)}})();
