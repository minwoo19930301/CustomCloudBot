import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutBranches, relatedBranchIds, branchGraphGeometry, branchDisplayName, branchFocus, branchEdgeKey} from '../public/branch-graph.mjs';
const rooms = ['root','a','b','deep','merge','other'].map((id, i) => ({id, name:id, createdAt:i+1}));
const links = [{id:'a',parent:'root'},{id:'b',parent:'root'},{id:'deep',parent:'a'},{id:'merge',parent:'deep',mergedFrom:'b'}];
test('pinning moves sessions above manual order without rewriting lineage and unpinning restores order', () => {
  const order=['other','root','a','deep','b','merge'];
  const baseline=layoutBranches(rooms,links,{order});
  const pinned=rooms.map(room=>({...room,pinned:room.id==='merge'||room.id==='deep'}));
  const result=layoutBranches(pinned,links,{order});
  assert.deepEqual(result.rows.map(row=>row.id),['deep','merge','other','root','a','b']);
  assert.deepEqual(result.edges,baseline.edges);
  assert.deepEqual(result.rows.map(row=>row.index),[0,1,2,3,4,5]);
  assert.deepEqual(result.rows.find(row=>row.id==='merge').parents,['deep','b']);
  assert.deepEqual(layoutBranches(pinned.map(room=>({...room,pinned:false})),links,{order}).rows.map(row=>row.id),order);
  assert.equal(layoutBranches(pinned,links,{query:'no match'}).rows.length,0);
});
test('parents precede children and a merge retains both real parents and colored lanes', () => {
  const result=layoutBranches(rooms,links), byId=new Map(result.rows.map(row=>[row.id,row]));
  assert.equal(result.edges.length,5); assert(result.laneCount>1);
  for(const edge of result.edges)assert(byId.get(edge.from).index<byId.get(edge.to).index);
  assert.deepEqual(byId.get('merge').parents,['deep','b']);assert.equal(result.edges.filter(edge=>edge.secondary).length,1);
  assert.equal(byId.get('other').operation,'root');
});
test('three forks stay siblings below the original instead of inheriting its continuation lane', () => {
  const r = ['1','2','3','4'].map((id,index) => ({id,name:id,createdAt:index+1}));
  const l = ['2','3','4'].map(id => ({id,parent:'1',operation:'fork'}));
  const result = layoutBranches(r,l), byId = new Map(result.rows.map(row => [row.id,row]));
  assert.deepEqual(result.rows.map(row => row.id),['1','2','3','4']);
  assert.equal(byId.get('1').lane,0);
  assert.equal(byId.get('1').primaryParent,null);
  assert.deepEqual(byId.get('1').children,['2','3','4']);
  for (const id of ['2','3','4']) {
    assert.deepEqual(byId.get(id).parents,['1']);
    assert.equal(byId.get(id).primaryParent,'1');
    assert.equal(byId.get(id).lane,1);
    assert.equal(byId.get(id).depth,1);
  }
  assert.deepEqual(result.edges,l.map(link => ({from:'1',to:link.id,secondary:false})));
  const geometry = branchGraphGeometry(result), positions = new Map(geometry.nodes.map(node => [node.id,node]));
  assert.deepEqual(geometry.paths.map(path => path.d),[
    'M10,22V44C10,66 22,44 22,66',
    'M10,22V88C10,110 22,88 22,110',
    'M10,22V132C10,154 22,132 22,154'
  ]);
  for (const id of ['2','3','4']) assert.equal(positions.get(id).x,22);
});
test('nested forks have stable generation depths through search, manual placement and merges', () => {
  const r = ['root','a','b','a1','a2','merge'].map((id,index) => ({id,name:id,createdAt:index+1}));
  const l = [{id:'a',parent:'root'},{id:'b',parent:'root'},{id:'a1',parent:'a'},{id:'a2',parent:'a'},{id:'merge',parent:'a2',mergedFrom:'b'}];
  const result = layoutBranches(r,l), byId = new Map(result.rows.map(row => [row.id,row]));
  assert.deepEqual(result.rows.map(row => [row.id,row.depth]),[['root',0],['a',1],['a1',2],['a2',2],['b',1],['merge',3]]);
  assert.deepEqual(byId.get('merge').parents,['a2','b']);
  for (const filtered of [layoutBranches(r,l,{query:'a2'}),layoutBranches(r,l,{order:['a2','merge','root','a','b','a1']})]) {
    for (const row of filtered.rows) assert.equal(row.depth,byId.get(row.id).depth);
  }
  const searched = layoutBranches(r,l,{query:'a2'});
  assert.deepEqual(searched.edges,[{from:'root',to:'a',secondary:false},{from:'a',to:'a2',secondary:false}]);
});
test('flow focus follows ancestors and descendants without selecting siblings or merge co-parents', () => {
  const graph = layoutBranches(rooms,links), focused = branchFocus(graph,'a');
  assert.deepEqual(focused.roomIds,new Set(['a','root','deep','merge']));
  assert.deepEqual(focused.edgeKeys,new Set([
    branchEdgeKey('root','a'),branchEdgeKey('a','deep'),branchEdgeKey('deep','merge')
  ]));
  assert.ok(!focused.roomIds.has('b'));
  assert.ok(!focused.roomIds.has('other'));
  const merge = branchFocus(graph,'merge');
  assert.deepEqual(merge.roomIds,new Set(['merge','deep','b','a','root']));
  assert.deepEqual(merge.edgeKeys,new Set(graph.edges.map(edge => branchEdgeKey(edge.from,edge.to))));
});
test('flow focus does not highlight shortcut edges that bypass the selected session', () => {
  const graph = layoutBranches([{id:'root'},{id:'a'},{id:'merge'}],[{id:'a',parent:'root'},{id:'merge',parent:'a',mergedFrom:'root'}]);
  const focused = branchFocus(graph,'a');
  assert.deepEqual(focused.roomIds,new Set(['root','a','merge']));
  assert.deepEqual(focused.edgeKeys,new Set([branchEdgeKey('root','a'),branchEdgeKey('a','merge')]));
  assert.ok(!focused.edgeKeys.has(branchEdgeKey('root','merge')));
});
test('focus survives display order and search while respecting hidden or missing endpoints', () => {
  const baseline = branchFocus(layoutBranches(rooms,links),'deep');
  assert.deepEqual(branchFocus(layoutBranches(rooms,links,{order:['merge','b','deep','root','a','other']}),'deep'),baseline);
  const searched = branchFocus(layoutBranches(rooms,links,{query:'deep'}),'deep');
  assert.deepEqual(searched.roomIds,new Set(['deep','a','root']));
  assert.ok(!searched.edgeKeys.has(branchEdgeKey('deep','merge')));
  const archived = layoutBranches(rooms.map(room => ({...room,archived:room.id==='root'})),links);
  assert.ok(!branchFocus(archived,'a').roomIds.has('root'));
  assert.equal(branchFocus(archived,'root'),null);
  assert.equal(branchFocus(layoutBranches(rooms,links),null),null);
  assert.equal(branchFocus(layoutBranches(rooms,links),'missing'),null);
  assert.equal(branchFocus({},'missing'),null);
});
test('focus is bounded for malformed cycles, ignores missing nodes and never mutates graph input', () => {
  const graph = Object.freeze({
    rows:Object.freeze(['a','b','c'].map(id => Object.freeze({id}))),
    edges:Object.freeze([{from:'a',to:'b'},{from:'b',to:'a'},{from:'b',to:'c'},{from:'secret',to:'b'}].map(Object.freeze))
  });
  const result = branchFocus(graph,'b');
  assert.deepEqual(result.roomIds,new Set(['a','b','c']));
  assert.equal(result.edgeKeys.size,3);
  assert.ok(!result.edgeKeys.has(branchEdgeKey('secret','b')));
  assert.deepEqual(branchFocus(graph,'b'),result);
  assert.notEqual(branchEdgeKey('a:b','c'),branchEdgeKey('a','b:c'));
});
test('search preserves ancestors of both merge parents and marks only actual matches', () => {
  const result=layoutBranches(rooms,links,{query:'MERGE'});
  assert.deepEqual(new Set(result.rows.map(row=>row.id)),new Set(['root','a','b','deep','merge']));
  assert.deepEqual(result.rows.filter(row=>row.matched).map(row=>row.id),['merge']);
  assert.equal(layoutBranches(rooms,links,{query:'unmatched'}).rows.length,0);
});
test('archived and inaccessible parents never create ghost nodes or invented lineage', () => {
  const result=layoutBranches([{id:'a',name:'a',archived:true},{id:'b',name:'b'},{id:'c',name:'c'}],[{id:'b',parent:'a'},{id:'c',parent:'secret',parents:['b']}]);
  assert.deepEqual(result.rows.map(row=>row.id),['b','c']);assert.deepEqual(result.edges,[{from:'b',to:'c',secondary:false}]);
});
test('cycles and duplicate or self links are bounded and deterministic', () => {
  const r=[{id:'a'},{id:'b'},{id:'c'}], l=[{id:'a',parent:'b'},{id:'b',parent:'a',parents:['a','b']},{id:'c',parent:'b',mergedFrom:'b'}];
  const result=layoutBranches(r,l);assert.equal(result.rows.length,3);assert.equal(result.edges.length,2);assert.deepEqual(layoutBranches(r,l),result);
  assert.deepEqual(new Set(relatedBranchIds('a',r,l)),new Set(['b','c']));
});
test('deep related candidates traverse merge parents and archived ancestors, using IDs not names', () => {
  const r=rooms.map(room=>({...room,name:'same',archived:room.id==='root'}));
  assert.deepEqual(new Set(relatedBranchIds('deep',r,links)),new Set(['a','b','merge']));
  assert.deepEqual(relatedBranchIds('missing',r,links),[]);
  assert.deepEqual(relatedBranchIds('other',r,links),[]);
});
test('a merge keeps its operation label with one accessible parent, but no-parent nodes are roots', () => {
  const result=layoutBranches([{id:'a'},{id:'b'},{id:'c'}],[{id:'b',parent:null,mergedFrom:'a',parents:['a'],operation:'merge'},{id:'c',parent:null,parents:[],operation:'fork'}]);
  assert.equal(result.rows.find(row=>row.id==='b').operation,'merge');assert.equal(result.rows.find(row=>row.id==='c').operation,'root');
  assert.equal(result.edges.length,1);
});
test('manual placement allows children above parents without changing lineage, merge labels or lanes', () => {
  const baseline=layoutBranches(rooms,links), order=['merge','deep','b','a','root','other'];
  const result=layoutBranches(rooms,links,{order}), byId=new Map(result.rows.map(row=>[row.id,row]));
  assert.deepEqual(result.rows.map(row=>row.id),order);
  assert.deepEqual(result.rows.map(row=>row.index),[0,1,2,3,4,5]);
  assert.deepEqual(result.edges,baseline.edges);
  assert.equal(result.laneCount,baseline.laneCount);
  for(const row of baseline.rows)assert.deepEqual(byId.get(row.id),{...row,index:order.indexOf(row.id)});
  assert(byId.get('merge').index<byId.get('deep').index);
  assert.deepEqual(byId.get('merge').parents,['deep','b']);
  assert.equal(byId.get('merge').operation,'merge');
  assert.deepEqual(layoutBranches(rooms,links),baseline);
});
test('partial manual order ignores duplicates and missing IDs and appends unlisted rows in default order', () => {
  const updated=[...rooms,{id:'new',name:'new',createdAt:20}], baseline=layoutBranches(updated,links);
  const order=['deep','missing','deep','a'], result=layoutBranches(updated,links,{order});
  assert.deepEqual(result.rows.map(row=>row.id),['deep','a',...baseline.rows.filter(row=>!['deep','a'].includes(row.id)).map(row=>row.id)]);
  assert.deepEqual(result.rows.map(row=>row.index),result.rows.map((_,index)=>index));
  assert.deepEqual(result.edges,baseline.edges);
  assert.deepEqual(layoutBranches(updated,links,{order}),result);
  assert.deepEqual(order,['deep','missing','deep','a']);
  assert.deepEqual(layoutBranches(updated,links,{order:null}),baseline);
});
test('manual order preserves search ancestors even when they follow the matching child', () => {
  const result=layoutBranches(rooms,links,{query:'merge',order:['other','merge','deep','b','a','root']});
  assert.deepEqual(result.rows.map(row=>row.id),['merge','deep','b','a','root']);
  assert.deepEqual(result.rows.filter(row=>row.matched).map(row=>row.id),['merge']);
  assert.deepEqual(result.edges,layoutBranches(rooms,links,{query:'merge'}).edges);
});


