/**
 * Blueprint-mode design overlay — PROFESSIONAL build (palette v2 + tooltip + reflow).
 *
 * Renders an editable architectural-blueprint overlay ON TOP of the live BMP render,
 * pixel-aligned to the real widgets (verified: 0px delta at 1480px AND 1180px). Inject via
 * DevTools/evaluate_script on the Risk Register tab of scorecard 4957, or adapt for the
 * extension (model from FETCH_LAYOUT_TREE; DOM→object mapping by rid, not name).
 *
 * Verified behaviours:
 *  - ALIGNMENT: anchor every child to document.body.getBoundingClientRect() (absorbs body
 *    margin; equals document coords at any scroll). NEVER measure during a forced relayout
 *    (a full-page screenshot resizes the viewport → reflow → stale overlay).
 *  - REFLOW: a ResizeObserver(documentElement) + window 'resize' listener re-render on any
 *    viewport change — opening the CREV side panel shrinks the window; this tracks it. rAF +
 *    busy guard prevents the RO self-trigger loop.
 *  - TOOLTIP: hovering a plate/container/zone shows IDs · container · tab · tabset · width.
 *    Plates take pointer-events in blueprint mode (you're editing, not using the page).
 *
 * Palette v2 (no green): navy scrim, azure widgets, indigo charts, CREV-purple scope/containers,
 * amber shared, cyan available. SVG dimension lines (width N/6; charts also a vertical px line),
 * SVG chevron resize handles, SVG add glyph — no emoji.
 *
 * NOTE: model + ids below are hard-coded for the demo Risk Register tab. In the extension these
 * come from the layout fetch; the render()/wire()/reflow() machinery is the reusable part.
 */
