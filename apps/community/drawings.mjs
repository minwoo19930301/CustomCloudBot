const MAX_DIMENSION = 1600;
const MAX_SHAPES = 100;
const MAX_BYTES = 128 * 1024;
const PALETTE = ['none','black','white','gray','silver','red','orange','yellow','green','teal','blue','navy','purple','pink','lavender'];
const TYPES = ['rect','circle','ellipse','line','path','text','polygon'];
const coordinate = {type:'number',minimum:-MAX_DIMENSION,maximum:MAX_DIMENSION};
const size = {type:'number',minimum:0,maximum:MAX_DIMENSION};
const paint = {type:'string',maxLength:20,description:'Hex #RGB, #RGBA, #RRGGBB, #RRGGBBAA or '+PALETTE.join(', ')};
const shapeProperties = {
  type:{type:'string',enum:TYPES}, fill:paint, stroke:paint,
  strokeWidth:{type:'number',minimum:0,maximum:32}, opacity:{type:'number',minimum:0,maximum:1},
  x:coordinate,y:coordinate,width:size,height:size,cx:coordinate,cy:coordinate,r:size,rx:size,ry:size,
  x1:coordinate,y1:coordinate,x2:coordinate,y2:coordinate,
  d:{type:'string',maxLength:4096,description:'SVG path commands and bounded decimal numbers only. Start with M or m; no markup.'},
  points:{type:'array',minItems:3,maxItems:100,items:{type:'array',minItems:2,maxItems:2,items:coordinate}},
  text:{type:'string',maxLength:2000},fontSize:{type:'number',minimum:8,maximum:160},
  fontWeight:{type:'string',enum:['normal','bold']},textAnchor:{type:'string',enum:['start','middle','end']},
};

export const DRAWING_TOOLS = [{type:'function',function:{
  name:'create_drawing',
  description:'Create an SVG illustration or diagram from simple shapes and text, returned as a downloadable drawing. Not a photorealistic image-generation model. rect needs x/y/width/height; circle cx/cy/r; ellipse cx/cy/rx/ry; line x1/y1/x2/y2; path d; text x/y/text; polygon points [[x,y],...].',
  parameters:{type:'object',additionalProperties:false,required:['title','width','height','shapes'],properties:{
    title:{type:'string',minLength:1,maxLength:160},
    width:{type:'integer',minimum:1,maximum:MAX_DIMENSION},height:{type:'integer',minimum:1,maximum:MAX_DIMENSION},
    background:paint,
    shapes:{type:'array',minItems:1,maxItems:MAX_SHAPES,items:{type:'object',additionalProperties:false,required:['type'],properties:shapeProperties}},
  }},
}}];

export const DRAWING_PROMPT = '\ncreate_drawing으로 실제 SVG 삽화·도표를 제작할 수 있습니다. 간단한 그림, 아이콘, 구성도, 흐름도 요청에는 이 도구로 도형과 글자를 배치하세요. 결과를 받은 뒤 생성된 그림을 안내하세요. 이 기능은 실사 이미지 생성 모델이나 PNG 생성 API가 아닙니다. 외부 이미지·폰트, raw SVG/HTML, 스크립트, URL 참조는 사용할 수 없습니다. 이전 대화의 “그림을 만들 수 없다”는 답변보다 현재 제공된 도구의 범위를 기준으로 답하세요.';

const fail = (message,code='DRAWING_INVALID') => Object.assign(new Error(message),{status:400,code});
const own = (object,key) => Object.hasOwn(object,key);
const escapeXml = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));

function object(value,allowed,label) {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw fail(`${label} must be an object`);
  if (Object.keys(value).some(key=>!allowed.includes(key))) throw fail(`${label} contains an unsupported property`);
}
function number(value,min,max,label,{integer=false}={}) {
  if (typeof value!=='number' || !Number.isFinite(value) || value<min || value>max || integer&&!Number.isInteger(value)) throw fail(`${label} is outside the allowed numeric range`);
  // Bounded decimal output avoids exponent notation and unstable tiny values.
  return Number(value.toFixed(3));
}
function text(value,max,label,{nonempty=false}={}) {
  if (typeof value!=='string' || value.length>max || nonempty&&!value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/u.test(value)) throw fail(`${label} contains invalid text or exceeds its length limit`);
  return value;
}
function color(value,label) {
  if (typeof value!=='string' || value.length>20) throw fail(`${label} must be a supported color`);
  const normalized=value.trim().toLowerCase();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(normalized) && !PALETTE.includes(normalized)) throw fail(`${label} must be a supported color`);
  return normalized;
}
function choice(value,allowed,label) {
  if (!allowed.includes(value)) throw fail(`${label} is not supported`);
  return value;
}