test('default graph keeps connected work together instead of stretching a merge across unrelated roots', () => {
  const r = [{id:'root',createdAt:1},{id:'other',createdAt:2},{id:'a',createdAt:3},{id:'b',createdAt:4},{id:'deep',createdAt:5},{id:'merge',createdAt:6}];
  const result = layoutBranches(r, links);
  assert.deepEqual(result.rows.map(row => row.id), ['root','a','deep','b','merge','other']);
  assert.deepEqual(result.rows.map(row => row.depth), [0,1,2,1,3,0]);
  assert.deepEqual(layoutBranches(r, links, {order:['root','other','a','b','deep','merge']}).rows.map(row => row.id), ['root','other','a','b','deep','merge']);
});

test('graph geometry routes long links around intervening session nodes in either order', () => {
  const rows = ['root','unrelated','merge'].map((id,index)=>({id,lane:0,index}));
  const edge = {from:'root',to:'merge',secondary:true};
  const result = branchGraphGeometry({rows,edges:[edge],laneCount:1});
  assert.equal(result.nodes.length,3);
  assert.equal(result.paths.length,1);
  assert.equal(result.height,132);
  assert.ok(result.width >= 32);
  assert.match(result.paths[0].d, /^M10,22C/);
  assert.ok(result.paths[0].d.endsWith('10,110'));
  assert.ok(!result.paths[0].d.includes('V110'), 'do not draw directly through the middle node');
  const reverse = branchGraphGeometry({rows:[...rows].reverse().map((row,index)=>({...row,index})),edges:[edge],laneCount:1});
  assert.match(reverse.paths[0].d, /^M10,110C/);
  assert.ok(reverse.paths[0].d.endsWith('10,22'));
  assert.deepEqual(result.paths[0].from,edge.from);
  assert.deepEqual(result.paths[0].to,edge.to);
  assert.equal(result.paths[0].secondary,true);
});

