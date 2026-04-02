"use strict";(()=>{function ce(){let e=new URLSearchParams(window.location.search),t={},n=e.get("rid"),r=e.get("tabrid")??e.get("tabRid");return n&&(t.rid=n),r&&(t.tabRid=r),t}function De(){let e=[],t=new Set;for(let n of document.querySelectorAll("[data-rid],[data-object-rid],[data-container-rid]")){if(t.has(n))continue;let r=n.getAttribute("data-rid")??n.getAttribute("data-object-rid")??n.getAttribute("data-container-rid");r&&(e.push({element:n,rid:r}),t.add(n))}return e}function He(){let e=[];for(let t of document.querySelectorAll('a[href*="rid="]'))try{let r=new URL(t.href,window.location.origin).searchParams.get("rid");r&&e.push({element:t,rid:r})}catch{}return e}function X(e=!0){let t=De();if(!e)return t;let n=new Set;for(let r of t)n.add(r.element);for(let r of He())n.has(r.element)||(t.push(r),n.add(r.element));return t}function le(){let e=[],t=new Set;for(let{element:n,rid:r}of X()){if(t.has(r))continue;t.add(r);let o=n.getBoundingClientRect(),c=n.getAttribute("data-test");e.push({rid:r,name:c??n.getAttribute("title")??void 0,element:n.tagName.toLowerCase(),rect:{top:o.top,left:o.left,width:o.width,height:o.height}})}return e}var Be=.5;function z(){let e=[];document.getElementById("epmapp")&&e.push({name:"#epmapp container",weight:.35}),document.getElementById("corpo-app")&&e.push({name:"#corpo-app root",weight:.35}),document.querySelector("[data-rid]")&&e.push({name:"data-rid attributes",weight:.25});try{[...document.fonts].some(n=>n.family.includes("LatoLatinWeb"))&&e.push({name:"LatoLatinWeb font",weight:.2})}catch{}/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname)&&e.push({name:"BMP URL path",weight:.25}),document.title.includes("Corporater")&&e.push({name:"BMP page title",weight:.2}),document.querySelector(".widget__body, .ag-root-wrapper")&&e.push({name:"BMP widget classes",weight:.15}),document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]')&&e.push({name:"BMP assets",weight:.15});let t=Math.min(1,e.reduce((n,r)=>n+r.weight,0));return{isBmp:t>=Be,confidence:t,signals:e.map(n=>n.name)}}function h(e,t,...n){let r=document.createElement(e);if(t)for(let[o,c]of Object.entries(t))c==null||c===!1||(o.startsWith("on")&&typeof c=="function"?r.addEventListener(o.slice(2).toLowerCase(),c):o==="class"||o==="className"?r.className=String(c):o==="style"?r.setAttribute("style",String(c)):o==="checked"||o==="disabled"||o==="readOnly"?c===!0&&(r[o]=!0):o==="value"?r.value=String(c):r.setAttribute(o,c===!0?"":String(c)));return Q(r,n),r}function x(e,...t){e.textContent="",Q(e,t)}function Q(e,t){for(let n of t)n==null||n===!1||(Array.isArray(n)?Q(e,n):n instanceof Node?e.appendChild(n):e.appendChild(document.createTextNode(String(n))))}var D="[CREV]",y={debug(e,...t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${D}:${e}`,...t)},info(e,...t){console.info(`${D}:${e}`,...t)},warn(e,t,...n){console.warn(`${D}:${e}`,t,...n)},error(e,t,...n){console.error(`${D}:${e}`,t,...n)},swallow(e,t){typeof localStorage<"u"&&localStorage.getItem("crev_debug")&&console.debug(`${D}:${e} [swallowed]`,t)}};var _=null,H=200,T=[],de=null,pe=null;function ue(e){de=e}function ge(e){pe=e}function ee(){try{_=chrome.runtime.connect({name:"content"}),H=200}catch(e){y.swallow("port:connect",e);return}_.onMessage.addListener(e=>{de?.(e)}),Ue(),_.onDisconnect.addListener(()=>{_=null;try{chrome.runtime.getURL("");let e=H>200;setTimeout(()=>{if(ee(),e)for(let t of document.querySelectorAll(".crev-label"))t.style.opacity="0.4",setTimeout(()=>{t.style.opacity=""},800);pe?.()},H),H=Math.min(H*2,1e4)}catch(e){y.swallow("port:reconnectCheck",e)}})}function v(e){if(_)try{_.postMessage(e);return}catch(t){y.swallow("port:send",t),_=null}if(e.type==="DETECTION_RESULT")try{chrome.runtime.sendMessage(e).catch(t=>y.swallow("port:oneShot",t))}catch(t){y.swallow("port:oneShotOuter",t)}if(e.type==="DETECTION_RESULT"||e.type==="OBJECTS_DISCOVERED"||e.type==="ENRICH_BADGES"){if(e.type==="DETECTION_RESULT"){let t=T.findIndex(n=>n.type==="DETECTION_RESULT");t>=0&&T.splice(t,1)}if(e.type==="OBJECTS_DISCOVERED"){let t=T[T.length-1];if(t?.type==="OBJECTS_DISCOVERED"){let n=new Set(t.objects.map(r=>r.rid));for(let r of e.objects)n.has(r.rid)||t.objects.push(r);return}}if(e.type==="ENRICH_BADGES"){let t=T[T.length-1];if(t?.type==="ENRICH_BADGES"){let n=new Set(t.rids);for(let r of e.rids)n.has(r)||t.rids.push(r);return}}for(T.push(e);T.length>20;)T.shift()}}function Ue(){for(;T.length>0;){let e=T.shift();try{_?.postMessage(e)}catch(t){y.swallow("port:flush",t);break}}}var Fe="crev-env-tag",te="crev_env_tag_pos",d=null,L=null,w=null;function fe(e,t){if(d){B(e,t);return}d=document.createElement("div"),d.id=Fe,L=document.createElement("span"),L.className="crev-env-dot",w=document.createElement("span"),w.className="crev-env-label",d.appendChild(L),d.appendChild(w),document.body.appendChild(d),B(e,t),chrome.storage.local.get(te,l=>{let u=l[te];u&&d&&(d.style.bottom=`${u.bottom??12}px`,d.style.top="auto",u.snap==="left"?(d.classList.add("crev-env-tag--edge-left"),d.style.left="0",d.style.right="auto"):u.snap==="right"?(d.classList.add("crev-env-tag--edge-right"),d.style.right="0",d.style.left="auto"):(d.style.right=`${u.right??12}px`,d.style.left="auto"))});let n=!1,r=0,o=0,c=0,p=0;d.addEventListener("mousedown",l=>{if(l.button===0){if(l.preventDefault(),n=!0,r=l.clientX,o=l.clientY,d){d.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let u=d.getBoundingClientRect();c=window.innerWidth-u.right,p=window.innerHeight-u.bottom,d.style.right=`${c}px`,d.style.bottom=`${p}px`,d.style.left="auto",d.style.top="auto"}document.addEventListener("mousemove",E),document.addEventListener("mouseup",s)}});function E(l){if(!n||!d)return;let u=l.clientX-r,f=l.clientY-o,a=Math.max(0,c-u),g=Math.max(0,p-f);d.style.right=`${a}px`,d.style.bottom=`${g}px`,d.style.left="auto",d.style.top="auto"}function s(){if(n=!1,document.removeEventListener("mousemove",E),document.removeEventListener("mouseup",s),!d)return;let l=d.getBoundingClientRect(),u=l.left+l.width/2,f=window.innerWidth;d.classList.remove("crev-env-tag--edge-left","crev-env-tag--edge-right");let a=null;u<f*.15?(a="left",d.classList.add("crev-env-tag--edge-left"),d.style.left="0",d.style.right="auto"):u>f*.85&&(a="right",d.classList.add("crev-env-tag--edge-right"),d.style.right="0",d.style.left="auto");let g=d.getBoundingClientRect(),b={right:Math.round(window.innerWidth-g.right),bottom:Math.round(window.innerHeight-g.bottom)};a&&(b.snap=a),chrome.storage.local.set({[te]:b}).catch(()=>{})}}function B(e,t){L&&(L.className=`crev-env-dot crev-env-dot--${t}`),w&&(w.textContent=e||"CREV")}function me(){d?.remove(),d=null,L=null,w=null}var Ee="crev-toast-container";function Ye(){let e=document.getElementById(Ee);return e||(e=document.createElement("div"),e.id=Ee,document.body.appendChild(e)),e}function I(e,t){let n=Ye(),r=document.createElement("div");for(r.className=`crev-toast crev-toast--${t}`,r.textContent=e,n.appendChild(r);n.children.length>3;)n.children[0].remove();requestAnimationFrame(()=>{r.classList.add("crev-toast--visible")}),setTimeout(()=>{r.classList.remove("crev-toast--visible"),r.classList.add("crev-toast--exit"),setTimeout(()=>r.remove(),300)},3e3)}var he={Group:"g",ROLE:"role",ACCESSPROFILE:"ap",DEFAULTS:"d",FileResource:"r",TranslationFile:"r",APIResource:"r",RemoteResource:"r",APIEndpoint:"r",APIClientAuthentication:"r",EndpointParameter:"r",LogFolder:"r",CorpoLog:"r",SqlResource:"r",PowerBiResource:"r",TextMethodConfig:"k",ListMethodConfig:"k",HistoricalListMethodConfig:"k",HistoricalReferenceMethodConfig:"k",HistoricalTextMethodConfig:"k",RichTextMethodConfig:"k",ExtendedMethodConfig:"k",TokenMethodConfig:"k",HistoricalRichTextMethodConfig:"k",HistoricalDateMethodConfig:"k",BooleanMethodConfig:"k",ReferenceMethodConfig:"k",UrlMethodConfig:"k",FunctionMethodConfig:"k",HistoricalNumberMethodConfig:"k",NumberMethodConfig:"k",DateMethodConfig:"k",TagMethodConfig:"k",HistoricalBooleanMethodConfig:"k",ListPropertySet:"k",ListPropertySetItem:"k",Category:"t",ExtendedExpression:"t",ProcessDefinition:"t",ClassConfig:"t",Transformer:"t",CEVENDOR:"ceven",CETASK:"cetas",CECOMMENT:"cecom",CEINCIDENT:"ceinc",CEPROCEDURE:"cepro",CEPOLICY:"cepol",CECONTROLMEASURE:"cecme",CEISSUE:"ceiss",CEASSET:"ceass",CESERVICE:"ceser",CECONTRACT:"cecot",CEPROJECT:"ceprj",CEREGULATION:"cereg",CECOMPLIANCEREQUIREMENT:"cecor",CEINDICATOR:"ceind",CEATTACHMENT:"ceatt",CERISKASSESSMENT:"ceras",CEPRODUCT:"ceprd",CEPRESCREENING:"cepsc",CEPRIVACY:"ceprv",CEWORKFLOW:"cewfl",CEDISTRIBUTION:"cedis",CEINQUIRY:"ceinq",CEQUESTIONNAIRE:"ceqst",CEDPIA:"cedpi",CETIA:"cetia",CEASSURANCEACTIVITY:"ceasa"},V=new Set(Object.values(he));V.add("t");V.add("o");V.add("u");V.add("s");V.add("p");function G(e,t){return t==="ctrl"&&e.businessId?{text:`${qe(e.type??"")}.${e.businessId}`,label:"ref"}:t==="shift"?e.templateBusinessId?{text:e.templateBusinessId,label:"Template ID"}:{text:"",label:"No template"}:{text:e.businessId??e.rid,label:"ID"}}function j(e){return e.ctrlKey||e.metaKey?"ctrl":e.shiftKey?"shift":"plain"}var ye="Copy ID \xB7 Shift \u2192 Template \xB7 Ctrl \u2192 Reference";function qe(e){return he[e]??"t"}var C=(e,t=12)=>`<svg width="${t}" height="${t}" viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${e}"/></svg>`,vt=C("M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z"),Ct=C("M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"),Tt=C("M236,112a68.07,68.07,0,0,1-68,68H61l27.52,27.51a12,12,0,0,1-17,17l-48-48a12,12,0,0,1,0-17l48-48a12,12,0,1,1,17,17L61,156H168a44,44,0,0,0,0-88H80a12,12,0,0,1,0-24h88A68.07,68.07,0,0,1,236,112Z"),xt=C("M212,40a12,12,0,0,1-12,12H170.71A20,20,0,0,0,151,68.42L142.38,116H184a12,12,0,0,1,0,24H138l-9.44,51.87A44,44,0,0,1,85.29,228H56a12,12,0,0,1,0-24H85.29A20,20,0,0,0,105,187.58L113.62,140H72a12,12,0,0,1,0-24h46l9.44-51.87A44,44,0,0,1,170.71,28H200A12,12,0,0,1,212,40Z"),It=C("M54.8,119.49A35.06,35.06,0,0,1,49.05,128a35.06,35.06,0,0,1,5.75,8.51C60,147.24,60,159.83,60,172c0,25.94,1.84,32,20,32a12,12,0,0,1,0,24c-19.14,0-32.2-6.9-38.8-20.51C36,196.76,36,184.17,36,172c0-25.94-1.84-32-20-32a12,12,0,0,1,0-24c18.16,0,20-6.06,20-32,0-12.17,0-24.76,5.2-35.49C47.8,34.9,60.86,28,80,28a12,12,0,0,1,0,24c-18.16,0-20,6.06-20,32C60,96.17,60,108.76,54.8,119.49ZM240,116c-18.16,0-20-6.06-20-32,0-12.17,0-24.76-5.2-35.49C208.2,34.9,195.14,28,176,28a12,12,0,0,0,0,24c18.16,0,20,6.06,20,32,0,12.17,0,24.76,5.2,35.49A35.06,35.06,0,0,0,207,128a35.06,35.06,0,0,0-5.75,8.51C196,147.24,196,159.83,196,172c0,25.94-1.84,32-20,32a12,12,0,0,0,0,24c19.14,0,32.2-6.9,38.8-20.51C220,196.76,220,184.17,220,172c0-25.94,1.84-32,20-32a12,12,0,0,0,0-24Z"),St=C("M140,80v41.21l34.17,20.5a12,12,0,1,1-12.34,20.58l-40-24A12,12,0,0,1,116,128V80a12,12,0,0,1,24,0ZM128,28A99.38,99.38,0,0,0,57.24,57.34c-4.69,4.74-9,9.37-13.24,14V64a12,12,0,0,0-24,0v40a12,12,0,0,0,12,12H72a12,12,0,0,0,0-24H57.77C63,86,68.37,80.22,74.26,74.26a76,76,0,1,1,1.58,109,12,12,0,0,0-16.48,17.46A100,100,0,1,0,128,28Z"),_t=C("M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z"),be=C("M71.68,97.22,34.74,128l36.94,30.78a12,12,0,1,1-15.36,18.44l-48-40a12,12,0,0,1,0-18.44l48-40A12,12,0,0,1,71.68,97.22Zm176,21.56-48-40a12,12,0,1,0-15.36,18.44L221.26,128l-36.94,30.78a12,12,0,1,0,15.36,18.44l48-40a12,12,0,0,0,0-18.44ZM164.1,28.72a12,12,0,0,0-15.38,7.18l-64,176a12,12,0,0,0,7.18,15.37A11.79,11.79,0,0,0,96,228a12,12,0,0,0,11.28-7.9l64-176A12,12,0,0,0,164.1,28.72Z"),ne=C("M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"),Rt=C("M219.71,117.38a12,12,0,0,0-7.25-8.52L161.28,88.39l10.59-70.61a12,12,0,0,0-20.64-10l-112,120a12,12,0,0,0,4.31,19.33l51.18,20.47L84.13,238.22a12,12,0,0,0,20.64,10l112-120A12,12,0,0,0,219.71,117.38ZM113.6,203.55l6.27-41.77a12,12,0,0,0-7.41-12.92L68.74,131.37,142.4,52.45l-6.27,41.77a12,12,0,0,0,7.41,12.92l43.72,17.49Z"),ve=C("M230.14,70.54,185.46,25.85a20,20,0,0,0-28.29,0L33.86,149.17A19.85,19.85,0,0,0,28,163.31V208a20,20,0,0,0,20,20H92.69a19.86,19.86,0,0,0,14.14-5.86L230.14,98.82a20,20,0,0,0,0-28.28ZM91,204H52V165l84-84,39,39ZM192,103,153,64l18.34-18.34,39,39Z"),At=C("M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM32,80H88v40H32Zm72,0H224v40H104ZM32,136H88v40H32Zm72,0H224v40H104Z"),Ce=C("M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z");var Ge="crev-quick-inspector",m=null,Te=null;function xe(e,t,n,r,o){if(R(),Te=t.rid,m=document.createElement("div"),m.id=Ge,t.type){let a=document.createElement("span");a.className="crev-qi-badge",a.textContent=t.type,m.appendChild(a)}if(t.name){let a=document.createElement("div");a.className="crev-qi-name",a.textContent=t.name,m.appendChild(a)}if(t.businessId){let a=document.createElement("div");a.className="crev-qi-row",a.textContent=`ID: ${t.businessId}`,m.appendChild(a)}if(t.templateBusinessId){let a=document.createElement("div");a.className="crev-qi-row crev-qi-template",a.textContent=`Template: ${t.templateBusinessId}`,m.appendChild(a)}let c=document.createElement("div");if(c.className="crev-qi-row crev-qi-rid",c.textContent=`RID: ${t.rid}`,m.appendChild(c),t.codePreview){let a=document.createElement("div");a.className="crev-qi-code",a.textContent=t.codePreview,m.appendChild(a)}let p=document.createElement("button");p.className=`crev-qi-star${t.isFavorite?" active":""}`,p.textContent=t.isFavorite?"\u2605":"\u2606",p.title=t.isFavorite?"Remove from pinned":"Pin this object",p.setAttribute("aria-label",p.title),p.addEventListener("click",a=>{a.stopPropagation(),r?.(t.rid);let g=p.classList.toggle("active");p.textContent=g?"\u2605":"\u2606",p.title=g?"Remove from pinned":"Pin this object",p.setAttribute("aria-label",p.title)}),m.appendChild(p);let E=document.createElement("div");E.className="crev-qi-actions";let s=document.createElement("button");s.className="crev-qi-btn",s.textContent="Copy RID",s.addEventListener("click",a=>{a.stopPropagation(),navigator.clipboard.writeText(t.rid).then(()=>{s.innerHTML=ne,setTimeout(()=>{s.textContent="Copy RID"},600)}).catch(()=>{})});let l=document.createElement("button");l.className="crev-qi-btn",l.textContent="Copy ID",l.title=ye,l.addEventListener("click",a=>{a.stopPropagation();let{text:g,label:b}=G({rid:t.rid,businessId:t.businessId,type:t.type,templateBusinessId:t.templateBusinessId},j(a));navigator.clipboard.writeText(g).then(()=>{l.innerHTML=`${ne} ${b}`,setTimeout(()=>{l.textContent="Copy ID"},600)}).catch(()=>{})});let u=document.createElement("button");u.className="crev-qi-btn crev-qi-btn--accent",u.innerHTML=`${ve} Editor`,u.addEventListener("click",a=>{a.stopPropagation(),n(t.rid),R()});let f=document.createElement("button");f.className="crev-qi-btn",f.innerHTML=`${Ce} Full View`,f.addEventListener("click",a=>{a.stopPropagation(),o?.(t.rid),R()}),E.appendChild(s),E.appendChild(l),E.appendChild(u),E.appendChild(f),m.appendChild(E),document.body.appendChild(m),je(e)}function je(e){if(!m)return;m.style.top="-9999px",m.style.left="-9999px",m.style.display="block";let t=e.getBoundingClientRect(),n=m.getBoundingClientRect(),r=6,o=t.bottom+r,c=t.left;o+n.height>window.innerHeight-r&&(o=t.top-n.height-r),o<r&&(o=r),c+n.width>window.innerWidth-r&&(c=window.innerWidth-n.width-r),c<r&&(c=r),m.style.top=`${o}px`,m.style.left=`${c}px`}function R(){m?.remove(),m=null,Te=null}function re(){return m!=null}var oe=new Map;function U(e,t){try{localStorage.setItem(e,JSON.stringify({data:t,ts:Date.now()}))}catch{}}function F(e,t){let n=oe.get(e);n||(n=[],oe.set(e,n)),n.push(t)}window.addEventListener("storage",e=>{if(!e.key||!e.newValue)return;let t=oe.get(e.key);if(!(!t||t.length===0))try{let n=JSON.parse(e.newValue);for(let r of t)r(n.data)}catch{}});var Ie=`.crev-outline {
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
.crev-ec-btn {
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
.crev-ec-btn svg {
  width: 10px;
  height: 10px;
}
.crev-ec-btn:hover {
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
`;var W=class{inspectActive=!1;enrichMode="all";paintPhase="off";paintSourceName=null;styleInjected=!1;technicalOverlay=!1;fromSync=!1;prevConnDisplay=null;lastUrl=typeof window<"u"?window.location.href:"";lastDetection=null;enrichments=new Map;overlayProps=new Map;badgedElements=new WeakSet;requestedRids=new Set;discoveredRids=new Set;favoriteRids=new Set;observer=null;tooltipHideTimer=null;debounceTimer=null;labelClickTimer=null;hoveredOutlineEl=null;labelClickRid=null;resetOverlays(){this.badgedElements=new WeakSet,this.requestedRids.clear(),this.overlayProps.clear(),this.labelClickTimer&&(clearTimeout(this.labelClickTimer),this.labelClickTimer=null),this.labelClickRid=null,this.hoveredOutlineEl=null}resetDiscovery(){this.discoveredRids.clear()}resetAll(){this.inspectActive=!1,this.enrichMode="all",this.paintPhase="off",this.paintSourceName=null,this.styleInjected=!1,this.technicalOverlay=!1,this.fromSync=!1,this.prevConnDisplay=null,this.lastUrl=typeof window<"u"?window.location.href:"",this.lastDetection=null,this.enrichments.clear(),this.resetOverlays(),this.resetDiscovery(),this.favoriteRids.clear(),this.debounceTimer&&(clearTimeout(this.debounceTimer),this.debounceTimer=null),this.tooltipHideTimer&&(clearTimeout(this.tooltipHideTimer),this.tooltipHideTimer=null),this.observer?.disconnect(),this.observer=null}};var _e=["BarChart","PieChart","LineChart","AreaChart","WaterfallChart","BubbleChart","RadarChart","TreeChart","GanttChart","NetworkChart","PolarChart","BarLineChart"],$e="#33b1ff",Ze={BarChart:"BAR",PieChart:"PIE",LineChart:"LIN",AreaChart:"ARA",WaterfallChart:"WFL",BubbleChart:"BUB",RadarChart:"RDR",TreeChart:"TRE",GanttChart:"GNT",NetworkChart:"NET",PolarChart:"PLR",BarLineChart:"BLC"},Ke={Organisation:"#4589ff",Scorecard:"#08bdba",ExtendedTable:"#33b1ff",CustomVisualization:"#be95ff",DashboardFolder:"#ff7eb6",EditPage:"#42be65",StatusType:"#f1c21b",Strategy:"#78a9ff",Theme:"#08bdba",Perspective:"#82cfff",Objective:"#ff7eb6",Measure:"#42be65",Risk:"#fa4d56",Control:"#3ddbd9",Action:"#ff832b",...Object.fromEntries(_e.map(e=>[e,$e]))},Xe={Organisation:"ORG",Scorecard:"SC",ExtendedTable:"TBL",CustomVisualization:"CVO",DashboardFolder:"DSH",EditPage:"PG",StatusType:"ST",Strategy:"STR",Theme:"THM",Perspective:"PER",Objective:"OBJ",Measure:"MEA",Risk:"RSK",Control:"CTL",Action:"ACT",...Ze},Se="#707070";function Y(e){return e?Ke[e]??Se:Se}function M(e){return e?Xe[e]??e.substring(0,3).toUpperCase():"?"}var ze={ExtendedTable:["expression"],ExtendedMethodConfig:["expression"],...Object.fromEntries(_e.map(e=>[e,["expression"]])),CustomVisualization:["html","javascript"]},Re=new Set(Object.keys(ze));function Ae(e,t){if(!t.type||!Re.has(t.type))return null;let n=document.createElement("span");n.className="crev-actions";let r=document.createElement("button");return r.className="crev-ec-btn",r.innerHTML=be,r.title="Open in editor",r.setAttribute("aria-label","Open in editor"),r.addEventListener("click",o=>{o.preventDefault(),o.stopPropagation(),chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:e})}),n.appendChild(r),n}function P(e){for(let s of document.querySelectorAll(".crev-label"))(!s.parentElement||!document.body.contains(s.parentElement))&&s.remove();let t=e.enrichMode==="all",n=X(t),r=t?n.filter(({element:s})=>s.tagName==="A").length:0;y.debug("sync",`syncOverlays: ${n.length} elements (${r} links), enrichMode=${e.enrichMode}`);let o=[],c=n.filter(({element:s})=>!e.badgedElements.has(s));for(let{element:s,rid:l}of c){let u=e.enrichments.get(l),f=Y(u?.type);s.classList.add("crev-outline"),s.style.setProperty("--crev-color",f);let a=document.createElement("span");a.className="crev-label",u||a.classList.add("crev-label-loading"),a.setAttribute("data-crev-label",l);let g=document.createElement("span");if(g.className="crev-label-text",g.textContent=u?.businessId??u?.name??M(u?.type),g.title="Click: copy ID \xB7 Shift: template \xB7 Ctrl: reference \xB7 Double-click: inspect",a.appendChild(g),g.addEventListener("click",b=>{if(b.preventDefault(),b.stopPropagation(),e.paintPhase==="picking"){v({type:"PAINT_PICK",rid:l}),a.classList.add("crev-label-flash-pick"),setTimeout(()=>{a.classList.remove("crev-label-flash-pick")},400);return}if(e.paintPhase==="applying"){v({type:"PAINT_APPLY",rid:l});return}if(e.labelClickRid===l&&e.labelClickTimer){clearTimeout(e.labelClickTimer),e.labelClickTimer=null,e.labelClickRid=null,et(e,a,l);return}let q=j(b);e.labelClickRid=l,e.labelClickTimer=setTimeout(()=>{e.labelClickTimer=null,e.labelClickRid=null;let N=e.enrichments.get(l),{text:A,label:S}=G({rid:l,...N},q);if(!A){let k=g.textContent;g.textContent=S,a.style.opacity="0.5",setTimeout(()=>{g.textContent=k,a.style.opacity=""},800);return}let O=S==="ID"?"\u2713":`\u2713 ${S}`;navigator.clipboard.writeText(A).then(()=>{let k=g.textContent;g.textContent=O,a.classList.add("crev-label-flash-ok"),setTimeout(()=>{g.textContent=k,a.classList.remove("crev-label-flash-ok")},600)}).catch(k=>y.swallow("content:clipboard",k))},250)}),s.appendChild(a),u){let b=Ae(l,u);b&&s.appendChild(b)}e.badgedElements.add(s),!e.enrichments.has(l)&&!e.requestedRids.has(l)&&(o.push(l),e.requestedRids.add(l))}for(let{rid:s}of n)!e.enrichments.has(s)&&!e.requestedRids.has(s)&&(o.push(s),e.requestedRids.add(s));o.length>0&&(y.debug("sync",`ENRICH_BADGES: sending ${o.length} RIDs`,o),v({type:"ENRICH_BADGES",rids:o}));let p=Date.now(),E=[];for(let{rid:s}of n)!e.discoveredRids.has(s)&&e.discoveredRids.size<5e3&&(e.discoveredRids.add(s),E.push({rid:s,source:"dom",discoveredAt:p,updatedAt:p}));E.length>0&&v({type:"OBJECTS_DISCOVERED",objects:E})}function $(e){for(let n of document.querySelectorAll(".crev-label"))n.remove();for(let n of document.querySelectorAll(".crev-actions"))n.remove();for(let n of document.querySelectorAll(".crev-outline"))n.classList.remove("crev-outline"),n.style.removeProperty("--crev-color");let t=document.getElementById("crev-tooltip");t&&(t.style.display="none"),e.hoveredOutlineEl=null,e.badgedElements=new WeakSet,e.overlayProps.clear()}function Oe(e){for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");if(!n)continue;let r=e.enrichments.get(n);if(r){let o=t.querySelector(".crev-label-text");o&&(o.textContent=r.businessId??r.name??M(r.type)),t.classList.remove("crev-label-loading");let c=t.parentElement;if(c){let p=Y(r.type);c.style.setProperty("--crev-color",p)}if(c&&!c.querySelector(".crev-actions")){let p=Ae(n,r);p&&c.appendChild(p)}}}}function et(e,t,n){let r=e.enrichments.get(n),o=!1,c=!1,p,E=()=>{!o||!c||xe(t,{rid:n,businessId:r?.businessId,templateBusinessId:r?.templateBusinessId,type:r?.type,name:r?.name,isFavorite:e.favoriteRids.has(n),codePreview:p},s=>{chrome.runtime.sendMessage({type:"OPEN_EDITOR",rid:s})},s=>{chrome.runtime.sendMessage({type:"TOGGLE_FAVORITE",rid:s,name:r?.name,objectType:r?.type,businessId:r?.businessId}),e.favoriteRids.has(s)?e.favoriteRids.delete(s):e.favoriteRids.add(s)},s=>{chrome.runtime.sendMessage({type:"OPEN_OBJECT_VIEW",rid:s})})};chrome.runtime.sendMessage({type:"GET_FAVORITES"},s=>{s?.entries&&(e.favoriteRids=new Set(s.entries.map(l=>l.rid))),o=!0,E()}),chrome.runtime.sendMessage({type:"HOVER_LOOKUP",rid:n},s=>{s?.codePreview&&(p=s.codePreview.split(`
`).slice(0,2).join(`
`)),c=!0,E()})}function ie(e,...t){let n=document.getElementById("crev-paint-banner"),r=document.getElementById("crev-paint-text");if(!(!n||!r)){if(e.paintPhase==="off"){n.style.display="none";return}if(n.style.display="block",n.style.background="#ff832b",t.length>0){x(r,...t);return}e.paintPhase==="picking"?x(r,"Paint Format \u2014 ",h("b",null,"click a widget to pick its style")):x(r,"Paint Format from ",h("b",null,e.paintSourceName??"?")," \u2014 click widgets to apply")}}function se(e){let t=e.paintPhase!=="off"?"crosshair":"pointer";for(let n of document.querySelectorAll(".crev-label-text"))n.style.cursor=t;ie(e)}function Le(e,t,n){let r=document.querySelector(`[data-crev-label="${e}"]`);if(r){let o=t?"crev-label-flash-ok":"crev-label-flash-error";r.classList.add(o),setTimeout(()=>{r.classList.remove(o)},600)}if(t)I("Applied \u2014 refresh page to see changes","success");else{let o=n==="No source selected"?"Not connected \u2014 add a server in Connect tab":`Paint error: ${n??"unknown"}`;I(o,"error")}}function we(e,t,n){let r=document.getElementById("crev-paint-text");if(r){if(n.length===0){x(r,"No style differences \u2014 already identical"),setTimeout(()=>ie(e),2e3);return}x(r,h("div",{style:"margin-bottom:3px"},"Style changes:"),...n.map(o=>h("div",{style:"font-size:10px;font-family:monospace;margin:1px 0"},h("b",null,o.prop),": ",o.from," \u2192 ",o.to)),h("div",{style:"margin-top:4px"},h("button",{class:"crev-paint-apply-btn",onClick:()=>{v({type:"PAINT_CONFIRM",rid:t}),x(r,"Applying\u2026")}},"Apply"),h("button",{class:"crev-paint-cancel-btn",onClick:()=>ie(e)},"Cancel")))}}var tt=new Set(["rid","id","name","type","__typename","typename","source","discoveredAt","updatedAt","treePath","webParentRid","hasChildren"]),nt=new Set(["expression","html","javascript"]),rt=6;function Me(e,t,n){e.tooltipHideTimer&&(clearTimeout(e.tooltipHideTimer),e.tooltipHideTimer=null);let r=document.getElementById("crev-tooltip");if(!r)return;let o=e.enrichments.get(n),c=Y(o?.type),p=M(o?.type),E=o?.type??(e.requestedRids.has(n)?"Loading\u2026":"Unknown");x(r,h("div",{class:"crev-tt-type",style:`--type-color:${c}`},p)," ",h("span",{class:"crev-tt-typename"},E),o?.name&&h("div",{class:"crev-tt-name"},o.name),o?.businessId&&h("div",{class:"crev-tt-row"},`ID: ${o.businessId}`),h("div",{class:"crev-tt-row"},`RID: ${n}`)),r.style.top="-9999px",r.style.left="-9999px",r.style.display="block";let s=t.getBoundingClientRect(),l=r.getBoundingClientRect(),u=s.bottom+4,f=s.left;u+l.height>window.innerHeight&&(u=s.top-l.height-4),u<4&&(u=4),f+l.width>window.innerWidth&&(f=window.innerWidth-l.width-4),f<0&&(f=4),r.style.top=`${u}px`,r.style.left=`${f}px`}function Pe(e){e.tooltipHideTimer&&clearTimeout(e.tooltipHideTimer),e.tooltipHideTimer=setTimeout(()=>{let t=document.getElementById("crev-tooltip");t&&(t.style.display="none"),e.tooltipHideTimer=null},50)}function K(e){if(e.technicalOverlay){let t=[];for(let n of document.querySelectorAll("[data-crev-label]")){let r=n.getAttribute("data-crev-label");r&&!e.overlayProps.has(r)&&t.push(r)}if(t.length>0)try{chrome.runtime.sendMessage({type:"GET_OVERLAY_PROPS",rids:t},n=>{if(!chrome.runtime.lastError&&n?.type==="OVERLAY_PROPS_DATA"&&n.props){for(let[r,o]of Object.entries(n.props))e.overlayProps.set(r,o);Z(e)}})}catch{}}Z(e)}function Z(e){for(let t of document.querySelectorAll("[data-crev-label]")){let n=t.getAttribute("data-crev-label");if(!n)continue;let r=e.enrichments.get(n),o=t.querySelector(".crev-label-text");if(o)if(e.technicalOverlay){t.classList.add("crev-label--card");let c=r?.type??"Unknown",p=r?.businessId??"",E=r?.name??"unnamed",s=n.length>12?n.slice(0,6)+"\u2026"+n.slice(-4):n;o.innerHTML="";let l=document.createElement("span");l.className="crev-card-line crev-card-type",l.textContent=p?`${c} | ${p}`:c;let u=document.createElement("span");u.className="crev-card-line",u.textContent=E;let f=document.createElement("span");f.className="crev-card-line crev-card-rid",f.textContent=s,o.appendChild(l),o.appendChild(u),o.appendChild(f);let a=e.overlayProps.get(n);if(a){let g=Object.entries(a).filter(([b])=>!tt.has(b));if(g.length>0){let b=document.createElement("span");b.className="crev-card-sep",o.appendChild(b);let q=0;for(let[N,A]of g){if(q>=rt)break;let S=document.createElement("span");if(S.className="crev-card-line crev-card-prop",nt.has(N)){let O=A.split(`
`).length;S.textContent=`${N}: ${O} line${O!==1?"s":""}`}else{let O=A.length>30?A.slice(0,27)+"\u2026":A;S.textContent=`${N}: ${O}`}o.appendChild(S),q++}}}}else t.classList.remove("crev-label--card"),o.innerHTML="",o.textContent=r?.businessId??r?.name??M(r?.type)}}function Ne(e,t){e.observer||(e.observer=new MutationObserver(n=>{n.every(o=>o.type!=="childList"||o.removedNodes.length>0?!1:Array.from(o.addedNodes).every(c=>c instanceof HTMLElement&&(c.classList.contains("crev-label")||c.id==="crev-tooltip")))||(window.location.href!==e.lastUrl&&(e.lastUrl=window.location.href,e.resetOverlays(),e.resetDiscovery(),t()),e.inspectActive&&(e.debounceTimer&&clearTimeout(e.debounceTimer),e.debounceTimer=setTimeout(()=>P(e),150)))}),e.observer.observe(document.body,{childList:!0,subtree:!0}),window.__crev_observer=e.observer)}var i=new W;function ae(e){i.inspectActive=e,e?(it(),P(i)):(i.debounceTimer&&(clearTimeout(i.debounceTimer),i.debounceTimer=null),$(i),i.requestedRids.clear(),R())}function it(){if(i.styleInjected)return;let e=document.createElement("style");e.id="crev-inspector-styles",e.textContent=Ie,document.head.appendChild(e);let t=document.createElement("div");t.id="crev-tooltip",document.body.appendChild(t),document.body.addEventListener("mouseover",r=>{if(!i.inspectActive)return;let o=r.target.closest?.(".crev-outline");if(o!==i.hoveredOutlineEl)if(i.hoveredOutlineEl=o,o){let p=o.querySelector("[data-crev-label]")?.getAttribute("data-crev-label");p&&Me(i,o,p)}else Pe(i)});let n=h("div",{id:"crev-paint-banner"},h("span",{id:"crev-paint-text"},"Paint Format"),h("button",{class:"crev-paint-close",id:"crev-paint-close","aria-label":"Close paint mode",onClick:()=>v({type:"TOGGLE_PAINT"})},"\u2715"));document.body.appendChild(n),i.styleInjected=!0}function st(e){let t=i.prevConnDisplay;i.prevConnDisplay=e.display;let n=e.display==="connected"?"connected":e.display==="not-configured"?"not-configured":"disconnected",r=e.profileLabel??"CREV";i.lastDetection?.isBmp&&fe(r,n),t!==null&&t!==e.display&&(e.display==="connected"&&t!=="connected"?I(`Connected to ${e.profileLabel??"server"}`,"success"):e.display==="auth-failed"&&t!=="auth-failed"?I("Auth failed","error"):e.display==="unreachable"&&t!=="unreachable"?I("Server unreachable","error"):e.display==="server-down"&&t!=="server-down"&&I("Server down","error"))}function at(e){I(`Switched to ${e}`,"info"),i.overlayProps.clear(),Z(i),i.technicalOverlay&&K(i),i.lastDetection?.isBmp&&B(e,"connected")}function ke(){let e=z();i.lastDetection=e,v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp}),document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"CHECK_BMP_SIGNALS"}}))}function ct(){let e=ce(),t=i.lastDetection??z(),n=t.isBmp?le():[];return t.isBmp&&document.dispatchEvent(new CustomEvent("crev-content",{detail:{type:"EXTRACT_FIBERS"}})),{url:window.location.href,rid:e.rid,tabRid:e.tabRid,widgets:n,detection:{confidence:t.confidence,signals:t.signals,isBmp:t.isBmp}}}ue(e=>{switch(e.type){case"INSPECT_STATE":ae(e.active),i.fromSync||U("crev_sync_inspect",{active:e.active});break;case"BADGE_ENRICHMENT":for(let[t,n]of Object.entries(e.enrichments))i.enrichments.set(t,n);i.inspectActive&&Oe(i);break;case"PAINT_STATE":i.paintPhase=e.phase,i.paintSourceName=e.sourceName??null,se(i),i.fromSync||U("crev_sync_paint",{phase:e.phase,sourceName:e.sourceName});break;case"PAINT_PREVIEW":we(i,e.rid,e.diff);break;case"PAINT_APPLY_RESULT":Le(e.rid,e.ok,e.error);break;case"ENRICH_MODE":e.mode!==i.enrichMode&&(i.enrichMode=e.mode,i.inspectActive&&(i.requestedRids.clear(),$(i),P(i)));break;case"RE_ENRICH":i.requestedRids.clear(),i.inspectActive&&P(i);break;case"CONNECTION_STATE":st(e.state);break;case"PROFILE_SWITCHED":at(e.label),i.fromSync||U("crev_sync_profile",{label:e.label});break;case"TECHNICAL_OVERLAY_STATE":i.technicalOverlay=e.active,K(i),i.fromSync||U("crev_sync_overlay",{active:e.active});break}});ge(()=>{if(i.requestedRids.clear(),i.lastDetection){let e=i.lastDetection;queueMicrotask(()=>{v({type:"DETECTION_RESULT",confidence:e.confidence,signals:e.signals,isBmp:e.isBmp})})}});F("crev_sync_inspect",e=>{let t=e;if(t.active!==i.inspectActive){i.fromSync=!0;try{ae(t.active)}finally{i.fromSync=!1}}});F("crev_sync_paint",e=>{let t=e;i.fromSync=!0;try{i.paintPhase=t.phase,i.paintSourceName=t.sourceName??null,se(i)}finally{i.fromSync=!1}});F("crev_sync_overlay",e=>{let t=e;if(t.active!==i.technicalOverlay){i.fromSync=!0;try{i.technicalOverlay=t.active,K(i)}finally{i.fromSync=!1}}});F("crev_sync_profile",e=>{let t=e;i.fromSync=!0,i.lastDetection?.isBmp&&B(t.label,t.connected!==!1?"connected":"disconnected"),i.fromSync=!1});document.body.addEventListener("contextmenu",e=>{let t=e.target.closest?.("[data-rid]");if(t){let n=t.getAttribute("data-rid");if(n){let r=i.enrichments.get(n);try{chrome.runtime.sendMessage({type:"SET_CONTEXT_RID",rid:n,name:r?.name,objectType:r?.type,businessId:r?.businessId})}catch(o){y.swallow("content:contextmenu",o)}}}},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&re()&&R()});document.addEventListener("click",e=>{!re()||e.target.closest("#crev-quick-inspector")||R()},!0);document.addEventListener("crev-interceptor",(e=>{let t=e.detail;if(t.type==="OBJECTS_DISCOVERED"&&v(t),t.type==="BMP_SIGNALS_RESULT"){let n=t.signals??[];if(i.lastDetection&&n.length>0){let r=[...i.lastDetection.signals,...n],o=n.length*.15,c=Math.min(1,i.lastDetection.confidence+o),p=c>=.5;v({type:"DETECTION_RESULT",confidence:c,signals:r,isBmp:p})}}}));chrome.runtime.onMessage.addListener((e,t,n)=>{if(e.type==="INSPECT_STATE")return ae(e.active),!1;if(e.type==="GET_PAGE_INFO"){let r=ct();return n({type:"PAGE_INFO",...r}),!0}return e.type==="COPY_TO_CLIPBOARD"&&navigator.clipboard.writeText(e.text).catch(r=>y.swallow("content:clipboardWrite",r)),!1});function lt(){i.observer?.disconnect(),$(i),R(),me(),document.getElementById("crev-inspector-styles")?.remove(),document.getElementById("crev-tooltip")?.remove(),document.getElementById("crev-paint-banner")?.remove(),document.getElementById("crev-toast-container")?.remove(),i.styleInjected=!1}window.__crev_content_loaded&&lt();window.__crev_content_loaded=!0;try{ee()}catch(e){y.swallow("content:init:port",e)}try{ke()}catch(e){y.swallow("content:init:detection",e)}try{Ne(i,ke)}catch(e){y.swallow("content:init:observer",e)}})();
