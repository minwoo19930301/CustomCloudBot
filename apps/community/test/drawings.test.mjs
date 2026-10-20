import test from 'node:test';
import assert from 'node:assert/strict';
import {DRAWING_TOOLS,DRAWING_PROMPT,renderDrawing} from '../drawings.mjs';

const rect={type:'rect',x:10,y:20,width:120,height:80};
const drawing=overrides=>({title:'예시 그림',width:800,height:600,shapes:[{...rect}],...overrides});
const invalid=value=>assert.throws(()=>renderDrawing(value),error=>error.status===400&&error.code==='DRAWING_INVALID');

test('tool advertises SVG illustration and diagram creation with bounded structured arguments',()=>{
  assert.equal(DRAWING_TOOLS.length,1);
  const tool=DRAWING_TOOLS[0].function;
  assert.equal(tool.name,'create_drawing');
  assert.equal(tool.parameters.additionalProperties,false);
  assert.equal(tool.parameters.properties.shapes.items.additionalProperties,false);
  assert.deepEqual(tool.parameters.required,['title','width','height','shapes']);
  assert.equal(tool.parameters.properties.width.maximum,1600);
  assert.equal(tool.parameters.properties.shapes.maxItems,100);
  assert.match(tool.description,/SVG illustration or diagram/);
  assert.match(DRAWING_PROMPT,/SVG 삽화·도표/);
  assert.match(DRAWING_PROMPT,/실사 이미지 생성 모델이나 PNG 생성 API가 아닙니다/);
});

test('renders the seven supported shapes as one self-contained SVG',()=>{
  const result=renderDrawing(drawing({title:'  구성도  ',background:'#FaF8Ff',shapes:[
    {...rect,rx:8,ry:8,fill:'lavender',stroke:'#456',strokeWidth:1.5,opacity:.8},
    {type:'circle',cx:200,cy:100,r:30,fill:'#ff0077'},
    {type:'ellipse',cx:300,cy:100,rx:45,ry:20},
    {type:'line',x1:140,y1:60,x2:170,y2:60},
    {type:'path',d:'M 10 150 C 30 110 50 110 70 150 Z',fill:'none',stroke:'blue'},
    {type:'text',x:400,y:100,text:'설계 → 실행',fontSize:32,fontWeight:'bold',textAnchor:'middle'},
    {type:'polygon',points:[[450,120],[480,170],[420,170]],fill:'#aa66cc80'},
  ]}));
  assert.deepEqual({width:result.width,height:result.height,title:result.title},{width:800,height:600,title:'구성도'});
  assert.match(result.svg,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="600" viewBox="0 0 800 600" role="img">/);
  for(const type of ['rect','circle','ellipse','line','path','text','polygon']) assert.match(result.svg,new RegExp(`<${type} `));
  assert.match(result.svg,/fill="#faf8ff"/);
  assert.match(result.svg,/stroke-width="1.5" opacity="0.8"/);
  assert.match(result.svg,/font-family="system-ui, sans-serif" font-size="32" font-weight="bold" text-anchor="middle"/);
  assert.match(result.svg,/points="450,120 480,170 420,170"/);
  assert.ok(result.svg.endsWith('</svg>'));
});

test('transparent backgrounds omit the background rectangle and lines remain visible by default',()=>{
  const result=renderDrawing(drawing({background:'none',shapes:[{type:'line',x1:0,y1:0,x2:800,y2:600}]}));
  assert.doesNotMatch(result.svg,/<rect/);
  assert.match(result.svg,/<line fill="none" stroke="#202533" stroke-width="2"/);
  assert.match(renderDrawing(drawing()).svg,/<rect width="800" height="600" fill="white"\/>/);
});

