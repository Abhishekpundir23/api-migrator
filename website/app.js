import replays from './replays.js';
const $ = (selector) => document.querySelector(selector);
let recipe = 'inngest';
let phase = 'before';
const labels = {
  inngest: {title: 'Inngest v3 to v4', caseName: 'PLINTH / API SOURCE', url: 'https://github.com/farulivan/plinth/pull/90/files', id: 'inngest-v3-to-v4'},
  knock: {title: 'Knock v0 to v1', caseName: 'KNOCK / EXAMPLE APPS', url: 'https://github.com/knocklabs/javascript/pull/558/files', id: 'knock-v0-to-v1'}
};
function selectGroup(attr, val) {
  document.querySelectorAll('[data-'+attr+']').forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === val)));
}
function renderReport() {
  const info = labels[recipe], result = replays[recipe][phase];
  selectGroup('recipe',recipe); selectGroup('state',phase);
  $('#case-name').textContent = info.caseName;
  $('#report-title').textContent = info.title;
  $('#evidence').href = info.url;
  const stats = [['Source files',result.sourceFiles],['Files with edits',result.wouldChangeFiles],['Review findings',result.findings.filter(x=>x.kind==='review').reduce((sum,x)=>sum+x.count,0)]];
  $('#metrics').replaceChildren(...stats.map(([text,count])=>{
    const div=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');div.className='metric';term.textContent=text;value.textContent=count;div.append(term,value);return div;
  }));
  $('#insight').textContent = result.note;
  $('#finding-list').replaceChildren(...result.highlights.map(([code,summary])=>{
    const row=document.createElement('div'),badge=document.createElement('b'),body=document.createElement('span');row.className='finding';badge.textContent=code;body.textContent=summary;row.append(badge,body);return row;
  }));
  $('#command').textContent=[
    'work=$(mktemp -d)',
    'tar -xzf sdk-assessment-0.1.1.tgz -C "$work"',
    'node "$work/package/sdk-assessment.cjs" assess '+String.fromCharCode(92),
    '  --recipe '+info.id+' '+String.fromCharCode(92),
    '  --repo /path/to/application '+String.fromCharCode(92),
    '  --out "$work/summary.json"'
  ].join('\n');
}
document.querySelectorAll('[data-recipe]').forEach(b=>b.addEventListener('click',()=>{recipe=b.dataset.recipe;renderReport()}));
document.querySelectorAll('[data-state]').forEach(b=>b.addEventListener('click',()=>{phase=b.dataset.state;renderReport()}));
$('#copy').addEventListener('click',async()=>{
  const b=$('#copy');try{await navigator.clipboard.writeText($('#command').textContent);b.textContent='Copied';}catch{const r=document.createRange();r.selectNodeContents($('#command'));const s=window.getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Commands selected';}setTimeout(()=>b.textContent='Copy commands',2000);
});
renderReport();

const descriptions=['JavaScript and TypeScript stay on the owner’s machine.','The scanner simulates the selected migration rules in memory.','Owners can share rule counts and keep file locations private.'];
const canvas=$('#layers');
let selected=2;
function drawLayers() {
  const rect=canvas.getBoundingClientRect(), w=rect.width,h=rect.height;
  if(!w||!h) return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);ctx.fillStyle='#102d25';ctx.fillRect(0,0,w,h);
  const scale=Math.min(w/510,(h-64)/290);
  ctx.translate(w*.50,h*.49-1);ctx.scale(scale,scale);
  function line(a,b,col,width=1){ctx.strokeStyle=col;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();}
  function poly(pts,fill,edge,width=1){ctx.beginPath();pts.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}if(edge){ctx.strokeStyle=edge;ctx.lineWidth=width;ctx.stroke();}}
  function p(x,y,z){return [(x-y)*1.18,(x+y)*.51-z];}
  // Construction grid and registration marks under the exploded view.
  for(let i=-384;i<=384;i+=16){line(p(i,-384,-84),p(i,384,-84),'#244638',.65);line(p(-384,i,-84),p(384,i,-84),'#244638',.65);}
  ctx.setLineDash([3,5]);
  for(const [x,y] of [[-78,-64],[78,-64],[78,64],[-78,64]]) line(p(x,y,-62),p(x,y,62),'#80a88b',.9);
  ctx.setLineDash([]);
  const specs=[{z:-52,base:'#254d3e',wall:'#183b30',edge:'#79ad91'},{z:-6,base:'#396647',wall:'#284e3b',edge:'#b1cc89'},{z:42,base:'#d0eb91',wall:'#86a65c',edge:'#e5ffad'}];
  const bevel=[[-72,-62],[71,-62],[78,-55],[78,53],[70,61],[-71,61],[-79,53],[-79,-55]];
  const board=(z)=>bevel.map(([x,y])=>p(x,y,z));
  specs.forEach(({z,base,wall,edge},k)=>{
    const a=board(z),b=board(z-7);
    for(let i=2;i<=6;i++){const n=(i+1)%8;poly([a[i],a[n],b[n],b[i]],wall,edge,.6);}
    poly(a,base,edge,k===selected?2.1:1.2);
    const ink=k===2?'#557443':'#a7c9a3';
    const trace=(ps,col=ink,width=1.2)=>ps.forEach(([x,y],i)=>{if(i)line(p(...ps[i-1],z+.4),p(x,y,z+.4),col,width);});
    for(const [x,y] of [[-69,-51],[67,-51],[-67,49],[65,49]]){const [a,b]=p(x,y,z+.5);ctx.beginPath();ctx.ellipse(a,b,3.2,1.6,0,0,Math.PI*2);ctx.fillStyle=k===2?'#547340':'#8db99b';ctx.fill();}
    if(k===2){
      for(let row=0;row<7;row++){const y=-35+row*11;trace([[-45,y],[-29+(row%3)*6,y]],ink,2.8);trace([[-18,y],[18+(row*11%34),y]],'#779651',2.2);}
      trace([[-57,-38],[-57,36],[-47,36]],ink,1);
    } else {
      for(let n=0;n<11;n++){const x=-64+n*12,shift=(n%3)*6;
        trace([[x,52],[x,38-shift],[x+7,30-shift],[x+7,12-shift]],ink,1);
        trace([[x,-52],[x,-39+shift],[x-4,-34+shift],[x-4,-22+shift]],ink,.9);}
      poly([p(-22,-16,z+1),p(22,-16,z+1),p(22,16,z+1),p(-22,16,z+1)],wall,edge,1);
    }
    const mid=p(77,-47,z);const end=[194,mid[1]-12];line(mid,[mid[0]+19,mid[1]],edge,.8);line([mid[0]+19,mid[1]],end,edge,.8);
    ctx.fillStyle=k===selected?'#edffc3':'#bdd3c1';ctx.font='10px ui-monospace, monospace';ctx.textAlign='left';ctx.fillText(['SRC','RULE','OUT'][k],end[0]+4,end[1]+3);
  });
}
document.querySelectorAll('[data-layer]').forEach(b=>b.addEventListener('click',()=>{selected=Number(b.dataset.layer);selectGroup('layer',String(selected));$('#layer-text').textContent=descriptions[selected];drawLayers();}));
$('#layer-text').textContent=descriptions[2];
new ResizeObserver(drawLayers).observe(canvas);