function pathData(value) {
  if (typeof value!=='string' || !value.trim() || value.length>4096 || !/^[MmLlHhVvCcSsQqTtAaZz0-9+.,\- \t\r\n]+$/.test(value)) throw fail('Path must contain only SVG commands and decimal coordinates');
  const pattern=/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)/g;
  const tokens=[];let end=0;
  for (const match of value.matchAll(pattern)) {
    if (!/^[, \t\r\n]*$/.test(value.slice(end,match.index))) throw fail('Path contains invalid coordinates');
    const token=match[0];tokens.push(/^[A-Za-z]$/.test(token)?token:number(Number(token),-MAX_DIMENSION,MAX_DIMENSION,'Path coordinate'));
    end=match.index+token.length;
  }
  if (!/^[, \t\r\n]*$/.test(value.slice(end)) || tokens.length>1024 || !['M','m'].includes(tokens[0])) throw fail('Path must start with a move and stay within its complexity limit');
  const counts={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};
  for (let index=0;index<tokens.length;) {
    const command=tokens[index++];
    if (typeof command!=='string') throw fail('Path command is missing');
    const upper=command.toUpperCase(), count=counts[upper], values=[];
    while (typeof tokens[index]==='number') values.push(tokens[index++]);
    if (count===0 ? values.length!==0 : values.length===0 || values.length%count!==0) throw fail('Path command has the wrong number of coordinates');
    if (upper==='A') for (let start=0;start<values.length;start+=7) {
      if (values[start]<0 || values[start+1]<0 || ![0,1].includes(values[start+3]) || ![0,1].includes(values[start+4])) throw fail('Path arc radii and flags are invalid');
    }
  }
  return tokens.join(' ');
}

const shapeFields = {
  rect:['x','y','width','height','rx','ry'], circle:['cx','cy','r'], ellipse:['cx','cy','rx','ry'],
  line:['x1','y1','x2','y2'], path:['d'], text:['x','y','text','fontSize','fontWeight','textAnchor'], polygon:['points'],
};
const required = {
  rect:['x','y','width','height'],circle:['cx','cy','r'],ellipse:['cx','cy','rx','ry'],
  line:['x1','y1','x2','y2'],path:['d'],text:['x','y','text'],polygon:['points'],
};
function renderShape(shape) {
  if (!shape || !own(shape,'type') || !TYPES.includes(shape.type)) throw fail('Shape type is not supported');
  const type=shape.type, fields=shapeFields[type];
  object(shape,['type','fill','stroke','strokeWidth','opacity',...fields],'Shape');
  if (required[type].some(key=>!own(shape,key))) throw fail(`${type} is missing required coordinates or content`);
  const attributes={
    fill:color(shape.fill??(type==='line'?'none':type==='text'?'#202533':'#8b7add'),'Fill'),
    stroke:color(shape.stroke??(type==='line'?'#202533':'none'),'Stroke'),
  };
  if (own(shape,'strokeWidth')) attributes['stroke-width']=number(shape.strokeWidth,0,32,'Stroke width');
  else if (type==='line') attributes['stroke-width']=2;
  if (own(shape,'opacity')) attributes.opacity=number(shape.opacity,0,1,'Opacity');
  for (const field of fields) {
    if (!own(shape,field) || ['text','d','points','fontSize','fontWeight','textAnchor'].includes(field)) continue;
    attributes[field]=number(shape[field],['width','height','r','rx','ry'].includes(field)?0:-MAX_DIMENSION,MAX_DIMENSION,field);
  }
  let body='';
  if (type==='path') attributes.d=pathData(shape.d);
  if (type==='polygon') {
    if (!Array.isArray(shape.points) || shape.points.length<3 || shape.points.length>100) throw fail('Polygon needs between 3 and 100 coordinate pairs');
    attributes.points=shape.points.map(pair=>{
      if (!Array.isArray(pair) || pair.length!==2) throw fail('Polygon points must be coordinate pairs');
      return pair.map(value=>number(value,-MAX_DIMENSION,MAX_DIMENSION,'Polygon coordinate')).join(',');
    }).join(' ');
  }
  if (type==='text') {
    body=escapeXml(text(shape.text,2000,'Shape text'));
    attributes['font-family']='system-ui, sans-serif';
    attributes['font-size']=number(shape.fontSize??24,8,160,'Font size');
    if (own(shape,'fontWeight')) attributes['font-weight']=choice(shape.fontWeight,['normal','bold'],'Font weight');
    if (own(shape,'textAnchor')) attributes['text-anchor']=choice(shape.textAnchor,['start','middle','end'],'Text alignment');
  }
  const attrs=Object.entries(attributes).map(([key,value])=>`${key}="${escapeXml(String(value))}"`).join(' ');
  return type==='text'?`<text ${attrs}>${body}</text>`:`<${type} ${attrs}/>`;
}

/** Build an inert, self-contained SVG from a small set of validated shapes. */
export function renderDrawing(input) {
  object(input,['title','width','height','background','shapes'],'Drawing');
  const title=text(input.title,160,'Drawing title',{nonempty:true}).trim();
  const width=number(input.width,1,MAX_DIMENSION,'Canvas width',{integer:true});
  const height=number(input.height,1,MAX_DIMENSION,'Canvas height',{integer:true});
  const background=color(input.background??'white','Background');
  if (!Array.isArray(input.shapes) || input.shapes.length<1 || input.shapes.length>MAX_SHAPES) throw fail('Drawing needs between 1 and 100 shapes');
  const elements=input.shapes.map(renderShape);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escapeXml(title)}</title>${background==='none'?'':`<rect width="${width}" height="${height}" fill="${background}"/>`}${elements.join('')}</svg>`;
  if (Buffer.byteLength(svg,'utf8')>MAX_BYTES) throw fail('Drawing exceeds the 128 KiB output limit','DRAWING_TOO_LARGE');
  return {svg,width,height,title};
}