test('title and text escape SVG markup, entities and attribute delimiters instead of creating active content',()=>{
  const attack='</text><script>alert("x")</script><image href="https://evil.test" onload=\'x\'/> & &#x3c;';
  const result=renderDrawing(drawing({title:'</title><script>x</script>',shapes:[{type:'text',x:0,y:40,text:attack}]}));
  assert.doesNotMatch(result.svg,/<script|<image|<foreignObject|<use|<a\s/);
  assert.match(result.svg,/&lt;\/text&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(result.svg,/&amp; &amp;#x3c;/);
  assert.match(result.svg,/&apos;x&apos;/);
  assert.match(result.svg,/<title>&lt;\/title&gt;&lt;script&gt;x&lt;\/script&gt;<\/title>/);
  const literal=renderDrawing(drawing({shapes:[{type:'text',x:0,y:40,text:'https://example.com is plain text'}]}));
  assert.match(literal.svg,/>https:\/\/example\.com is plain text<\/text>/);
  assert.doesNotMatch(literal.svg,/href=/);
});

test('raw markup, external resources, event handlers and extra shape properties are rejected',()=>{
  for(const key of ['svg','rawSVG','html','href','url','script','style','fontFamily']) invalid(drawing({[key]:'https://evil.test'}));
  for(const key of ['onclick','onload','href','xlink:href','url','src','style','fontFamily','filter','transform','rawSVG']) invalid(drawing({shapes:[{...rect,[key]:'https://evil.test'}]}));
  for(const type of ['image','use','foreignObject','script','animate','iframe','style','svg']) invalid(drawing({shapes:[{type}]}));
  invalid(drawing({shapes:[{...rect,text:'rect cannot carry text'}]}));
  invalid(drawing({shapes:[JSON.parse('{"type":"rect","x":0,"y":0,"width":2,"height":2,"__proto__":{"onload":"x"}}')]}));
  invalid(Object.assign(Object.create({unexpected:true}),drawing()));
});

test('paint values cannot reference URLs, styles, variables or arbitrary SVG identifiers',()=>{
  for(const value of ['url(https://evil.test/x.svg)','url(#external)','javascript:alert(1)','red;fill:url(x)','var(--paint)','currentColor','#12','#12345','#gggggg','" onload="x','rgb(0,0,0)','data:image/svg+xml,x']) {
    invalid(drawing({background:value}));
    invalid(drawing({shapes:[{...rect,fill:value}]}));
    invalid(drawing({shapes:[{...rect,stroke:value}]}));
  }
  for(const value of ['#123','#1234','#12abcd','#12abcdff','white','none']) assert.doesNotThrow(()=>renderDrawing(drawing({background:value})));
});

test('numeric ranges reject coercion, nonfinite values and oversized rendering parameters',()=>{
  for(const value of [0,-1,1601,1.5,'800',null,NaN,Infinity]) {
    invalid(drawing({width:value}));invalid(drawing({height:value}));
  }
  for(const value of [1601,-1601,'10',null,NaN,Infinity]) invalid(drawing({shapes:[{...rect,x:value}]}));
  for(const value of [-1,1601,Infinity]) invalid(drawing({shapes:[{type:'circle',cx:20,cy:20,r:value}]}));
  for(const value of [-1,33,'1']) invalid(drawing({shapes:[{...rect,strokeWidth:value}]}));
  for(const value of [-.1,1.1,'1']) invalid(drawing({shapes:[{...rect,opacity:value}]}));
  for(const value of [7,161,Infinity]) invalid(drawing({shapes:[{type:'text',x:0,y:20,text:'x',fontSize:value}]}));
  for(const options of [{fontWeight:'900'},{textAnchor:'left'}]) invalid(drawing({shapes:[{type:'text',x:0,y:20,text:'x',...options}]}));
  assert.doesNotThrow(()=>renderDrawing(drawing({width:1600,height:1600,shapes:[{...rect,x:-1600,y:1600,opacity:0}]})));
});

test('paths accept bounded commands, compact decimals and valid arcs',()=>{
  const paths=['M10-10l.5 .5 h20 v30 q10 20 30 40 t10 10 c1 2 3 4 5 6 s1 2 3 4z','M0 0A20 30 45 0 1 100 200L300,400Z','m 0 0 20 20 40 40'];
  for(const d of paths) assert.match(renderDrawing(drawing({shapes:[{type:'path',d}]})).svg,/<path /);
});

test('paths reject markup, unsupported alphabets, invalid arities and dangerous numeric forms',()=>{
  const paths=['','L0 0','M0','M0 0 L2','M0 0 Z2','M0 0 A1 2 3 4 0 5 6','M0 0 A-1 2 3 0 0 5 6','M0 0L1601 0','M0 0L1e999 0','M0 0LNaN 0','M0 0\" onload=\"x','M0 0<image href="x"/>','M0 0url(https://x)','M0 0\u0000','M0 0 R10 20'];
  for(const d of paths) invalid(drawing({shapes:[{type:'path',d}]}));
  invalid(drawing({shapes:[{type:'path',d:'M0 0 '+('L1 1 '.repeat(700))}]}));
  invalid(drawing({shapes:[{type:'path',d:'M0 0 '+('1 '.repeat(1100))}]}));
});

test('polygons require bounded coordinate pairs and cannot carry markup',()=>{
  for(const points of ['0,0 10,10 20,0',[],[[0,0],[1,1]],[[0,0],[1,1],[2,2,2]],[[0,0],[1,1],[Infinity,2]],[[0,0],[1,1],[1601,2]],Array.from({length:101},()=>[0,0])]) invalid(drawing({shapes:[{type:'polygon',points}]}));
});

test('shape, text and title limits are enforced independently of final byte size',()=>{
  for(const shapes of [null,{},[],Array.from({length:101},()=>({...rect}))]) invalid(drawing({shapes}));
  assert.doesNotThrow(()=>renderDrawing(drawing({shapes:Array.from({length:100},()=>({...rect}))})));
  for(const title of [undefined,null,'','   ','a'.repeat(161)]) invalid(drawing({title}));
  invalid(drawing({shapes:[{type:'text',x:0,y:20,text:'a'.repeat(2001)}]}));
  for(const value of ['\u0000','\u000b','\uffff','\ud800']) {
    invalid(drawing({title:value}));invalid(drawing({shapes:[{type:'text',x:0,y:20,text:value}]}));
  }
  assert.match(renderDrawing(drawing({shapes:[{type:'text',x:0,y:20,text:'한글 🙂 & < >'}]})).svg,/한글 🙂 &amp; &lt; &gt;/);
});

test('the output byte limit counts UTF-8 and XML escaping expansion, not input character count',()=>{
  const texts=(count,value)=>Array.from({length:count},()=>({type:'text',x:10,y:20,text:value}));
  for(const shapes of [texts(30,'한'.repeat(2000)),texts(100,'&'.repeat(300))]) {
    assert.throws(()=>renderDrawing(drawing({shapes})),error=>error.status===400&&error.code==='DRAWING_TOO_LARGE');
  }
  const result=renderDrawing(drawing({shapes:texts(20,'한'.repeat(1000))}));
  assert.ok(Buffer.byteLength(result.svg,'utf8')<128*1024);
});

test('rendering is deterministic and does not mutate supplied shapes or points',()=>{
  const input=Object.freeze(drawing({shapes:Object.freeze([Object.freeze({type:'polygon',points:Object.freeze([Object.freeze([0,0]),Object.freeze([20,0]),Object.freeze([10,20])])})])}));
  assert.deepEqual(renderDrawing(input),renderDrawing(input));
  assert.deepEqual(input.shapes[0].points,[[0,0],[20,0],[10,20]]);
  assert.doesNotThrow(()=>renderDrawing(Object.assign(Object.create(null),drawing())));
});
