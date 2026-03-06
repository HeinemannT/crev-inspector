"use strict";(()=>{var q=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],re="#33b1ff",oe={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},ie={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(q.map(e=>[e,re]))},se={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...oe},F="#8d8d8d";function A(e){return e?ie[e]??F:F}function w(e){return e?se[e]??e.substring(0,3).toUpperCase():"?"}var ae={ExtendedTable:["expression"],...Object.fromEntries(q.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},N=new Set(Object.keys(ae));function $(){let e=new URLSearchParams(window.location.search),n={},t=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return t&&(n.rid=t),r&&(n.tabRid=r),n}function ce(){let e=[],n=new Set;for(let t of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(n.has(t))continue;let r=t.getAttribute("data-rid")??t.getAttribute("data-object-rid")??t.getAttribute("data-container-rid");r&&(e.push({element:t,rid:r}),n.add(t))}return e}function le(){let e=[];for(let n of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(n.href,window.location.origin).searchParams.get("rid");r&&e.push({element:n,rid:r})}catch{}return e}function M(e=!0){let n=ce();if(!e)return n;let t=new Set;for(let r of n)t.add(r.element);for(let r of le())t.has(r.element)||(n.push(r),t.add(r.element));return n}function z(){let e=[],n=new Set;for(let{element:t,rid:r}of M()){if(n.has(r))continue;n.add(r);let o=t.getBoundingClientRect(),s=t.getAttribute("data-test");e.push({rid:r,name:s??t.getAttribute("title")??void 0,element:t.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var de=.5;function R(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(t=>t.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let n=Math.min(1,e.reduce((t,r)=>t+r.weight,0));return{isBmp:n>=de,confidence:n,signals:e.map(t=>t.name)}}function a(e,n,...t){let r=document.createElement(e);if(n)for(let[o,s]of Object.entries(n))s==null||s===!1||(o.startsWith("on")&&typeof s=="function"?r.addEventListener(o.slice(2).toLowerCase(),s):o==="class"||o==="className"?r.className=String(s):o==="style"?r.setAttribute("style",String(s)):o==="checked"||o==="disabled"||o==="readOnly"?s===!0&&(r[o]=!0):o==="value"?r.value=String(s):r.setAttribute(o,s===!0?"":String(s)));return B(r,t),r}function g(e,...n){e.textContent="",B(e,n)}function B(e,n){for(let t of n)t==null||t===!1||(Array.isArray(t)?B(e,t):t instanceof Node?e.appendChild(t):e.appendChild(document.createTextNode(String(t))))}var D="[CREV]",p={debug(e,...n){},info(e,...n){console.info(`${D}:${e}`,...n)},warn(e,n,...t){console.warn(`${D}:${e}`,n,...t)},error(e,n,...t){console.error(`${D}:${e}`,n,...t)},swallow(e,n){}};var X=`.crev-outline {\r
  outline: 2px solid var(--crev-color, #8d8d8d) !important;\r
  outline-offset: -2px !important;\r
  border-radius: 0 !important;\r
}\r
.crev-label {\r
  position: absolute;\r
  top: 2px; right: 2px;\r
  z-index: 10000;\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 5px;\r
  padding: 2px 7px;\r
  border-radius: 4px;\r
  font: 600 11px/1.3 system-ui, sans-serif;\r
  color: #fff;\r
  background: var(--crev-color, #8d8d8d);\r
  opacity: 0.93;\r
  box-shadow: 0 1px 3px rgba(0,0,0,0.25);\r
  pointer-events: auto;\r
  user-select: none;\r
  white-space: nowrap;\r
}\r
.crev-label:hover { opacity: 1; animation: none; }\r
.crev-label-flash-pick { background: #ff832b !important; }\r
.crev-label-flash-ok { background: #42be65 !important; }\r
.crev-label-flash-error { background: #fa4d56 !important; }\r
.crev-label-text {\r
  cursor: pointer;\r
  max-width: 140px;\r
  overflow: hidden;\r
  text-overflow: ellipsis;\r
}\r
@keyframes crev-shimmer {\r
  0%, 100% { opacity: 0.93; }\r
  50% { opacity: 0.5; }\r
}\r
.crev-label-loading {\r
  animation: crev-shimmer 1.5s ease-in-out infinite;\r
}\r
.crev-ec-btn {\r
  display: inline-flex;\r
  align-items: center;\r
  justify-content: center;\r
  padding: 1px 6px;\r
  margin-left: 2px;\r
  border: 1px solid rgba(0,0,0,0.3);\r
  background: rgba(255,255,255,0.2);\r
  color: #fff;\r
  font: 700 10px/1.2 'SF Mono', 'Cascadia Code', Consolas, monospace;\r
  border-radius: 3px;\r
  cursor: pointer;\r
  letter-spacing: -0.5px;\r
}\r
.crev-ec-btn:hover { background: rgba(255,255,255,0.4); border-color: rgba(255,255,255,0.8); }\r
.crev-paint-apply-btn {\r
  background: #fff;\r
  color: #ff832b;\r
  border: none;\r
  border-radius: 3px;\r
  padding: 2px 10px;\r
  font-weight: 700;\r
  cursor: pointer;\r
  margin-right: 6px;\r
}\r
.crev-paint-cancel-btn {\r
  background: rgba(255,255,255,0.2);\r
  color: #fff;\r
  border: 1px solid rgba(255,255,255,0.4);\r
  border-radius: 3px;\r
  padding: 2px 10px;\r
  cursor: pointer;\r
}\r
#crev-paint-banner {\r
  position: fixed;\r
  top: 0; left: 0; right: 0;\r
  z-index: 2147483646;\r
  padding: 5px 12px;\r
  background: #ff832b;\r
  color: #fff;\r
  font: 600 11px/1.4 system-ui, sans-serif;\r
  text-align: center;\r
  display: none;\r
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);\r
}\r
#crev-paint-banner b { font-weight: 800; }\r
#crev-paint-banner .crev-paint-close {\r
  position: absolute;\r
  right: 8px;\r
  top: 3px;\r
  background: none;\r
  border: none;\r
  color: #fff;\r
  font-size: 14px;\r
  cursor: pointer;\r
  opacity: 0.7;\r
}\r
#crev-paint-banner .crev-paint-close:hover { opacity: 1; }\r
#crev-tooltip {\r
  position: fixed;\r
  z-index: 2147483647;\r
  padding: 8px 12px;\r
  border-radius: 8px;\r
  font: 11px/1.4 'Segoe UI', Roboto, system-ui, sans-serif;\r
  color: #e6e1e5;\r
  background: #36343b;\r
  border: 1px solid #49454f;\r
  box-shadow: 0 4px 8px rgba(0,0,0,0.4);\r
  pointer-events: none;\r
  display: none;\r
  max-width: 300px;\r
}\r
#crev-tooltip .crev-tt-type {\r
  display: inline-block;\r
  padding: 1px 6px;\r
  border-radius: 3px;\r
  font-size: 10px;\r
  font-weight: 600;\r
  color: #fff;\r
  margin-bottom: 3px;\r
}\r
#crev-tooltip .crev-tt-name {\r
  font-weight: 600;\r
  margin-bottom: 2px;\r
}\r
#crev-tooltip .crev-tt-row {\r
  color: #c6c6c6;\r
  font-size: 10px;\r
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;\r
  word-break: break-all;\r
}\r
`;var h=!1,H="widgets",x="off",Z=null,E=null,P=null,U=!1,C=new Map,G=new WeakSet,b=new Set,Y=new Set,K=window.location.href,u=null,k=null,L=200,m=[],v=null,_=null,V=null;function Q(){try{E=chrome.runtime.connect({name:"content"}),L=200}catch(e){p.swallow("content:connectPort",e);return}if(me(),u&&m.length===0){let e=u;queueMicrotask(()=>{f({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}E.onMessage.addListener(e=>{switch(e.type){case"INSPECT_STATE":ee(e.active);break;case"BADGE_ENRICHMENT":for(let[n,t]of Object.entries(e.enrichments))C.set(n,t);h&&be();break;case"PAINT_STATE":x=e.phase,Z=e.sourceName??null,ye();break;case"PAINT_PREVIEW":he(e.rid,e.diff);break;case"PAINT_APPLY_RESULT":Te(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==H&&(H=e.mode,h&&(b.clear(),W(),S()));break;case"RE_ENRICH":b.clear(),h&&S();break}}),E.onDisconnect.addListener(()=>{E=null,b.clear();try{chrome.runtime.getURL(""),setTimeout(()=>{Q();for(let e of document.querySelectorAll(".crev-label"))e.style.opacity="0.4",setTimeout(()=>{e.style.opacity=""},800);h&&S()},L),L=Math.min(L*2,1e4)}catch(e){p.swallow("content:reconnectCheck",e)}})}function f(e){if(E)try{E.postMessage(e);return}catch(n){p.swallow("content:sendToSW",n),E=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(n=>p.swallow("content:oneShot",n))}catch(n){p.swallow("content:oneShotOuter",n)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"){if(e.type==="DETECTION_RESULT"){let n=m.findIndex(t=>t.type==="DETECTION_RESULT");n>=0&&m.splice(n,1)}for(m.push(e);m.length>20;)m.shift()}}function me(){for(;m.length>0;){let e=m.shift();try{E?.postMessage(e)}catch(n){p.swallow("content:flushPending",n);break}}}function ee(e){h=e,e?(Ee(),S()):(_&&(clearTimeout(_),_=null),W(),b.clear())}function Ee(){if(U)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=X,document.head.appendChild(e);let n=document.createElement("div");n.id="crev-tooltip",document.body.appendChild(n),document.body.addEventListener("mouseover",r=>{if(!h)return;let o=r.target.closest?.(".crev-outline");if(o!==V)if(V=o,o){let i=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");i&&ve(o,i)}else Ce()});let t=a("div",{id:"crev-paint-banner"},a("span",{id:"crev-paint-text"},"Paint Format"),a("button",{class:"crev-paint-close",id:"crev-paint-close",onClick:()=>f({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(t),U=!0}function te(e,n){let t=document.createElement("button");return t.className="crev-ec-btn",t.textContent=n==="CustomVisualization"?"</>":"EC",t.title="Open in editor",t.addEventListener("click",r=>{r.preventDefault(),r.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),t}function S(){for(let i of document.querySelectorAll(".crev-label"))(!i.parentElement||!document.body.contains(i.parentElement))&&i.remove();let e=M(H==="all"),n=[],t=e.filter(({element:i})=>!G.has(i)),r=new Set;for(let{element:i}of t)window.getComputedStyle(i).position==="static"&&r.add(i);for(let{element:i,rid:c}of t){let d=C.get(c),y=A(d?.type);i.classList.add("crev-outline"),i.style.setProperty("--crev-color",y),r.has(i)&&(i.style.position="relative",i.setAttribute("data-crev-repositioned","true"));let l=document.createElement("span");l.className="crev-label",d||l.classList.add("crev-label-loading"),l.setAttribute("data-crev-label",c);let T=document.createElement("span");T.className="crev-label-text",T.textContent=d?.businessId??d?.name??w(d?.type),l.appendChild(T),T.addEventListener("click",j=>{if(j.preventDefault(),j.stopPropagation(),x==="picking"){f({type:"PAINT_PICK",rid:c}),l.classList.add("crev-label-flash-pick"),setTimeout(()=>{l.classList.remove("crev-label-flash-pick")},400);return}if(x==="applying"){f({type:"PAINT_APPLY",rid:c});return}let ne=C.get(c)?.businessId??c;navigator.clipboard.writeText(ne).then(()=>{let O=T.textContent;T.textContent="\u2713",l.classList.add("crev-label-flash-ok"),setTimeout(()=>{T.textContent=O,l.classList.remove("crev-label-flash-ok")},600)}).catch(O=>p.swallow("content:clipboard",O))}),d?.type&&N.has(d.type)&&l.appendChild(te(c,d.type)),i.appendChild(l),G.add(i),!C.has(c)&&!b.has(c)&&(n.push(c),b.add(c))}n.length>0&&f({type:"ENRICH_BADGES",rids:n});let o=Date.now(),s=[];for(let{rid:i}of e)Y.has(i)||(Y.add(i),s.push({rid:i,source:"dom",discoveredAt:o,updatedAt:o}));s.length>0&&f({type:"OBJECTS_DISCOVERED",objects:s})}function W(){for(let n of document.querySelectorAll(".crev-label"))n.remove();for(let n of document.querySelectorAll(".crev-outline"))n.classList.remove("crev-outline"),n.style.removeProperty("--crev-color");for(let n of document.querySelectorAll("[data-crev-repositioned]"))n.style.position="",n.removeAttribute("data-crev-repositioned");let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),V=null,G=new WeakSet}function be(){for(let e of document.querySelectorAll("[data-crev-label]")){let n=e.getAttribute("data-crev-label");if(!n)continue;let t=C.get(n);if(t){let r=e.querySelector(".crev-label-text");r&&(r.textContent=t.businessId??t.name??w(t.type)),e.classList.remove("crev-label-loading");let o=e.parentElement;if(o){let s=A(t.type);o.style.setProperty("--crev-color",s)}t.type&&N.has(t.type)&&!e.querySelector(".crev-ec-btn")&&e.appendChild(te(n,t.type))}}}function I(...e){let n=document.getElementById("crev-paint-banner"),t=document.getElementById("crev-paint-text");if(!(!n||!t)){if(x==="off"){n.style.display="none";return}if(n.style.display="block",n.style.background="#ff832b",e.length>0){g(t,...e);return}x==="picking"?g(t,"Paint Format \u2014 ",a("b",null,"click a widget to pick its style")):g(t,"Paint Format from ",a("b",null,Z??"?")," \u2014 click widgets to apply")}}function ye(){let e=x!=="off"?"crosshair":"pointer";for(let n of document.querySelectorAll(".crev-label-text"))n.style.cursor=e;I()}function Te(e,n,t){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let s=n?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(s),setTimeout(()=>{r.classList.remove(s)},600)}let o=document.getElementById("crev-paint-banner");if(o)if(n)I("Applied style \u2014 ",a("b",null,"refresh page to see changes")),setTimeout(()=>I(),3e3);else{o.style.background="#da1e28";let s=document.getElementById("crev-paint-text");if(s){let i=t==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Error: ${t??"unknown"}`;g(s,i)}setTimeout(()=>{o.style.background="#ff832b",I()},4e3)}}function he(e,n){let t=document.getElementById("crev-paint-text");if(t){if(n.length===0){g(t,"No style differences \u2014 already identical"),setTimeout(()=>I(),2e3);return}g(t,a("div",{style:"margin-bottom:3px"},"Style changes:"),...n.map(r=>a("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},a("b",null,r.prop),": ",r.from," \u2192 ",r.to)),a("div",{style:"margin-top:4px"},a("button",{class:"crev-paint-apply-btn",onClick:()=>{f({type:"PAINT_CONFIRM",rid:e}),g(t,"Applying\u2026")}},"Apply"),a("button",{class:"crev-paint-cancel-btn",onClick:()=>I()},"Cancel")))}}function ve(e,n){v&&(clearTimeout(v),v=null);let t=document.getElementById("crev-tooltip");if(!t)return;let r=C.get(n),o=A(r?.type),s=w(r?.type),i=r?.type??(b.has(n)?"Loading\u2026":"Unknown");g(t,a("div",{class:"crev-tt-type",style:`background:${o}`},s)," ",a("span",{style:"color:#8d8d8d;font-size:10px"},i),r?.name&&a("div",{class:"crev-tt-name"},r.name),r?.businessId&&a("div",{class:"crev-tt-row"},`ID: ${r.businessId}`),a("div",{class:"crev-tt-row"},`RID: ${n}`)),t.style.top="-9999px",t.style.left="-9999px",t.style.display="block";let c=e.getBoundingClientRect(),d=t.getBoundingClientRect(),y=c.bottom+4,l=c.left;y+d.height>window.innerHeight&&(y=c.top-d.height-4),y<4&&(y=4),l+d.width>window.innerWidth&&(l=window.innerWidth-d.width-4),l<0&&(l=4),t.style.top=`${y}px`,t.style.left=`${l}px`}function Ce(){v&&clearTimeout(v),v=setTimeout(()=>{let e=document.getElementById("crev-tooltip");e&&(e.style.display="none"),v=null},50)}function _e(){P||(P=new MutationObserver(e=>{e.every(t=>t.type!=="childList"||t.removedNodes.length>0?!1:Array.from(t.addedNodes).every(r=>r instanceof HTMLElement&&(r.classList.contains("crev-label")||r.id==="crev-tooltip")))||(window.location.href!==K&&(K=window.location.href,b.clear(),Y.clear()),h&&(_&&clearTimeout(_),_=setTimeout(()=>S(),150)),k&&clearTimeout(k),k=setTimeout(()=>{let t=R();(!u||t.confidence!==u.confidence||t.isBmp!==u.isBmp)&&(u=t,f({type:"DETECTION_RESULT",confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}))},2e3))}),P.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=P)}function Ie(){let e=R();u=e,f({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),window.postMessage({source:"crev-content",payload:{type:"CHECK_BMP_SIGNALS"}},"*")}window.addEventListener("message",e=>{if(e.source!==window)return;let n=e.data;if(n?.source!=="crev-interceptor")return;let t=n.payload;if(t.type==="OBJECTS_DISCOVERED"&&f(t),t.type==="BMP_SIGNALS_RESULT"){let r=t.signals??[];if(u&&r.length>0){let o=[...u.signals,...r],s=r.length*.15,i=Math.min(1,u.confidence+s),c=i>=.5;f({type:"DETECTION_RESULT",confidence:i,signals:o,isBmp:c})}}});function xe(){let e=$(),n=u??R(),t=n.isBmp?z():[];return n.isBmp&&window.postMessage({source:"crev-content",payload:{type:"EXTRACT_FIBERS"}},"*"),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:t,detection:{confidence:n.confidence,signals:n.signals,isBmp:n.isBmp}}}chrome.runtime.onMessage.addListener((e,n,t)=>{if(e.type==="INSPECT_STATE")return ee(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=xe();return t({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>p.swallow("content:clipboardWrite",r)),!1});function Se(){window.__crev_observer?.disconnect(),W(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),U=!1}window.__crev_content_loaded&&Se();window.__crev_content_loaded=!0;try{Q()}catch(e){p.swallow("content:init:port",e)}try{Ie()}catch(e){p.swallow("content:init:detection",e)}try{_e()}catch(e){p.swallow("content:init:observer",e)}})();