export function renderBlueprintOverlay() {
  const C = { bg:'#0B2138', guide:'rgba(120,170,215,0.22)', widget:'#82B4DE', chart:'#93A7E6',
              local:'#9D7BFF', shared:'#E0A85A', avail:'#46C9D6', ink:'#EAF2FB', dim:'#9CC0DD' };
  const isChart = t => /Chart$/.test(t);
  const SVGNS='http://www.w3.org/2000/svg';
  const s=(t,a)=>{const e=document.createElementNS(SVGNS,t);for(const k in a)e.setAttribute(k,a[k]);return e;};
  const SC={id:'4957',rid:'451704949656267090'}, TAB={id:'4904',name:'Risk Register',rid:'7538488125611321093'}, TABSET={id:'crev_demo_tabset',name:'CREV Demo Tabs',pages:1};
  const rows=[
    {emptyL:2,items:[
      {kind:'container',name:'KPIs',id:'cont_crev_demo_enterprise_14',L:2,scope:'local',parent:TAB.id,children:[
        {name:'Control Health',type:'FunctionStatus',id:'4965',L:6,cont:'cont_crev_demo_enterprise_14'},
        {name:'Risk Appetite',type:'Status',id:'4966',L:6,cont:'cont_crev_demo_enterprise_14'}]},
      {kind:'container',name:'Side Panel',id:'cont_crev_demo_enterprise_18',nested:'Detail',nestedId:'cont_crev_demo_enterprise_19',L:2,scope:'local',parent:TAB.id,children:[
        {name:'By Owner',type:'PieChart',id:'4968',L:6,cont:'cont_crev_demo_enterprise_19'},
        {name:'Notes',type:'TextElement',id:'4969',L:6,cont:'cont_crev_demo_enterprise_19'}]},
    ]},
    {emptyL:2,items:[{kind:'widget',name:'Register',type:'RiskList',id:'4964',L:4,cont:TAB.id}]},
    {emptyL:2,items:[{kind:'widget',name:'Trend vs Target',type:'BarLineChart',id:'4967',L:4,cont:TAB.id}]},
  ];

  let tip=document.getElementById('crev-bp-tip');
  if(!tip){tip=document.createElement('div');tip.id='crev-bp-tip';document.body.appendChild(tip);}
  tip.style.cssText=`position:fixed;z-index:2147483600;pointer-events:none;display:none;background:${C.bg};border:1px solid ${C.widget}66;border-radius:6px;padding:9px 11px;font:11px/1.55 Inter,system-ui,sans-serif;color:${C.ink};box-shadow:0 8px 28px rgba(0,0,0,.45);min-width:200px`;
  const kv=(k,v,c)=>`<div style="display:flex;gap:10px"><span style="color:${C.dim};min-width:74px;font-size:10px;letter-spacing:.04em;text-transform:uppercase">${k}</span><span style="color:${c||C.ink};font-family:'JetBrains Mono',monospace">${v}</span></div>`;
  const tipWidget=o=>`<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:${isChart(o.type)?C.chart:C.widget}">${o.name}</div>`+kv('type',o.type)+kv('id',o.id)+kv('container',o.cont)+kv('tab',`${TAB.name} · ${TAB.id}`)+kv('tabset',`${TABSET.name} · ${TABSET.id}`)+kv('width',`${o.L}/6`);
  const tipCont=o=>`<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:${C.local}">${o.name} <span style="font-weight:500;color:${C.dim};font-size:10px">CONTAINER</span></div>`+kv('id',o.id)+(o.nested?kv('nested',`${o.nested} · ${o.nestedId}`):'')+kv('parent',`Tab ${TAB.name} · ${o.parent}`)+kv('scope',`${o.scope} · dedicated tabset (${TABSET.pages} page)`,C.local)+kv('width',`${o.L}/6`);
  const tipAvail=e=>`<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:${C.avail}">Available space</div>`+kv('free',`${e.emptyL}/6 columns`,C.avail)+kv('in tab',`${TAB.name} · ${TAB.id}`)+kv('on add',`binds to tab ${TAB.id}`);
  const wire=(el,html)=>{el.style.pointerEvents='auto';
    el.addEventListener('mouseenter',()=>{tip.innerHTML=html;tip.style.display='block';});
    el.addEventListener('mousemove',ev=>{let x=ev.clientX+16,y=ev.clientY+16;const r=tip.getBoundingClientRect();if(x+r.width>innerWidth-8)x=ev.clientX-r.width-16;if(y+r.height>innerHeight-8)y=ev.clientY-r.height-16;tip.style.left=x+'px';tip.style.top=y+'px';});
    el.addEventListener('mouseleave',()=>{tip.style.display='none';});};

  function render(){
    document.getElementById('crev-bp-overlay')?.remove();
    const base=document.body.getBoundingClientRect();
    const rectOf=n=>{const el=[...document.querySelectorAll('[data-test]')].find(e=>(e.getAttribute('data-test')||'').replace(/^widget-(container-body-)?/,'')===n);if(!el)return null;const r=el.getBoundingClientRect();return{left:r.left-base.left,top:r.top-base.top,right:r.right-base.left,bottom:r.bottom-base.top};};
    const uni=rs=>({left:Math.min(...rs.map(r=>r.left)),top:Math.min(...rs.map(r=>r.top)),right:Math.max(...rs.map(r=>r.right)),bottom:Math.max(...rs.map(r=>r.bottom))});
    const all=[];rows.forEach(r=>r.items.forEach(it=>{(it.kind==='container'?it.children:[it]).forEach(c=>{const x=rectOf(c.name);if(x)all.push(x);});}));
    if(!all.length)return;
    const leftX=Math.min(...all.map(r=>r.left)),topY=Math.min(...all.map(r=>r.top)),botY=Math.max(...all.map(r=>r.bottom));
    let unit=231,gap=16;for(const r of rows)for(const it of r.items){const rs=(it.kind==='container'?it.children.map(c=>rectOf(c.name)):[rectOf(it.name)]).filter(Boolean);if(rs.length){const b=uni(rs);unit=((b.right-b.left)-(it.L/2-1)*gap)/it.L;break;}}
    const root=document.createElement('div');root.id='crev-bp-overlay';root.style.cssText=`position:absolute;left:0;top:0;width:${document.documentElement.scrollWidth}px;height:${document.documentElement.scrollHeight}px;z-index:2147483000;pointer-events:none;font-family:Inter,system-ui,sans-serif`;
    const E=(css,html)=>{const d=document.createElement('div');d.style.cssText=css;if(html)d.innerHTML=html;root.appendChild(d);return d;};
    E(`position:absolute;inset:0;background:${C.bg};opacity:.82;mix-blend-mode:multiply`);
    E(`position:absolute;left:0;top:${topY-30}px;width:100%;height:${botY-topY+60}px;background:repeating-linear-gradient(0deg,transparent 0 31px,rgba(140,185,225,.05) 31px 32px),repeating-linear-gradient(90deg,transparent 0 31px,rgba(140,185,225,.05) 31px 32px)`);
    for(let i=0;i<=6;i++){const x=leftX+i*(unit+gap)-(i>0?gap/2:0);E(`position:absolute;left:${x}px;top:${topY-34}px;width:1px;height:${botY-topY+64}px;border-left:1px dashed ${C.guide}`);}
    for(let i=0;i<6;i++){const x=leftX+i*(unit+gap);E(`position:absolute;left:${x}px;top:${topY-28}px;width:${unit}px;text-align:center;color:${C.dim};font-size:9px;letter-spacing:.18em;opacity:.7`,`COL ${i+1}`);}
    const ban=E(`position:fixed;top:62px;right:18px;display:flex;align-items:center;gap:8px;background:${C.bg};color:${C.ink};border:1px solid ${C.local}66;padding:6px 13px;border-radius:4px;font-size:11px;letter-spacing:.16em;font-weight:600`,`BLUEPRINT`);
    const bsvg=s('svg',{width:14,height:14,viewBox:'0 0 14 14'});bsvg.appendChild(s('rect',{x:1,y:1,width:12,height:12,rx:1,fill:'none',stroke:C.local,'stroke-width':1}));[3,7,11].forEach(x=>bsvg.appendChild(s('line',{x1:x,y1:1,x2:x,y2:4,stroke:C.local,'stroke-width':1})));ban.prepend(bsvg);
    const hDim=(w,label,color)=>{const c=document.createElement('div');c.style.cssText=`position:absolute;top:-8px;left:0;width:${w}px;height:16px`;const svg=s('svg',{width:w,height:16});svg.style.cssText='position:absolute;inset:0';svg.appendChild(s('line',{x1:3,y1:8,x2:w-3,y2:8,stroke:color,'stroke-width':1,opacity:.85}));svg.appendChild(s('path',{d:`M3,8 l7,-3.2 v6.4 z`,fill:color}));svg.appendChild(s('path',{d:`M${w-3},8 l-7,-3.2 v6.4 z`,fill:color}));c.appendChild(svg);const lab=document.createElement('div');lab.textContent=label;lab.style.cssText=`position:absolute;left:50%;top:0;transform:translateX(-50%);background:${C.bg};color:${color};font-size:9.5px;letter-spacing:.08em;padding:0 6px;font-weight:600`;c.appendChild(lab);return c;};
    const vDim=(h,label,color)=>{const c=document.createElement('div');c.style.cssText=`position:absolute;top:0;right:-9px;transform:translateX(100%);width:46px;height:${h}px`;const svg=s('svg',{width:10,height:h});svg.style.cssText='position:absolute;left:0;top:0';svg.appendChild(s('line',{x1:5,y1:3,x2:5,y2:h-3,stroke:color,'stroke-width':1,opacity:.85}));svg.appendChild(s('path',{d:`M5,3 l-3.2,7 h6.4 z`,fill:color}));svg.appendChild(s('path',{d:`M5,${h-3} l-3.2,-7 h6.4 z`,fill:color}));c.appendChild(svg);const lab=document.createElement('div');lab.textContent=label;lab.style.cssText=`position:absolute;left:12px;top:50%;transform:translateY(-50%);background:${C.bg};color:${color};font-size:9.5px;padding:1px 4px;white-space:nowrap`;c.appendChild(lab);return c;};
    const handle=(dir,color)=>{const c=document.createElement('div');const w=dir==='h'?9:24,h=dir==='h'?24:9;c.style.cssText=`position:absolute;${dir==='h'?`right:-5px;top:calc(50% - 12px)`:`bottom:-5px;left:calc(50% - 12px)`};width:${w}px;height:${h}px;background:${C.bg};border:1px solid ${color};border-radius:2px`;const svg=s('svg',{width:w,height:h,viewBox:`0 0 ${w} ${h}`});const cx=w/2,cy=h/2;const ch=d=>svg.appendChild(s('path',{d,fill:'none',stroke:color,'stroke-width':1.3,'stroke-linecap':'round','stroke-linejoin':'round'}));if(dir==='h'){ch(`M${cx-1.5},${cy-4} l-2,4 l2,4`);ch(`M${cx+1.5},${cy-4} l2,4 l-2,4`);}else{ch(`M${cx-4},${cy-1.5} l4,-2 l4,2`);ch(`M${cx-4},${cy+1.5} l4,2 l4,-2`);}c.appendChild(svg);return c;};
    const plate=(r,color,o)=>{const w=r.right-r.left,h=r.bottom-r.top;const d=E(`position:absolute;left:${r.left}px;top:${r.top}px;width:${w}px;height:${h}px;box-sizing:border-box;border:1.5px solid ${color};background:${color}10;border-radius:3px;box-shadow:inset 0 0 22px ${color}14;cursor:pointer`);d.innerHTML=`<div style="position:absolute;top:8px;left:10px;font-size:12px;font-weight:600;color:${C.ink}">${o.name}<span style="font-weight:400;color:${color};opacity:.85;margin-left:7px;font-size:10.5px;letter-spacing:.04em">${(o.type||'').toUpperCase()}</span></div>`;d.appendChild(hDim(w,`${o.L} / 6`,C.dim));d.appendChild(handle('h',color));if(isChart(o.type)){d.appendChild(handle('v',color));d.appendChild(vDim(h,`${Math.round(h)} px`,color));}wire(d,tipWidget(o));return d;};
    for(const row of rows){const measured=[];
      for(const it of row.items){const got=(it.kind==='container'?it.children:[it]).map(c=>({c,r:rectOf(c.name)})).filter(x=>x.r);if(!got.length)continue;const b=uni(got.map(x=>x.r));measured.push(b);
        if(it.kind==='container'){const col=C[it.scope];const pad=it.nested?7:5;E(`position:absolute;left:${b.left-pad}px;top:${b.top-pad}px;width:${b.right-b.left+2*pad}px;height:${b.bottom-b.top+2*pad}px;box-sizing:border-box;border:1px dashed ${col}cc;border-radius:4px`);
          const tab=E(`position:absolute;left:${b.left-pad}px;top:${b.top-pad-19}px;background:${col};color:#0a0820;font-size:10px;font-weight:700;padding:2px 9px;border-radius:4px 4px 0 0;letter-spacing:.05em;cursor:pointer`,`${it.name.toUpperCase()}${it.nested?' › '+it.nested.toUpperCase():''}<span style="font-weight:600;opacity:.85;margin-left:6px">${it.L}/6 · ${it.scope}</span>`);wire(tab,tipCont(it));
          for(const {c,r} of got)plate(r,isChart(c.type)?C.chart:C.widget,c);
        } else plate(b,isChart(it.type)?C.chart:C.widget,it);
      }
      if(row.emptyL>0&&measured.length){const band=uni(measured);const rm=Math.max(...measured.map(m=>m.right));const ez={left:rm+gap,top:band.top,right:rm+gap+row.emptyL*unit+(row.emptyL-1)*gap,bottom:band.bottom};const w=ez.right-ez.left;
        const d=E(`position:absolute;left:${ez.left}px;top:${ez.top}px;width:${w}px;height:${ez.bottom-ez.top}px;box-sizing:border-box;border:1.5px dashed ${C.avail};border-radius:3px;background:repeating-linear-gradient(45deg,transparent 0 9px,${C.avail}1f 9px 10px);display:flex;align-items:center;justify-content:center;cursor:pointer`);
        const btn=document.createElement('div');btn.style.cssText=`display:flex;align-items:center;gap:7px;color:${C.avail};font-size:12px;font-weight:600`;const psvg=s('svg',{width:15,height:15,viewBox:'0 0 15 15'});psvg.appendChild(s('line',{x1:7.5,y1:3,x2:7.5,y2:12,stroke:C.avail,'stroke-width':1.5,'stroke-linecap':'round'}));psvg.appendChild(s('line',{x1:3,y1:7.5,x2:12,y2:7.5,stroke:C.avail,'stroke-width':1.5,'stroke-linecap':'round'}));btn.appendChild(psvg);const t=document.createElement('span');t.textContent='Add widget';btn.appendChild(t);d.appendChild(btn);d.appendChild(hDim(w,`${row.emptyL} / 6 available`,C.avail));wire(d,tipAvail(row));}
    }
    document.body.appendChild(root);
  }

  // Re-align on any viewport change (window resize OR CREV side panel open/close).
  if(window.__crevBPclean)window.__crevBPclean();
  let raf=0,busy=false;
  const reflow=()=>{if(busy)return;cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{busy=true;render();busy=false;});};
  window.addEventListener('resize',reflow);
  const ro=new ResizeObserver(reflow);ro.observe(document.documentElement);
  window.__crevBPclean=()=>{window.removeEventListener('resize',reflow);ro.disconnect();document.getElementById('crev-bp-overlay')?.remove();tip.remove();};
  render();
}
