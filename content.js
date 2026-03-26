"use strict";(()=>{function ce(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function He(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function Be(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function Z(e=!0){let t=He();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of Be())n.has(r.element)||(t.push(r),n.add(r.element));return t}function le(){let e=[],t=new Set;for(let{element:n,rid:r}of Z()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),s=n.getAttribute("data-test");e.push({rid:r,name:s??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var Ve=.5;function z(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=Ve,confidence:t,signals:e.map(n=>n.name)}}function b(e,t,...n){let r=document.createElement(e);if(t)for(let[o,s]of Object.entries(t))s==null||s===!1||(o.startsWith("on")&&typeof s=="function"?r.addEventListener(o.slice(2).toLowerCase(),s):o==="class"||o==="className"?r.className=String(s):o==="style"?r.setAttribute("style",String(s)):o==="checked"||o==="disabled"||o==="readOnly"?s===!0&&(r[o]=!0):o==="value"?r.value=String(s):r.setAttribute(o,s===!0?"":String(s)));return Q(r,n),r}function x(e,...t){e.textContent="",Q(e,t)}function Q(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?Q(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var k="[CREV]",h={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${k}:${e}`,...t)},info(e,...t){console.info(`${k}:${e}`,...t)},warn(e,t,...n){console.warn(`${k}:${e}`,t,...n)},error(e,t,...n){console.error(`${k}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${k}:${e} [swallowed]`,t)}};var S=null,D=200,T=[],de=null,pe=null;function ue(e){de=e}function ge(e){pe=e}function ee(){try{S=chrome.runtime.connect({name:"content"}),D=200}catch(e){h.swallow("port:connect",e);return}S.onMessage.addListener(e=>{de?.(e)}),Fe(),S.onDisconnect.addListener(()=>{S=null;try{chrome.runtime.getURL("");let e=D>200;setTimeout(()=>{if(ee(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);pe?.()},D),D=Math.min(D*2,1e4)}catch(e){h.swallow("port:reconnectCheck",e)}})}function v(e){if(S)try{S.postMessage(e);return}catch(t){h.swallow("port:send",t),S=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>h.swallow("port:oneShot",t))}catch(t){h.swallow("port:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"||e.type==="ENRICH_BADGES"){if(e.type==="DETECTION_RESULT"){let t=T.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&T.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=T[T.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}if(e.type==="ENRICH_BADGES"){let t=T[T.length-1];if(t?.type==="ENRICH_BADGES"){let n=new Set(t.rids);for(let r of e.rids)n.has(r)||t.rids.push(r);return}}for(T.push(e);T.length>20;)T.shift()}}function Fe(){for(;T.length>0;){let e=T.shift();try{S?.postMessage(e)}catch(t){h.swallow("port:flush",t);break}}}var Ye="crev-env-tag",te="crev_env_tag_pos",d=null,w=null,M=null;function fe(e,t){if(d){H(e,t);return}d=document.createElement("div"),d.id=Ye,w=document.createElement("span"),w.className="crev-env-dot",M=document.createElement("span"),M.className="crev-env-label",d.appendChild(w),d.appendChild(M),document.body.appendChild(d),H(e,t),chrome.storage.local.get(te,l=>{let p=l[te];p&&d&&(d.style.bottom=`${p.bottom??12}px`,d.style.top="auto",p.snap==="left"?(d.classList.add("crev-env-tag--edge-left"),d.style.left="0",d.style.right="auto"):p.snap==="right"?(d.classList.add("crev-env-tag--edge-right"),d.style.right="0",d.style.left="auto"):(d.style.right=`${p.right??12}px`,d.style.left="auto"))});let n=!1,r=0,o=0,s=0,u=0;d.addEventListener("mousedown",l=>{if(l.button===0){if(l.preventDefault(),n=!0,r=l.clientX,o=l.clientY,d){d.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let p=d.getBoundingClientRect();s=window.innerWidth-p.right,u=window.innerHeight-p.bottom,d.style.right=`${s}px`,d.style.bottom=`${u}px`,d.style.left="auto",d.style.top="auto"}document.addEventListener("mousemove",m),document.addEventListener("mouseup",a)}});function m(l){if(!n||!d)return;let p=l.clientX-r,g=l.clientY-o,c=Math.max(0,s-p),E=Math.max(0,u-g);d.style.right=`${c}px`,d.style.bottom=`${E}px`,d.style.left="auto",d.style.top="auto"}function a(){if(n=!1,document.removeEventListener("mousemove",m),document.removeEventListener("mouseup",a),!d)return;let l=d.getBoundingClientRect(),p=l.left+l.width/2,g=window.innerWidth;d.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let c=null;p<g*.15?(c="left",d.classList.add("crev-env-tag--edge-left"),d.style.left="0",d.style.right="auto"):p>g*.85&&(c="right",d.classList.add("crev-env-tag--edge-right"),d.style.right="0",d.style.left="auto");let E=d.getBoundingClientRect(),y={right:Math.round(window.innerWidth-E.right),bottom:Math.round(window.innerHeight-E.bottom)};c&&(y.snap=c),chrome.storage.local.set({[te]:y}).catch(()=>{})}}function H(e,t){w&&(w.className=`crev-env-dot crev-env-dot--${t}`),M&&(M.textContent=e||"CREV")}function me(){d?.remove(),d=null,w=null,M=null}var Ee="crev-toast-container";function qe(){let e=document.getElementById(Ee);return e||(e=document.createElement("div"),e.id=Ee,document.body.appendChild(e)),e}function I(e,t){let n=qe(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var be={Group:"g",ROLE:"role",ACCESSPROFILE:"ap",DEFAULTS:"d",FileResource:"r",TranslationFile:"r",APIResource:"r",RemoteResource:"r",APIEndpoint:"r",APIClientAuthentication:"r",EndpointParameter:"r",LogFolder:"r",CorpoLog:"r",SqlResource:"r",PowerBiResource:"r",TextMethodConfig:"k",ListMethodConfig:"k",HistoricalListMethodConfig:"k",HistoricalReferenceMethodConfig:"k",HistoricalTextMethodConfig:"k",RichTextMethodConfig:"k",ExtendedMethodConfig:"k",TokenMethodConfig:"k",HistoricalRichTextMethodConfig:"k",HistoricalDateMethodConfig:"k",BooleanMethodConfig:"k",ReferenceMethodConfig:"k",UrlMethodConfig:"k",FunctionMethodConfig:"k",HistoricalNumberMethodConfig:"k",NumberMethodConfig:"k",DateMethodConfig:"k",TagMethodConfig:"k",HistoricalBooleanMethodConfig:"k",ListPropertySet:"k",ListPropertySetItem:"k",Category:"t",ExtendedExpression:"t",ProcessDefinition:"t",ClassConfig:"t",Transformer:"t",CEVENDOR:"ceven",CETASK:"cetas",CECOMMENT:"cecom",CEINCIDENT:"ceinc",CEPROCEDURE:"cepro",CEPOLICY:"cepol",CECONTROLMEASURE:"cecme",CEISSUE:"ceiss",CEASSET:"ceass",CESERVICE:"ceser",CECONTRACT:"cecot",CEPROJECT:"ceprj",CEREGULATION:"cereg",CECOMPLIANCEREQUIREMENT:"cecor",CEINDICATOR:"ceind",CEATTACHMENT:"ceatt",CERISKASSESSMENT:"ceras",CEPRODUCT:"ceprd",CEPRESCREENING:"cepsc",CEPRIVACY:"ceprv",CEWORKFLOW:"cewfl",CEDISTRIBUTION:"cedis",CEINQUIRY:"ceinq",CEQUESTIONNAIRE:"ceqst",CEDPIA:"cedpi",CETIA:"cetia",CEASSURANCEACTIVITY:"ceasa"},B=new Set(Object.values(be));B.add("t");B.add("o");B.add("u");B.add("s");B.add("p");function q(e,t){return t==="ctrl"&&e.businessId?{text:`${je(e.type??"")}.${e.businessId}`,label:"ref"}:t==="shift"&&e.templateBusinessId?{text:e.templateBusinessId,label:"Template ID"}:{text:e.businessId??e.rid,label:"ID"}}function j(e){return e.ctrlKey||e.metaKey?"ctrl":e.shiftKey?"shift":"plain"}var he="Copy ID \xB7 Shift \u2192 Template \xB7 Ctrl \u2192 Reference";function je(e){return be[e]??"t"}var C=(e,t=12)=>`<svg width="${t}" height="${t}" viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${e}"/></svg>`,Ct=C("M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z"),Tt=C("M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"),xt=C("M236,112a68.07,68.07,0,0,1-68,68H61l27.52,27.51a12,12,0,0,1-17,17l-48-48a12,12,0,0,1,0-17l48-48a12,12,0,1,1,17,17L61,156H168a44,44,0,0,0,0-88H80a12,12,0,0,1,0-24h88A68.07,68.07,0,0,1,236,112Z"),It=C("M212,40a12,12,0,0,1-12,12H170.71A20,20,0,0,0,151,68.42L142.38,116H184a12,12,0,0,1,0,24H138l-9.44,51.87A44,44,0,0,1,85.29,228H56a12,12,0,0,1,0-24H85.29A20,20,0,0,0,105,187.58L113.62,140H72a12,12,0,0,1,0-24h46l9.44-51.87A44,44,0,0,1,170.71,28H200A12,12,0,0,1,212,40Z"),St=C("M54.8,119.49A35.06,35.06,0,0,1,49.05,128a35.06,35.06,0,0,1,5.75,8.51C60,147.24,60,159.83,60,172c0,25.94,1.84,32,20,32a12,12,0,0,1,0,24c-19.14,0-32.2-6.9-38.8-20.51C36,196.76,36,184.17,36,172c0-25.94-1.84-32-20-32a12,12,0,0,1,0-24c18.16,0,20-6.06,20-32,0-12.17,0-24.76,5.2-35.49C47.8,34.9,60.86,28,80,28a12,12,0,0,1,0,24c-18.16,0-20,6.06-20,32C60,96.17,60,108.76,54.8,119.49ZM240,116c-18.16,0-20-6.06-20-32,0-12.17,0-24.76-5.2-35.49C208.2,34.9,195.14,28,176,28a12,12,0,0,0,0,24c18.16,0,20,6.06,20,32,0,12.17,0,24.76,5.2,35.49A35.06,35.06,0,0,0,207,128a35.06,35.06,0,0,0-5.75,8.51C196,147.24,196,159.83,196,172c0,25.94-1.84,32-20,32a12,12,0,0,0,0,24c19.14,0,32.2-6.9,38.8-20.51C220,196.76,220,184.17,220,172c0-25.94,1.84-32,20-32a12,12,0,0,0,0-24Z"),Rt=C("M140,80v41.21l34.17,20.5a12,12,0,1,1-12.34,20.58l-40-24A12,12,0,0,1,116,128V80a12,12,0,0,1,24,0ZM128,28A99.38,99.38,0,0,0,57.24,57.34c-4.69,4.74-9,9.37-13.24,14V64a12,12,0,0,0-24,0v40a12,12,0,0,0,12,12H72a12,12,0,0,0,0-24H57.77C63,86,68.37,80.22,74.26,74.26a76,76,0,1,1,1.58,109,12,12,0,0,0-16.48,17.46A100,100,0,1,0,128,28Z"),ye=C("M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z"),ve=C("M71.68,97.22,34.74,128l36.94,30.78a12,12,0,1,1-15.36,18.44l-48-40a12,12,0,0,1,0-18.44l48-40A12,12,0,0,1,71.68,97.22Zm176,21.56-48-40a12,12,0,1,0-15.36,18.44L221.26,128l-36.94,30.78a12,12,0,1,0,15.36,18.44l48-40a12,12,0,0,0,0-18.44ZM164.1,28.72a12,12,0,0,0-15.38,7.18l-64,176a12,12,0,0,0,7.18,15.37A11.79,11.79,0,0,0,96,228a12,12,0,0,0,11.28-7.9l64-176A12,12,0,0,0,164.1,28.72Z"),ne=C("M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"),_t=C("M219.71,117.38a12,12,0,0,0-7.25-8.52L161.28,88.39l10.59-70.61a12,12,0,0,0-20.64-10l-112,120a12,12,0,0,0,4.31,19.33l51.18,20.47L84.13,238.22a12,12,0,0,0,20.64,10l112-120A12,12,0,0,0,219.71,117.38ZM113.6,203.55l6.27-41.77a12,12,0,0,0-7.41-12.92L68.74,131.37,142.4,52.45l-6.27,41.77a12,12,0,0,0,7.41,12.92l43.72,17.49Z"),Ce=C("M230.14,70.54,185.46,25.85a20,20,0,0,0-28.29,0L33.86,149.17A19.85,19.85,0,0,0,28,163.31V208a20,20,0,0,0,20,20H92.69a19.86,19.86,0,0,0,14.14-5.86L230.14,98.82a20,20,0,0,0,0-28.28ZM91,204H52V165l84-84,39,39ZM192,103,153,64l18.34-18.34,39,39Z"),Te=C("M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z");var Ge="crev-quick-inspector",f=null,xe=null;function Ie(e,t,n,r,o){if(R(),xe=t.rid,f=document.createElement("div"),f.id=Ge,t.type){let c=document.createElement("span");c.className="crev-qi-badge",c.textContent=t.type,f.appendChild(c)}if(t.name){let c=document.createElement("div");c.className="crev-qi-name",c.textContent=t.name,f.appendChild(c)}if(t.businessId){let c=document.createElement("div");c.className="crev-qi-row",c.textContent=`ID: ${t.businessId}`,f.appendChild(c)}if(t.templateBusinessId){let c=document.createElement("div");c.className="crev-qi-row crev-qi-template",c.textContent=`Template: ${t.templateBusinessId}`,f.appendChild(c)}let s=document.createElement("div");if(s.className="crev-qi-row crev-qi-rid",s.textContent=`RID: ${t.rid}`,f.appendChild(s),t.codePreview){let c=document.createElement("div");c.className="crev-qi-code",c.textContent=t.codePreview,f.appendChild(c)}let u=document.createElement("button");u.className=`crev-qi-star${t.isFavorite?" active":""}`,u.textContent=t.isFavorite?"\u2605":"\u2606",u.title=t.isFavorite?"Remove from pinned":"Pin this object",u.setAttribute("aria-label",u.title),u.addEventListener("click",c=>{c.stopPropagation(),r?.(t.rid);let E=u.classList.toggle("active");u.textContent=E?"\u2605":"\u2606",u.title=E?"Remove from pinned":"Pin this object",u.setAttribute("aria-label",u.title)}),f.appendChild(u);let m=document.createElement("div");m.className="crev-qi-actions";let a=document.createElement("button");a.className="crev-qi-btn",a.textContent="Copy RID",a.addEventListener("click",c=>{c.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{a.innerHTML=ne,setTimeout(()=>{a.textContent="Copy RID"},600)}).catch(()=>{})});let l=document.createElement("button");l.className="crev-qi-btn",l.textContent="Copy ID",l.title=he,l.addEventListener("click",c=>{c.stopPropagation();let{text:E,label:y}=q({rid:t.rid,businessId:t.businessId,type:t.type,templateBusinessId:t.templateBusinessId},j(c));navigator.clipboard.writeText(E).then(()=>{l.innerHTML=`${ne} ${y}`,setTimeout(()=>{l.textContent="Copy ID"},600)}).catch(()=>{})});let p=document.createElement("button");p.className="crev-qi-btn crev-qi-btn--accent",p.innerHTML=`${Ce} Editor`,p.addEventListener("click",c=>{c.stopPropagation(),n(t.rid),R()});let g=document.createElement("button");g.className="crev-qi-btn",g.innerHTML=`${Te} Full View`,g.addEventListener("click",c=>{c.stopPropagation(),o?.(t.rid),R()}),m.appendChild(a),m.appendChild(l),m.appendChild(p),m.appendChild(g),f.appendChild(m),document.body.appendChild(f),We(e)}function We(e){if(!f)return;f.style.top="-9999px",f.style.left="-9999px",f.style.display="block";let t=e.getBoundingClientRect(),n=f.getBoundingClientRect(),r=6,o=t.bottom+r,s=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),s+n.width>window.innerWidth-r&&(s=window.innerWidth-n.width-r),s<r&&(s=r),f.style.top=`${o}px`,f.style.left=`${s}px`}function R(){f?.remove(),f=null,xe=null}function re(){return f!=null}var oe=new Map;function V(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function U(e,t){let n=oe.get(e);n||(n=[],oe.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=oe.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var Se=`.crev-outline {
  position: relative !important;
}
.crev-outline::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--crev-color, #707070);
  opacity: 0.35;
  pointer-events: none;
  z-index: 9999;
  border-radius: 2px;
}
.crev-label {
  position: absolute;
  top: 2px; right: 2px;
  z-index: 10000;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 2px;
  font: 600 11px/1.3 'Inter', system-ui, sans-serif;
  color: #fff;
  background: var(--crev-color, #707070);
  box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  pointer-events: auto;
  user-select: none;
  white-space: nowrap;
}
.crev-label:hover { filter: brightness(1.15); }
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
  padding: 2px 4px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.6);
  color: rgba(255,255,255,0.9);
  font: 600 9px/1.2 'Inter', system-ui, sans-serif;
  border-radius: 2px;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.crev-ec-btn svg, .crev-action-btn svg {
  width: 10px;
  height: 10px;
}
.crev-ec-btn:hover, .crev-action-btn:hover {
  background: rgba(0,0,0,0.7);
  color: #fff;
  border-color: rgba(255,255,255,0.5);
}
.crev-paint-apply-btn {
  background: #fff;
  color: #ff832b;
  border: none;
  border-radius: 4px;
  padding: 2px 10px;
  font-weight: 700;
  cursor: pointer;
  margin-right: 6px;
}
.crev-paint-cancel-btn {
  background: rgba(255,255,255,0.2);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.4);
  border-radius: 4px;
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
  border-radius: 4px;
  font: 11px/1.4 'Inter', system-ui, sans-serif;
  color: #e4e4e4;
  background: #1a1a1a;
  border: 1px solid #333333;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  pointer-events: none;
  display: none;
  max-width: 300px;
}
#crev-tooltip .crev-tt-type {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--type-color, #707070);
  margin-bottom: 3px;
}
#crev-tooltip .crev-tt-typename {
  color: #707070;
  font-size: 10px;
}
#crev-tooltip .crev-tt-name {
  font-weight: 600;
  margin-bottom: 2px;
}
#crev-tooltip .crev-tt-row {
  color: #b0b0b0;
  font-size: 10px;
  font-family: 'SF Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
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
  border-radius: 4px;
  background: rgba(17, 17, 17, 0.85);
  border: 1px solid rgba(68, 68, 68, 0.6);
  font: 500 10px/1.3 'Inter', system-ui, sans-serif;
  color: #b0b0b0;
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
  border-radius: 4px;
  font: 500 11px/1.4 'Inter', system-ui, sans-serif;
  color: #fff;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
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
  background: rgba(250, 77, 86, 0.92);
}
.crev-toast--info {
  background: rgba(120, 169, 255, 0.92);
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
.crev-card-rid { font-family: 'SF Mono', 'Cascadia Code', Consolas, ui-monospace, monospace; font-size: 9px; opacity: 0.8; }
.crev-card-sep {
  display: block;
  height: 1px;
  background: rgba(255,255,255,0.15);
  margin: 3px 0;
}
.crev-card-prop {
  font-size: 9px;
  opacity: 0.7;
  font-family: 'SF Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
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
  color: #707070;
  padding: 0;
  line-height: 1;
}
.crev-qi-star:hover { color: #f1c21b; }
.crev-qi-star.active { color: #f1c21b; }

/* \u2500\u2500 Quick Inspector Popup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

#crev-quick-inspector {
  position: fixed;
  z-index: 2147483647;
  padding: 12px 16px;
  border-radius: 8px;
  background: #1a1a1a;
  border: 1px solid #333333;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  font: 12px/1.5 'Inter', system-ui, sans-serif;
  color: #e4e4e4;
  min-width: 220px;
  max-width: 340px;
}
.crev-qi-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: #2a1a3e;
  color: #ba0ffe;
  margin-bottom: 4px;
}
.crev-qi-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crev-qi-row {
  font-size: 10px;
  color: #b0b0b0;
}
.crev-qi-template {
  color: #707070;
}
.crev-qi-rid {
  font-family: 'SF Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  word-break: break-all;
  margin-bottom: 8px;
  color: #707070;
}
.crev-qi-code {
  font-family: 'SF Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  font-size: 9px;
  line-height: 1.3;
  color: #707070;
  max-height: 28px;
  overflow: hidden;
  white-space: pre;
  margin-top: 4px;
  padding: 4px 6px;
  background: rgba(255,255,255,0.03);
  border-radius: 2px;
  -webkit-mask-image: linear-gradient(to bottom, black 50%, transparent);
  mask-image: linear-gradient(to bottom, black 50%, transparent);
}
.crev-qi-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #333333;
}
.crev-qi-btn {
  padding: 4px 12px;
  border: 1px solid #444444;
  border-radius: 4px;
  background: #252525;
  color: #e4e4e4;
  font: 500 10px/1.2 'Inter', system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
  transition: background 100ms, border-color 100ms;
}
.crev-qi-btn:hover {
  background: #333333;
  border-color: #444444;
}
.crev-qi-btn--accent {
  border-color: #ba0ffe;
  color: #ba0ffe;
}
.crev-qi-btn--accent:hover {
  background: #ba0ffe;
  color: #fff;
}

/* \u2500\u2500 Focus States (content overlay can't use base.css) \u2500\u2500 */

.crev-ec-btn:focus-visible,
.crev-action-btn:focus-visible,
.crev-qi-btn:focus-visible,
.crev-qi-star:focus-visible,
.crev-paint-apply-btn:focus-visible,
.crev-paint-cancel-btn:focus-visible,
#crev-paint-banner .crev-paint-close:focus-visible {
  outline: 2px solid #ba0ffe;
  outline-offset: 2px;
}

.crev-label-text:focus-visible {
  outline: 2px solid #ba0ffe;
  outline-offset: 1px;
}
`;var G=class{inspectActive=!1;enrichMode="all";paintPhase="off";paintSourceName=null;styleInjected=!1;technicalOverlay=!1;fromSync=!1;prevConnDisplay=null;lastUrl=typeof window<"u"?window.location.href:"";lastDetection=null;enrichments=new Map;overlayProps=new Map;badgedElements=new WeakSet;requestedRids=new Set;discoveredRids=new Set;favoriteRids=new Set;observer=null;tooltipHideTimer=null;debounceTimer=null;labelClickTimer=null;hoveredOutlineEl=null;labelClickRid=null;resetOverlays(){this.badgedElements=new WeakSet,this.requestedRids.clear(),this.overlayProps.clear(),this.labelClickTimer&&(clearTimeout(this.labelClickTimer),this.labelClickTimer=null),this.labelClickRid=null,this.hoveredOutlineEl=null}resetDiscovery(){this.discoveredRids.clear()}resetAll(){this.inspectActive=!1,this.enrichMode="all",this.paintPhase="off",this.paintSourceName=null,this.styleInjected=!1,this.technicalOverlay=!1,this.fromSync=!1,this.prevConnDisplay=null,this.lastUrl=typeof window<"u"?window.location.href:"",this.lastDetection=null,this.enrichments.clear(),this.resetOverlays(),this.resetDiscovery(),this.favoriteRids.clear(),this.debounceTimer&&(clearTimeout(this.debounceTimer),this.debounceTimer=null),this.tooltipHideTimer&&(clearTimeout(this.tooltipHideTimer),this.tooltipHideTimer=null),this.observer?.disconnect(),this.observer=null}};var _e=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],Ke="#33b1ff",Xe={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},Ze={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(_e.map(e=>[e,Ke]))},ze={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...Xe},Re="#707070";function F(e){return e?Ze[e]??Re:Re}function P(e){return e?ze[e]??e.substring(0,3).toUpperCase():"?"}var Qe={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(_e.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},Ae=new Set(Object.keys(Qe));function Oe(e,t){let n=document.createElement("span");if(n.className="crev-actions",t.type&&Ae.has(t.type)){let o=document.createElement("button");o.className="crev-ec-btn",o.innerHTML=ve,o.title="Open in editor",o.setAttribute("aria-label","Open in editor"),o.addEventListener("click",s=>{s.preventDefault(),s.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n.appendChild(o)}let r=document.createElement("button");return r.className="crev-action-btn",r.innerHTML=ye,r.title="Find references",r.setAttribute("aria-label","Find references"),r.addEventListener("click",o=>{o.preventDefault(),o.stopPropagation(),chrome.runtime.sendMessage({type:"SEARCH_REFERENCES",rid:e,businessId:t.businessId,objectType:t.type,name:t.name})}),n.appendChild(r),n}function A(e){for(let a of document.querySelectorAll(".crev-label"))(!a.parentElement||!document.body.contains(a.parentElement))&&a.remove();let t=e.enrichMode==="all",n=Z(t),r=t?n.filter(({element:a})=>a.tagName==="A").length:0;h.debug("sync",`syncOverlays: ${n.length} elements (${r} links), enrichMode=${e.enrichMode}`);let o=[],s=n.filter(({element:a})=>!e.badgedElements.has(a));for(let{element:a,rid:l}of s){let p=e.enrichments.get(l),g=F(p?.type);a.classList.add("crev-outline"),a.style.setProperty("--crev-color",g);let c=document.createElement("span");c.className="crev-label",p||c.classList.add("crev-label-loading"),c.setAttribute("data-crev-label",l);let E=document.createElement("span");E.className="crev-label-text",E.textContent=p?.businessId??p?.name??P(p?.type),c.appendChild(E),E.addEventListener("click",y=>{if(y.preventDefault(),y.stopPropagation(),e.paintPhase==="picking"){v({type:"PAINT_PICK",rid:l}),c.classList.add("crev-label-flash-pick"),setTimeout(()=>{c.classList.remove("crev-label-flash-pick")},400);return}if(e.paintPhase==="applying"){v({type:"PAINT_APPLY",rid:l});return}if(e.labelClickRid===l&&e.labelClickTimer){clearTimeout(e.labelClickTimer),e.labelClickTimer=null,e.labelClickRid=null,tt(e,c,l);return}let Y=j(y);e.labelClickRid=l,e.labelClickTimer=setTimeout(()=>{e.labelClickTimer=null,e.labelClickRid=null;let N=e.enrichments.get(l),{text:O,label:_}=q({rid:l,...N},Y),L=_==="ID"?"\u2713":`\u2713 ${_}`;navigator.clipboard.writeText(O).then(()=>{let X=E.textContent;E.textContent=L,c.classList.add("crev-label-flash-ok"),setTimeout(()=>{E.textContent=X,c.classList.remove("crev-label-flash-ok")},600)}).catch(X=>h.swallow("content:clipboard",X))},250)}),a.appendChild(c),p&&a.appendChild(Oe(l,p)),e.badgedElements.add(a),!e.enrichments.has(l)&&!e.requestedRids.has(l)&&(o.push(l),e.requestedRids.add(l))}for(let{rid:a}of n)!e.enrichments.has(a)&&!e.requestedRids.has(a)&&(o.push(a),e.requestedRids.add(a));o.length>0&&(h.debug("sync",`ENRICH_BADGES: sending ${o.length} RIDs`,o),v({type:"ENRICH_BADGES",rids:o}));let u=Date.now(),m=[];for(let{rid:a}of n)!e.discoveredRids.has(a)&&e.discoveredRids.size<5e3&&(e.discoveredRids.add(a),m.push({rid:a,source:"dom",discoveredAt:u,updatedAt:u}));m.length>0&&v({type:"OBJECTS_DISCOVERED",objects:m})}function W(e){for(let n of document.querySelectorAll(".crev-label"))n.remove();for(let n of document.querySelectorAll(".crev-actions"))n.remove();for(let n of document.querySelectorAll(".crev-outline"))n.classList.remove("crev-outline"),n.style.removeProperty("--crev-color");let t=document.getElementById("crev-tooltip");t&&(t.style.display="none"),e.hoveredOutlineEl=null,e.badgedElements=new WeakSet,e.overlayProps.clear()}function Le(e){for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");if(!n)continue;let r=e.enrichments.get(n);if(r){let o=t.querySelector(".crev-label-text");o&&(o.textContent=r.businessId??r.name??P(r.type)),t.classList.remove("crev-label-loading");let s=t.parentElement;if(s){let u=F(r.type);s.style.setProperty("--crev-color",u)}s&&!s.querySelector(".crev-actions")&&s.appendChild(Oe(n,r))}}}function tt(e,t,n){let r=e.enrichments.get(n),o=!1,s=!1,u,m=()=>{!o||!s||Ie(t,{rid:n,businessId:r?.businessId,templateBusinessId:r?.templateBusinessId,type:r?.type,name:r?.name,isFavorite:e.favoriteRids.has(n),codePreview:u},a=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:a})},a=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:a,name:r?.name,objectType:r?.type,businessId:r?.businessId}),e.favoriteRids.has(a)?e.favoriteRids.delete(a):e.favoriteRids.add(a)},a=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:a})})};chrome.runtime.sendMessage({type:"GET_FAVORITES"},a=>{a?.entries&&(e.favoriteRids=new Set(a.entries.map(l=>l.rid))),o=!0,m()}),chrome.runtime.sendMessage({type:"HOVER_LOOKUP",rid:n},a=>{a?.codePreview&&(u=a.codePreview.split(`
`).slice(0,2).join(`
`)),s=!0,m()})}function ie(e,...t){let n=document.getElementById("crev-paint-banner"),r=document.getElementById("crev-paint-text");if(!(!n||!r)){if(e.paintPhase==="off"){n.style.display="none";return}if(n.style.display="block",n.style.background="#ff832b",t.length>0){x(r,...t);return}e.paintPhase==="picking"?x(r,"Paint Format \u2014 ",b("b",null,"click a widget to pick its style")):x(r,"Paint Format from ",b("b",null,e.paintSourceName??"?")," \u2014 click widgets to apply")}}function se(e){let t=e.paintPhase!=="off"?"crosshair":"pointer";for(let n of document.querySelectorAll(".crev-label-text"))n.style.cursor=t;ie(e)}function we(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let o=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(o),setTimeout(()=>{r.classList.remove(o)},600)}if(t)I("Applied \u2014 refresh page to see changes","success");else{let o=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Paint error: ${n??"unknown"}`;I(o,"error")}}function Me(e,t,n){let r=document.getElementById("crev-paint-text");if(r){if(n.length===0){x(r,"No style differences \u2014 already identical"),setTimeout(()=>ie(e),2e3);return}x(r,b("div",{style:"margin-bottom:3px"},"Style changes:"),...n.map(o=>b("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},b("b",null,o.prop),": ",o.from," \u2192 ",o.to)),b("div",{style:"margin-top:4px"},b("button",{class:"crev-paint-apply-btn",onClick:()=>{v({type:"PAINT_CONFIRM",rid:t}),x(r,"Applying\u2026")}},"Apply"),b("button",{class:"crev-paint-cancel-btn",onClick:()=>ie(e)},"Cancel")))}}var nt=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),rt=new Set(["expression","html","javascript"]),ot=6;function Pe(e,t,n){e.tooltipHideTimer&&(clearTimeout(e.tooltipHideTimer),e.tooltipHideTimer=null);let r=document.getElementById("crev-tooltip");if(!r)return;let o=e.enrichments.get(n),s=F(o?.type),u=P(o?.type),m=o?.type??(e.requestedRids.has(n)?"Loading\u2026":"Unknown");x(r,b("div",{class:"crev-tt-type",style:`--type-color:${s}`},u)," ",b("span",{class:"crev-tt-typename"},m),o?.name&&b("div",{class:"crev-tt-name"},o.name),o?.businessId&&b("div",{class:"crev-tt-row"},`ID: ${o.businessId}`),b("div",{class:"crev-tt-row"},`RID: ${n}`)),r.style.top="-9999px",r.style.left="-9999px",r.style.display="block";let a=t.getBoundingClientRect(),l=r.getBoundingClientRect(),p=a.bottom+4,g=a.left;p+l.height>window.innerHeight&&(p=a.top-l.height-4),p<4&&(p=4),g+l.width>window.innerWidth&&(g=window.innerWidth-l.width-4),g<0&&(g=4),r.style.top=`${p}px`,r.style.left=`${g}px`}function Ne(e){e.tooltipHideTimer&&clearTimeout(e.tooltipHideTimer),e.tooltipHideTimer=setTimeout(()=>{let t=document.getElementById("crev-tooltip");t&&(t.style.display="none"),e.tooltipHideTimer=null},50)}function K(e){if(e.technicalOverlay){let t=[];for(let n of document.querySelectorAll("[data-crev-label]")){let r=n.getAttribute("data-crev-label");r&&!e.overlayProps.has(r)&&t.push(r)}if(t.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:t},n=>{if(!chrome.runtime.lastError&&n?.type==="OVERLAY_PROPS_DATA"&&n.props){for(let[r,o]of Object.entries(n.props))e.overlayProps.set(r,o);$(e)}})}catch{}}$(e)}function $(e){for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");if(!n)continue;let r=e.enrichments.get(n),o=t.querySelector(".crev-label-text");if(o)if(e.technicalOverlay){t.classList.add("crev-label--card");let s=r?.type??"Unknown",u=r?.businessId??"",m=r?.name??"unnamed",a=n.length>12?n.slice(0,6)+"\u2026"+n.slice(-4):n;o.innerHTML="";let l=document.createElement("span");l.className="crev-card-line crev-card-type",l.textContent=u?`${s} | ${u}`:s;let p=document.createElement("span");p.className="crev-card-line",p.textContent=m;let g=document.createElement("span");g.className="crev-card-line crev-card-rid",g.textContent=a,o.appendChild(l),o.appendChild(p),o.appendChild(g);let c=e.overlayProps.get(n);if(c){let E=Object.entries(c).filter(([y])=>!nt.has(y));if(E.length>0){let y=document.createElement("span");y.className="crev-card-sep",o.appendChild(y);let Y=0;for(let[N,O]of E){if(Y>=ot)break;let _=document.createElement("span");if(_.className="crev-card-line crev-card-prop",rt.has(N)){let L=O.split(`
`).length;_.textContent=`${N}: ${L} line${L!==1?"s":""}`}else{let L=O.length>30?O.slice(0,27)+"\u2026":O;_.textContent=`${N}: ${L}`}o.appendChild(_),Y++}}}}else t.classList.remove("crev-label--card"),o.innerHTML="",o.textContent=r?.businessId??r?.name??P(r?.type)}}function ke(e,t){e.observer||(e.observer=new MutationObserver(n=>{n.every(o=>o.type!=="childList"||o.removedNodes.length>0?!1:Array.from(o.addedNodes).every(s=>s instanceof HTMLElement&&(s.classList.contains("crev-label")||s.id==="crev-tooltip")))||(window.location.href!==e.lastUrl&&(e.lastUrl=window.location.href,e.resetOverlays(),e.resetDiscovery(),t()),e.inspectActive&&(e.debounceTimer&&clearTimeout(e.debounceTimer),e.debounceTimer=setTimeout(()=>A(e),150)))}),e.observer.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=e.observer)}var i=new G;function ae(e){i.inspectActive=e,e?(st(),A(i)):(i.debounceTimer&&(clearTimeout(i.debounceTimer),i.debounceTimer=null),W(i),i.requestedRids.clear(),R())}function st(){if(i.styleInjected)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=Se,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!i.inspectActive)return;let o=r.target.closest?.(".crev-outline");if(o!==i.hoveredOutlineEl)if(i.hoveredOutlineEl=o,o){let u=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");u&&Pe(i,o,u)}else Ne(i)});let n=b("div",{id:"crev-paint-banner"},b("span",{id:"crev-paint-text"},"Paint Format"),b("button",{class:"crev-paint-close",id:"crev-paint-close","aria-label":"Close paint mode",onClick:()=>v({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),i.styleInjected=!0}function at(e){let t=i.prevConnDisplay;i.prevConnDisplay=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";i.lastDetection?.isBmp&&fe(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?I(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?I("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?I("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&I("Server down","error"))}function ct(e){I(`Switched to ${e}`,"info"),i.overlayProps.clear(),$(i),i.technicalOverlay&&K(i),i.lastDetection?.isBmp&&H(e,"connected")}function De(){let e=z();i.lastDetection=e,v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}function lt(){let e=ce(),t=i.lastDetection??z(),n=t.isBmp?le():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}ue(e=>{switch(e.type){case"INSPECT_STATE":ae(e.active),i.fromSync||V("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))i.enrichments.set(t,n);i.inspectActive&&Le(i);break;case"PAINT_STATE":i.paintPhase=e.phase,i.paintSourceName=e.sourceName??null,se(i),i.fromSync||V("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":Me(i,e.rid,e.diff);break;case"PAINT_APPLY_RESULT":we(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==i.enrichMode&&(i.enrichMode=e.mode,i.inspectActive&&(i.requestedRids.clear(),W(i),A(i)));break;case"RE_ENRICH":i.requestedRids.clear(),i.inspectActive&&A(i);break;case"CONNECTION_STATE":at(e.state);break;case"PROFILE_SWITCHED":ct(e.label),i.fromSync||V("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":i.technicalOverlay=e.active,K(i),i.fromSync||V("crev_sync_overlay",{active:e.active});break}});ge(()=>{if(i.requestedRids.clear(),i.lastDetection){let e=i.lastDetection;queueMicrotask(()=>{v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}i.inspectActive&&A(i)});U("crev_sync_inspect",e=>{let t=e;if(t.active!==i.inspectActive){i.fromSync=!0;try{ae(t.active)}finally{i.fromSync=!1}}});U("crev_sync_paint",e=>{let t=e;i.fromSync=!0;try{i.paintPhase=t.phase,i.paintSourceName=t.sourceName??null,se(i)}finally{i.fromSync=!1}});U("crev_sync_overlay",e=>{let t=e;if(t.active!==i.technicalOverlay){i.fromSync=!0;try{i.technicalOverlay=t.active,K(i)}finally{i.fromSync=!1}}});U("crev_sync_profile",e=>{let t=e;i.fromSync=!0,i.lastDetection?.isBmp&&H(t.label,t.connected!==!1?"connected":"disconnected"),i.fromSync=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=i.enrichments.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){h.swallow("content:contextmenu",o)}}}},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&re()&&R()});document.addEventListener("click",e=>{!re()||e.target.closest("#crev-quick-inspector")||R()},!0);document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&v(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(i.lastDetection&&n.length>0){let r=[...i.lastDetection.signals,...n],o=n.length*.15,s=Math.min(1,i.lastDetection.confidence+o),u=s>=.5;v({type:"DETECTION_RESULT",confidence:s,signals:r,isBmp:u})}}}));chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return ae(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=lt();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>h.swallow("content:clipboardWrite",r)),!1});function dt(){i.observer?.disconnect(),W(i),R(),me(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),i.styleInjected=!1}window.__crev_content_loaded&&dt();window.__crev_content_loaded=!0;try{ee()}catch(e){h.swallow("content:init:port",e)}try{De()}catch(e){h.swallow("content:init:detection",e)}try{ke(i,De)}catch(e){h.swallow("content:init:observer",e)}})();