test('graph geometry keeps adjacent links direct and ignores missing endpoints', () => {
  const rows = [{id:'a',lane:0,index:0},{id:'b',lane:0,index:1}];
  const result = branchGraphGeometry({rows,edges:[{from:'a',to:'b'},{from:'hidden',to:'b'}],laneCount:1});
  assert.equal(result.paths.length,1);
  assert.equal(result.paths[0].d,'M10,22V66');
  assert.equal(result.width,30);
  assert.deepEqual(branchGraphGeometry({rows:[],edges:[],laneCount:0}),{nodes:[],paths:[],width:30,height:0});
});


test('many simultaneous branches and merge routes fit the sidebar without changing vertical geometry', () => {
  const rows = Array.from({length:48},(_,index)=>({id:'branch-'+index,lane:index%12,index}));
  const edges = Array.from({length:12},(_,index)=>({from:'branch-'+index,to:'branch-'+(index+36),secondary:true}));
  const graph = {rows,edges,laneCount:12};
  const wide = branchGraphGeometry(graph,{maxWidth:1000}), compact = branchGraphGeometry(graph);
  assert.ok(wide.width > 72);
  assert.equal(compact.width,72);
  assert.equal(branchGraphGeometry(graph,{maxWidth:52}).width,52);
  assert.deepEqual(compact.nodes.map(node=>node.y),wide.nodes.map(node=>node.y));
  assert.deepEqual(compact.paths.map(path=>[path.from,path.to,path.secondary]),wide.paths.map(path=>[path.from,path.to,path.secondary]));
  for (const node of compact.nodes) assert.ok(node.x >= 10 && node.x <= 60);
  const byId = new Map(compact.nodes.map(node=>[node.id,node]));
  for (const path of compact.paths) {
    const from = byId.get(path.from), to = byId.get(path.to);
    assert.ok(path.d.startsWith(`M${from.x},${from.y}`));
    assert.ok(path.d.endsWith(`${to.x},${to.y}`) || path.d.endsWith(`V${to.y}`));
    for (const [,x] of path.d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) assert.ok(Number(x) >= 10 && Number(x) <= 60);
  }
  assert.deepEqual(graph.rows,rows);
});

test('display names remove generated trailing lineage only for recorded fork or merge rows', () => {
  const named = (name,operation)=>({room:{name},operation});
  assert.equal(branchDisplayName(named('신규 대화 시작 · Fork · Fork · Merge','merge')),'신규 대화 시작');
  assert.equal(branchDisplayName(named('새 대화 · Fork','fork')),'새 대화');
  assert.equal(branchDisplayName(named('새 대화 · Merge','merge')),'새 대화');
  assert.equal(branchDisplayName(named('Git · Fork','root')),'Git · Fork');
  assert.equal(branchDisplayName(named('Merge 설계 · 최종','merge')),'Merge 설계 · 최종');
  assert.equal(branchDisplayName(named('사용자가 정한 Fork 계획','fork')),'사용자가 정한 Fork 계획');
  assert.equal(branchDisplayName(named(' · Fork','fork')),' · Fork');
  const row = Object.freeze({room:Object.freeze({name:'작업 · Fork · Merge'}),operation:'merge'});
  assert.equal(branchDisplayName(row),'작업');
  assert.equal(row.room.name,'작업 · Fork · Merge');
});
